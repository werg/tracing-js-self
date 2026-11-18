// Experimental region endpoint. These summaries are NOT semantic-trace/5
// records and cannot be fed into the production selected controller/consumer.
// V8 independently executes the source; no owned transition computes a verdict.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {encode,decode} from '../values.js';
import {validateOwnedGraph,decodeOwnedGraph} from '../host/graph-codec.js';
import {describeGraph} from './graph.js';
import {independentEffectfulReference,verifyEffectfulTrainingCase} from './effectful-admit.js';

const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const ensure=(condition,message)=>{if(!condition)throw new TypeError(message);};
const identifier=(node,name)=>node?.type==='Identifier'&&node.name===name;
const zero=node=>node?.type==='Literal'&&node.value===0;
const span=node=>({start:node.start,end:node.end});
const binary=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=','&','|','^','<<','>>','>>>']);
const unary=new Set(['!','+','-','~','typeof','void']);
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')===[...expected].sort().join(',');
const canonicalScalar=value=>{
  try{return Array.isArray(value)&&!['ref','promise'].includes(value[0])&&
    isDeepStrictEqual(encode(decode(value)),value);}catch{return false;}
};

function pureExpression(node,names,budget={nodes:0,operators:0},decisions=null){
  ensure(++budget.nodes<=32,'Pure helper expression exceeds node bound');
  if(node?.type==='Literal'){
    ensure(!node.regex&&!node.bigint&&(node.value===null||['number','boolean','string'].includes(typeof node.value)),
      'Only primitive pure-helper literals are supported');return;
  }
  if(node?.type==='Identifier'){ensure(names.has(node.name),'Pure helper reads uncommitted state');return;}
  if(node?.type==='UnaryExpression'&&unary.has(node.operator)&&node.prefix){
    ensure(++budget.operators<=8,'Pure helper expression exceeds operator bound');
    pureExpression(node.argument,names,budget,decisions);return;
  }
  if(node?.type==='BinaryExpression'&&binary.has(node.operator)){
    ensure(++budget.operators<=8,'Pure helper expression exceeds operator bound');
    pureExpression(node.left,names,budget,decisions);pureExpression(node.right,names,budget,decisions);return;
  }
  if(decisions&&node?.type==='ConditionalExpression'){
    ensure(++budget.operators<=8,'Pure helper expression exceeds operator bound');
    decisions.push({site:span(node.test),kind:'conditional'});
    for(const child of [node.test,node.consequent,node.alternate])pureExpression(child,names,budget,decisions);
    return;
  }
  if(decisions&&node?.type==='LogicalExpression'&&['&&','||','??'].includes(node.operator)){
    ensure(++budget.operators<=8,'Pure helper expression exceeds operator bound');
    decisions.push({site:span(node),kind:'logical',operator:node.operator});
    pureExpression(node.left,names,budget,decisions);pureExpression(node.right,names,budget,decisions);return;
  }
  throw new TypeError('Pure helper cannot summarize calls, reads, writes, coercion hooks or control effects');
}

