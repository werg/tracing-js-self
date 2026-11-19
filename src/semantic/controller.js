// Semantic claims are evaluated against the committed prefix. This controller
// consumes certified operations, never guest JavaScript or teacher events.
import {isDeepStrictEqual} from 'node:util';
import {validateGraph} from '../training/format.js';
import {prepareHostRequest,hostOperation} from '../host/operations.js';
import {assertAlgorithmFields,assertAlgorithmDataArray,assertAlgorithmValue,stableAlgorithmJSON} from './ir.js';
import {validateAlgorithmInputs,evaluateTerm} from './operations.js';
import {encodeAlgorithmRecord,decodeAlgorithmRecord} from './trace-codec.js';
import {validateAlgorithmProgram,hashAlgorithmData,ALGORITHM_CONTINUATION_VERSION,
  ALGORITHM_CONTEXT_VERSION} from './program.js';

const clone=value=>structuredClone(value);
const eq=isDeepStrictEqual;
function fail(message,category='algorithm-claim'){
  const error=new Error(message);error.category=category;throw error;
}
function references(value,ids=new Set()){
  if(!value||typeof value!=='object')return ids;
  if(value.op==='ref')ids.add(value.id);
  for(const child of Object.values(value))if(child&&typeof child==='object')references(child,ids);
  return ids;
}
function subterms(term,result=[]){
  result.push(term);
  for(const value of Object.values(term)){
    if(Array.isArray(value)){
      for(const child of value)if(child?.op)subterms(child,result);
    }else if(value?.op)subterms(value,result);
  }
  return result;
}