function inspectProfile({source,entry,inputGraph,profile,maxIterations=128}){
  ensure(typeof source==='string'&&typeof entry==='string','Exact source and entry are required');
  ensure(Number.isSafeInteger(maxIterations)&&maxIterations>=0&&maxIterations<=1024,'Invalid loop bound');
  validateOwnedGraph(inputGraph,{maxNodes:1,maxProperties:1025});
  const args=decodeOwnedGraph(JSON.stringify(inputGraph),{maxNodes:1,maxProperties:1025});
  const ast=parse(source,{ecmaVersion:2022,sourceType:'script'});
  ensure(ast.body[0]?.directive==='use strict','Summary source must explicitly be strict');
  ensure(ast.body.every(node=>node.type==='FunctionDeclaration'||node.directive==='use strict'),
    'Summary source cannot have top-level initialization or effects');
  const functions=ast.body.filter(node=>node.type==='FunctionDeclaration');
  const matches=functions.filter(node=>node.id.name===entry);
  ensure(matches.length===1&&new Set(functions.map(node=>node.id.name)).size===functions.length,
    'Summary source requires one unambiguous entry function');
  const fn=matches[0];
  ensure(!fn.async&&!fn.generator&&fn.params.every(node=>node.type==='Identifier'),
    'Only ordinary functions with simple scalar/data parameters are supported');
  const params=fn.params.map(node=>node.name);
  ensure(new Set(params).size===params.length&&args.length===params.length,
    'Exact declared parameter inputs are required');
  const body=fn.body.body.filter(node=>node.directive!=='use strict');
  if(['pure-helper/1','pure-control-helper/1'].includes(profile)){
    ensure(inputGraph.objects.length===0&&inputGraph.roots.every(canonicalScalar),
      'Pure helpers accept committed scalar inputs only');
    ensure(body.length===1&&body[0].type==='ReturnStatement'&&body[0].argument,
      'Pure helper body must be one expression return');
    const decisions=profile==='pure-control-helper/1'?[]:null;
    pureExpression(body[0].argument,new Set(params),{nodes:0,operators:0},decisions);
    if(decisions)ensure(decisions.length>0,'Pure control helper requires a conditional or short-circuit expression');
    return {source,entry,inputGraph,args,profile,region:span(fn),loop:null,decisions};
  }
  ensure(profile==='dense-array-sum/1','Unknown experimental summary profile');
  ensure(params.length===1&&inputGraph.objects.length===1&&Array.isArray(args[0]),
    'Dense sum requires exactly one ordinary array input');
  const array=args[0],length=array.length;
  ensure(length<=maxIterations&&Object.keys(array).length===length&&
    Array.from({length},(_,index)=>Object.hasOwn(array,index)&&typeof array[index]==='number'&&Number.isFinite(array[index])).every(Boolean),
    'Dense sum refuses holes, extra properties, nonfinite/non-number values and excessive iterations');
  ensure(body.length===3,'Dense sum requires initialization, one loop and return');
  const [initial,loop,returned]=body;
  ensure(initial.type==='VariableDeclaration'&&initial.kind==='let'&&initial.declarations.length===1&&
    initial.declarations[0].id.type==='Identifier'&&zero(initial.declarations[0].init),
    'Dense sum requires a zero-initialized accumulator');
  const accumulator=initial.declarations[0].id.name;
  ensure(loop.type==='ForStatement'&&loop.init?.type==='VariableDeclaration'&&loop.init.kind==='let'&&
    loop.init.declarations.length===1&&loop.init.declarations[0].id.type==='Identifier'&&zero(loop.init.declarations[0].init),
    'Dense sum requires a zero-initialized counted loop');
  const index=loop.init.declarations[0].id.name;
  ensure(new Set([params[0],accumulator,index]).size===3,'Dense sum cells must be distinct');
  ensure(loop.test?.type==='BinaryExpression'&&loop.test.operator==='<'&&identifier(loop.test.left,index)&&
    loop.test.right.type==='MemberExpression'&&!loop.test.right.computed&&!loop.test.right.optional&&
    identifier(loop.test.right.object,params[0])&&identifier(loop.test.right.property,'length'),
    'Dense sum bound must be the unchanged array length');
  ensure(loop.update?.type==='UpdateExpression'&&loop.update.operator==='++'&&!loop.update.prefix&&
    identifier(loop.update.argument,index),'Dense sum requires a single postfix index increment');
  ensure(loop.body.type==='BlockStatement'&&loop.body.body.length===1&&
    loop.body.body[0].type==='ExpressionStatement','Dense sum cannot omit additional loop statements');
  const assignment=loop.body.body[0].expression;
  ensure(assignment.type==='AssignmentExpression'&&assignment.operator==='+='&&identifier(assignment.left,accumulator)&&
    assignment.right.type==='MemberExpression'&&assignment.right.computed&&!assignment.right.optional&&
    identifier(assignment.right.object,params[0])&&identifier(assignment.right.property,index),
    'Dense sum body must add exactly the current array element');
  ensure(returned.type==='ReturnStatement'&&identifier(returned.argument,accumulator),
    'Dense sum must return the accumulator without later changes');
  return {source,entry,inputGraph,args,profile,region:span(fn),loop:{...span(loop),
    testSite:loop.test.start+':'+loop.test.end,sumSite:assignment.start+':'+assignment.end,
    accumulator,index,length}};
}

export function createSemanticSummaryContext(input){
  const inspected=inspectProfile(input);
  return {schema:'experimental-summary-context/1',profile:inspected.profile,
    source:inspected.source,sourceDigest:digest(inspected.source),entry:inspected.entry,
    region:inspected.region,inputGraph:structuredClone(inspected.inputGraph),
    inputDigest:digest(inspected.inputGraph),maxIterations:input.maxIterations??128,
    ...(inspected.decisions?{decisionSites:inspected.decisions}:{}),
    ...(inspected.loop?{loop:{start:inspected.loop.start,end:inspected.loop.end,
      accumulator:inspected.loop.accumulator}}:{})};
}

// No prediction is filled in here. Rejections never contain corrected targets.
export async function verifySemanticSummary({context,summary,timeoutMs=5000}){
  let inspected;
  try{
    ensure(context?.schema==='experimental-summary-context/1','Invalid summary context');
    inspected=inspectProfile(context);
    ensure(isDeepStrictEqual(createSemanticSummaryContext(context),context),'Summary context identity changed');
    const required=['schema','completion','inputUnchanged'];
    if(inspected.loop)required.push('iterations','stateDelta','checkpoints');
    if(inspected.decisions)required.push('decisions');
    ensure(keys(summary,required)&&summary.schema==='experimental-semantic-summary/1',
      'Summary fields do not match the experimental contract');
    ensure(keys(summary.completion,['kind','value'])&&summary.completion.kind==='return'&&
      canonicalScalar(summary.completion.value),'A predicted scalar return completion is required');
    ensure(summary.inputUnchanged===true,'Summary must explicitly claim unchanged input state');
    if(inspected.decisions){
      ensure(Array.isArray(summary.decisions)&&summary.decisions.length<=inspected.decisions.length,
        'Control summary needs a bounded sequence of executed decisions');
      const seen=new Set();
      for(const decision of summary.decisions){
        ensure(keys(decision,['site','selected'])&&keys(decision.site,['start','end']),
          'Control decisions must state an exact source site and selected branch');
        const definition=inspected.decisions.find(item=>isDeepStrictEqual(item.site,decision.site));
        const identity=JSON.stringify(decision.site);
        ensure(definition&&!seen.has(identity),'Control decision site is unknown or repeated');
        seen.add(identity);
        ensure((definition.kind==='conditional'?['consequent','alternate']:['left','right']).includes(decision.selected),
          'Control decision names a branch outside its source expression');
      }
    }
    if(inspected.loop){
      ensure(Number.isSafeInteger(summary.iterations)&&summary.iterations===inspected.loop.length,
        'Claimed iteration count differs from the bounded input');
      ensure(keys(summary.stateDelta,['binding','before','after'])&&
        summary.stateDelta.binding===inspected.loop.accumulator&&
        isDeepStrictEqual(summary.stateDelta.before,['num',0])&&
        isDeepStrictEqual(summary.stateDelta.after,summary.completion.value),
        'Loop state delta must describe the actual accumulator');
      ensure(Array.isArray(summary.checkpoints)&&summary.checkpoints.length<=summary.iterations+1,
        'Invalid intermediate checkpoint sequence');
      let previous=-1;
      for(const checkpoint of summary.checkpoints){
        ensure(keys(checkpoint,['iteration','total'])&&Number.isSafeInteger(checkpoint.iteration)&&
          checkpoint.iteration>previous&&checkpoint.iteration<=summary.iterations&&canonicalScalar(checkpoint.total),
          'Intermediate checkpoints must be ordered, bounded explicit scalar claims');
        previous=checkpoint.iteration;
      }
    }
  }catch(error){return {status:'rejected',phase:'contract',reason:error.message};}
  try{
    const input={source:inspected.source,entry:inspected.entry,inputGraph:inspected.inputGraph,fixture:{calls:[]}};
    const original=await independentEffectfulReference(input,{timeoutMs});
    const expectedGraph=describeGraph([...inspected.args,decode(summary.completion.value)]);
    ensure(original.outcome.kind==='return'&&isDeepStrictEqual(original.outcome.graph,expectedGraph),
      'Independent source completion or input state disagrees with the claim');
    ensure(original.effects.length===0&&original.callbackFailures.length===0&&original.unhandledRejections.length===0,
      'Summary cannot hide effects, callbacks or rejected work');
    const references={original};
    if(inspected.decisions){
      const branches=await independentEffectfulReference({...input,mode:'branches'},{timeoutMs});
      ensure(isDeepStrictEqual(branches.outcome,original.outcome)&&
        isDeepStrictEqual(branches.effects,original.effects)&&branches.callbackFailures.length===0&&
        branches.unhandledRejections.length===0,'Instrumented reference changed source behavior');
      const expected=branches.decisions.map(row=>{
        const definition=inspected.decisions.find(item=>item.site.start+':'+item.site.end===row.site);
        ensure(definition&&Array.isArray(row.decision)&&row.decision[0]==='bool'&&typeof row.decision[1]==='boolean',
          'Independent control observation lacks a supported source site');
        const selected=definition.kind==='conditional'
          ?(row.decision[1]?'alternate':'consequent'):(row.decision[1]?'left':'right');
        return {site:definition.site,selected};
      });
      ensure(isDeepStrictEqual(summary.decisions,expected),
        'Predicted control decisions differ from independently observed execution order or branch');
      references.branches=branches;
    }
    if(inspected.loop){
      const branches=await independentEffectfulReference({...input,mode:'branches'},{timeoutMs});
      const operations=await independentEffectfulReference({...input,mode:'operations'},{timeoutMs});
      for(const observed of [branches,operations])ensure(isDeepStrictEqual(observed.outcome,original.outcome)&&
        isDeepStrictEqual(observed.effects,original.effects)&&observed.callbackFailures.length===0&&
        observed.unhandledRejections.length===0,'Instrumented reference changed source behavior');
      const decisions=branches.decisions;
      ensure(decisions.length===inspected.loop.length+1&&decisions.every((row,index)=>
        row.site===inspected.loop.testSite&&isDeepStrictEqual(row.decision,['bool',index===inspected.loop.length])),
        'Independent loop control differs from the claimed iteration relation');
      const sums=operations.operations.filter(row=>row.site===inspected.loop.sumSite);
      ensure(sums.length===inspected.loop.length,'Independent accumulator observation coverage is incomplete');
      for(const checkpoint of summary.checkpoints){
        const actual=checkpoint.iteration===0?['num',0]:sums[checkpoint.iteration-1].value;
        ensure(isDeepStrictEqual(actual,checkpoint.total),'An explicit intermediate accumulator claim is false');
      }
      references.branches=branches;references.operations=operations;
    }
    return {status:'verified',schema:'experimental-summary-certificate/1',
      authority:'independent-node-v8-source',contextDigest:digest(context),summaryDigest:digest(summary),
      references,nativeAdmission:false,learningStatus:'untested',
      claimsChecked:{completion:true,inputState:true,iterations:Boolean(inspected.loop),
        controlDecisions:summary.decisions?.length??0,
        intermediateCheckpoints:summary.checkpoints?.length??0}};
  }catch(error){return {status:'rejected',phase:'independent-reference',reason:error.message};}
}