export class AlgorithmController {
  constructor({program,inputGraph,capabilities=[],invocationId='invocation1',sessionId='algorithm1'}={}){
    validateAlgorithmProgram(program);validateGraph(inputGraph);
    if(!Array.isArray(capabilities)||new Set(capabilities).size!==capabilities.length||
      capabilities.some(value=>typeof value!=='string')||
      !/^[a-z][a-z0-9:_-]*$/.test(invocationId)||!/^[a-z][a-z0-9:_-]*$/.test(sessionId))
      fail('Invalid algorithm execution authority','algorithm-authority');
    this.program=clone(program);this.inputGraph=clone(inputGraph);
    this.capabilities=new Set(capabilities);this.invocationId=invocationId;this.sessionId=sessionId;
    this.heap=new Map(inputGraph.objects.map(node=>[node.id,{kind:node.kind,
      ...(node.prototype===null?{prototype:null}:{}),
      properties:new Map(node.properties.map(property=>[property.key,clone(property.value)]))}]));
    this.inputs=validateAlgorithmInputs(program.core,inputGraph.roots,{heap:this.heap});
    if(program.profile==='serial-scalar-effects/1'&&inputGraph.roots.some(value=>value[0]==='bigint'))
      fail('BigInt inputs require the detailed effect profile','unsupported.algorithm-input');
    this.values=new Map();this.symbols=new Map();this.cursor=0;this.pending=null;
    this.completion=null;this.abrupt=null;this.history=[];this.claims=[];this.firstViolation=null;
    this.boundaries=new Map(program.boundaries.map(boundary=>[boundary.id,boundary]));
    this.declaredValues=new Set(program.core.steps.filter(step=>step.id).map(step=>step.id));
  }
  environment(){return {inputs:this.inputs,values:this.values,heap:this.heap};}
  nextStep(){return this.completion?null:this.abrupt?{kind:'throw',value:{op:'literal',value:clone(this.abrupt)}}:
    this.program.core.steps[this.cursor]??null;}
  expand(term,seen=new Set()){
    if(term.op==='ref'&&this.symbols.has(term.id)){
      if(seen.has(term.id))fail('Cyclic selected dependency');
      return this.expand(this.symbols.get(term.id),new Set([...seen,term.id]));
    }
    const result=clone(term);
    for(const [key,value] of Object.entries(result)){
      if(key==='args')result[key]=value.map(child=>this.expand(child,seen));
      else if(value?.op)result[key]=this.expand(value,seen);
    }
    return result;
  }
  recordClaim(record,expected,consistent){
    const claim={index:this.history.length,kind:record.kind,consistent,expected:clone(expected)};
    this.claims.push(claim);
    if(!consistent&&!this.firstViolation)this.firstViolation=clone(claim);
    return claim;
  }
  commit(selected){
    const line=typeof selected==='string'?selected:encodeAlgorithmRecord(selected);
    const record=decodeAlgorithmRecord(line),step=this.nextStep();
    if(record.kind==='observe')fail('Observations cannot be selected by a model','algorithm-authority');
    if(this.completion||!step)fail('Algorithm is already complete');
    if(this.pending||step.kind==='observe')fail('An external observation is required before the next prediction');
    let claim,dispatch=null;
    if(record.kind==='compute'){
      if(this.values.has(record.id)||this.inputs.has(record.id))fail('Duplicate semantic value identity');
      const expectedTerm=step.kind==='compute'?step.term:
        ['return','throw'].includes(step.kind)?step.value:null;
      if(!expectedTerm)fail('Computation cannot cross an effect boundary');
      const expanded=this.expand(record.term),expectedExpanded=this.expand(expectedTerm);
      const canonical=step.kind==='compute'&&record.id===step.id;
      if(canonical?!eq(expanded,expectedExpanded):
        this.declaredValues.has(record.id)||!subterms(expectedExpanded).some(term=>eq(term,expanded)))
        fail('Selected expression is not the certified computation or one of its subterms');
      const expected=evaluateTerm(record.term,this.environment());
      claim=this.recordClaim(record,expected,eq(record.result,expected));
      // Keep false selected values for diagnosis. Never silently repair them.
      this.values.set(record.id,clone(record.result));this.symbols.set(record.id,clone(record.term));
      if(canonical)this.cursor++;
    }else if(record.kind==='request'){
      if(step.kind!=='request'||record.id!==step.id||record.boundary!==step.boundary||
        record.operation!==step.operation)fail('Request is not the next certified effect boundary');
      const boundary=this.boundaries.get(record.boundary);
      if(!boundary||boundary.request!==record.id||boundary.operation!==record.operation||
        boundary.sourceDigest!==this.program.sourceDigest||!this.capabilities.has(record.operation))
        fail('Effect boundary lacks source and capability authorization','algorithm-authority');
      if(this.firstViolation)fail('A false earlier claim cannot authorize an external request','algorithm-authority');
      const args=step.arguments.map(term=>evaluateTerm(term,this.environment()));
      if(!eq(record.arguments,args))fail('Request arguments differ from committed dependencies');
      const spec=hostOperation(record.operation);
      if(spec.callbackIndices.length||record.arguments.some(value=>value[0]==='ref'))
        fail('Effect profile permits scalar arguments without callbacks');
      const transport=prepareHostRequest({},record.operation,record.arguments);
      dispatch={id:record.id,boundary:record.boundary,operation:record.operation,
        arguments:clone(record.arguments),payload:transport.payload,codec:transport.codec,
        payloadDigest:hashAlgorithmData(transport.payload),
        key:this.invocationId+'/'+record.id,status:'requested'};
      claim=this.recordClaim(record,args,true);this.pending=clone(dispatch);this.cursor++;
    }else if(record.kind==='return'||record.kind==='throw'){
      if(step.kind!==record.kind)fail('Incorrect completion kind');
      const expected=evaluateTerm(step.value,this.environment());
      claim=this.recordClaim(record,expected,eq(record.value,expected));
      this.completion={kind:record.kind,value:clone(record.value)};
      this.abrupt=null;this.cursor=this.program.core.steps.length;
    }else fail('Record is outside the certified execution profile');
    this.history.push({mode:'generated',line});
    return {claim:clone(claim),dispatch:clone(dispatch),completion:clone(this.completion)};
  }
  observe(observation){
    const line=typeof observation==='string'?observation:encodeAlgorithmRecord(observation);
    const record=decodeAlgorithmRecord(line),step=this.nextStep();
    if(record.kind!=='observe'||!this.pending||step?.kind!=='observe'||
      record.request!==this.pending.id||record.request!==step.request||record.id!==step.id)
      fail('Observation does not match the pending request','algorithm-authority');
    if(record.status!=='completed')assertAlgorithmValue(record.value,{allowReference:false});
    const value=record.status==='completed'?['undefined']:record.value;
    if(value[0]==='bigint'&&this.program.profile==='serial-scalar-effects/1'){
      this.completion={kind:'unsupported',category:'unsupported.algorithm-observation',
        reason:'BigInt observation requires detailed exceptional execution'};
      this.pending=null;this.cursor++;
      this.history.push({mode:'observed',line});
      return {status:'unsupported',value:clone(value),completion:clone(this.completion)};
    }
    if(record.status==='rejected')this.abrupt=clone(value);
    else this.values.set(step.id,clone(value));
    this.pending=null;this.cursor++;
    this.history.push({mode:'observed',line});
    return {status:record.status,value:clone(value)};
  }
  liveState(){
    const needed=references(this.program.core.steps.slice(this.cursor));
    if(this.abrupt)needed.clear();
    // Alternative decompositions are useful until their enclosing operation
    // commits. Retain their checked dependencies at that prediction boundary.
    const step=this.nextStep();
    if(step?.kind==='compute')for(const [id,term] of this.symbols)
      if(subterms(this.expand(step.term)).some(child=>eq(child,this.expand(term))))needed.add(id);
    // Canonical values already have immutable definitions in the core. Extra
    // decompositions need their actual definitions and any live dependencies.
    let expanded=true;
    while(expanded){
      expanded=false;
      for(const id of [...needed])if(!this.declaredValues.has(id)&&this.symbols.has(id))
        for(const dependency of references(this.symbols.get(id)))if(!needed.has(dependency)){
          needed.add(dependency);expanded=true;
        }
    }
    return {cursor:this.cursor,values:[...this.values].filter(([id])=>needed.has(id)).map(clone),
      symbols:[...this.symbols].filter(([id])=>needed.has(id)&&!this.declaredValues.has(id)).map(clone),
      pending:clone(this.pending),abrupt:clone(this.abrupt),completion:clone(this.completion),
      firstViolation:this.firstViolation?{index:this.firstViolation.index,kind:this.firstViolation.kind}:null};
  }
  context({definitions}={}){
    if(!(definitions instanceof Map))throw new TypeError('An explicit consumer definition cache is required');
    const digest=this.program.definitionDigest,publish=!definitions.has(digest);
    if(!publish&&!eq(definitions.get(digest),this.program))fail('Consumer definition cache mismatch');
    if(publish)definitions.set(digest,clone(this.program));
    const inputDigest=hashAlgorithmData(this.inputGraph),publishInput=!definitions.has(inputDigest);
    if(!publishInput&&!eq(definitions.get(inputDigest),this.inputGraph))fail('Consumer input cache mismatch');
    if(publishInput)definitions.set(inputDigest,clone(this.inputGraph));
    return {schema:ALGORITHM_CONTEXT_VERSION,definition:digest,
      ...(publish?{program:clone(this.program)}:{}),input:inputDigest,
      ...(publishInput?{inputGraph:clone(this.inputGraph)}:{}),
      invocationId:this.invocationId,state:this.liveState(),visibleThrough:this.history.length,
      prefixDigest:hashAlgorithmData(this.history)};
  }
  checkpoint(){
    const body={schema:ALGORITHM_CONTINUATION_VERSION,program:clone(this.program),inputGraph:clone(this.inputGraph),
      capabilities:[...this.capabilities],invocationId:this.invocationId,sessionId:this.sessionId,
      history:clone(this.history),state:this.liveState()};
    return {...body,integrity:hashAlgorithmData(body)};
  }
  static restore(packet){
    assertAlgorithmFields(packet,['schema','program','inputGraph','capabilities','invocationId','sessionId',
      'history','state','integrity'],'algorithm continuation');
    const {integrity,...body}=packet??{};
    if(body.schema!==ALGORITHM_CONTINUATION_VERSION||hashAlgorithmData(body)!==integrity)
      fail('Algorithm continuation version or integrity mismatch');
    const controller=new AlgorithmController(body);
    assertAlgorithmDataArray(body.history,'continuation history');
    for(const row of body.history){
      assertAlgorithmFields(row,['mode','line'],'continuation history row');
      if(row.mode==='generated')controller.commit(row.line);
      else if(row.mode==='observed')controller.observe(row.line);
      else fail('Invalid continuation authority');
    }
    if(stableAlgorithmJSON(controller.liveState())!==stableAlgorithmJSON(body.state))
      fail('Algorithm continuation differs from checked prefix');
    return controller;
  }
}

/** Validate a selected explanation without demanding the canonical teacher's
 * exact bytes. Truthful subterm decompositions are allowed; every stated
 * value is checked and external observations keep a separate authority. */
export function validateAlgorithmTrace({program,inputGraph,capabilities=[],records}={}){
  try{
    if(!Array.isArray(records))throw new TypeError('A role-separated trace is required');
    const controller=new AlgorithmController({program,inputGraph,capabilities});
    for(const row of records){
      if(!row||Object.keys(row).sort().join(',')!=='line,mode')throw new TypeError('Trace record fields');
      if(row.mode==='generated')controller.commit(row.line);
      else if(row.mode==='observed')controller.observe(row.line);
      else throw new TypeError('Trace record authority');
    }
    const complete=controller.completion&&['return','throw'].includes(controller.completion.kind);
    return {valid:Boolean(complete&&!controller.firstViolation),completion:clone(controller.completion),
      firstViolation:clone(controller.firstViolation),state:controller.liveState(),
      ...(complete?{}:{reason:'Trace has not reached a supported completion'})};
  }catch(error){return {valid:false,reason:error.message,category:error.category??'algorithm-claim'};}
}