export async function buildSemanticSummaryExperiment({context,summary,family,timeoutMs=5000}){
  ensure(typeof family==='string'&&family.length>0,'An explicit shared source lineage is required');
  const certificate=await verifySemanticSummary({context,summary,timeoutMs});
  if(certificate.status!=='verified')return certificate;
  const args=decodeOwnedGraph(JSON.stringify(context.inputGraph));
  const detailed=await verifyEffectfulTrainingCase({source:context.source,entry:context.entry,args,
    family,fixture:{calls:[]},timeoutMs});
  if(detailed.status!=='locally_verified')return {status:'rejected',phase:'detailed-control',reason:detailed.reason};
  const raw='summary '+JSON.stringify(summary);
  const detailedLines=detailed.exported.public.timeline.filter(row=>row.kind==='semantic').map(row=>row.line);
  return {schema:'semantic-summary-experiment/1',status:'experimental_verified',
    public:{context,raw,summary},
    private:{certificate,detailedEpisode:detailed.exported},
    sourceLineage:family,splitIdentity:structuredClone(detailed.exported.sidecar.splitIdentity),
    metrics:{detailedRecords:detailedLines.length,detailedBytes:detailedLines.reduce((n,line)=>n+Buffer.byteLength(line),0),
      summaryRecords:1,summaryBytes:Buffer.byteLength(raw),nativeTokens:null},
    nativeAdmission:false,learningStatus:'untested',
    boundary:'A separately provided region endpoint, not a v5 selected-execution record or native consumer qualification.'};
}
