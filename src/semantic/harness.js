// Selected execution and durable dispatch for the serial algorithm profile.
// Replaying or restoring a checkpoint never invokes a service.
import {isDeepStrictEqual} from 'node:util';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {decodeHostPayload} from '../host/materialize.js';
import {prepareHostRequest} from '../host/operations.js';
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {encodeAlgorithmScalar} from './operations.js';
import {AlgorithmController} from './controller.js';
import {defineAlgorithmProgram,hashAlgorithmData,ALGORITHM_EXECUTION_VERSION} from './program.js';
import {encodeAlgorithmRecord,decodeAlgorithmRecord} from './trace-codec.js';

const copy=value=>structuredClone(value);
const checkpointVersion='semantic-algorithm-checkpoint/2';
function reject(message){const error=new Error(message);error.category='algorithm-dispatch';throw error;}
function inputGraphOf(args){const {schema,...graph}=encodeNativeGraph(args);return graph;}

export class AlgorithmExecutionHarness {
  constructor({source,entry,program=null,args=[],inputGraph=null,capabilities=[],
    invocationId='invocation1',sessionId='algorithm1',journal=null}={}){
    this.program=program??defineAlgorithmProgram({source,entry}).program;
    this.controller=new AlgorithmController({program:this.program,inputGraph:inputGraph??inputGraphOf(args),
      capabilities,invocationId,sessionId});
    this.sessionId=sessionId;this.invocationId=invocationId;this.journal=journal;
    this.intents=new Map();this.running=new Map();this.definitions=new Map();
    this.timeline=[{mode:'observed',kind:'program',program:copy(this.program)},
      {mode:'observed',kind:'input',graph:copy(this.controller.inputGraph)}];
  }
  select(line){
    const record=typeof line==='string'?decodeAlgorithmRecord(line):line;
    const canonical=encodeAlgorithmRecord(record);
    const result=this.controller.commit(canonical);
    this.timeline.push({mode:'generated',kind:'semantic',line:canonical});
    if(result.dispatch){
      const intent={...result.dispatch,status:'selected',attempt:1,witness:canonical};
      this.intents.set(intent.id,intent);
    }
    return result;
  }
  deliver(record,{evidence=null}={}){
    const observation=typeof record==='string'?decodeAlgorithmRecord(record):record;
    const intent=this.intents.get(observation.request);
    if(!intent||!['selected','dispatched','uncertain'].includes(intent.status))
      reject('Observation has no live selected request');
    if(intent.status==='uncertain'&&(typeof evidence!=='string'||!evidence))
      reject('An uncertain dispatch needs explicit reconciliation evidence');
    const result=this.controller.observe(observation);
    const line=encodeAlgorithmRecord(observation);
    intent.status='settled';intent.observation=copy(observation);
    if(evidence)intent.reconciliation=evidence;
    this.timeline.push({mode:'observed',kind:'observation',line,
      ...(evidence?{reconciliation:evidence}:{})});
    return result;
  }
  dispatch(id,adapter){
    const intent=this.intents.get(id);
    if(!intent)return Promise.reject(new Error('Unknown algorithm request'));
    if(intent.status==='settled')return Promise.resolve(copy(intent.observation));
    if(this.running.has(id))return this.running.get(id);
    if(intent.status!=='selected')return Promise.reject(new Error('Dispatch is uncertain; reconcile before continuing'));
    if(typeof adapter!=='function')return Promise.reject(new TypeError('A host-established adapter is required'));
    const run=Promise.resolve().then(async()=>{
      // A durable record may exist even when a crash left only an older
      // selected checkpoint. Treat that window as uncertain, never as retry.
      if(this.journal){
        try{
          await this.journal.readIntent(this.sessionId,intent.key,intent.attempt);
          intent.status='uncertain';reject('A durable intent already exists; reconcile before dispatch');
        }catch(error){if(error.code!=='ENOENT')throw error;}
        intent.status='committing';
        await this.journal.append({schema:'semantic-action-intent/4',session:this.sessionId,
          key:intent.key,attempt:intent.attempt,invocationId:this.invocationId,effectId:id,
          operation:intent.operation,payload:intent.payload,payloadDigest:intent.payloadDigest,
          taskRevision:1,witness:intent.witness});
      }
      intent.status='dispatched';
      this.timeline.push({mode:'observed',kind:'dispatch',request:id,key:intent.key,attempt:intent.attempt});
      const args=decodeHostPayload(intent.payload,intent.codec);
      let status='fulfilled',value;
      try{
        value=await adapter(args,Object.freeze({operation:intent.operation,request:id,
          sessionId:this.sessionId,invocationId:this.invocationId,
          idempotencyKey:this.sessionId+'/'+intent.key}));
      }catch(error){status='rejected';value=error;}
      let encoded;
      try{encoded=encodeAlgorithmScalar(value);}
      catch(error){intent.status='uncertain';reject('Host outcome is outside the scalar profile: '+error.message);}
      const step=this.controller.nextStep();
      const observation={kind:'observe',request:id,id:step.id,status,value:encoded};
      this.deliver(observation);return copy(observation);
    });
    this.running.set(id,run);
    void run.finally(()=>this.running.delete(id)).catch(()=>{});
    return run;
  }
  modelContext(){return this.controller.context({definitions:this.definitions});}
  exportEpisode(){
    return {schema:ALGORITHM_EXECUTION_VERSION,traceFormat:'semantic-trace/7',contextFormat:'semantic-context/7',
      representation:'algorithm',profile:'algorithm-execution/1',
      timeline:copy(this.timeline),completion:copy(this.controller.completion),
      claims:copy(this.controller.claims),firstViolation:copy(this.controller.firstViolation)};
  }
  checkpoint(){
    const body={schema:checkpointVersion,controller:this.controller.checkpoint(),
      timeline:copy(this.timeline),intents:[...this.intents].map(([id,intent])=>[id,copy(intent)])};
    return {...body,integrity:hashAlgorithmData(body)};
  }
  async persistCheckpoint(){
    if(!this.journal)throw new TypeError('A durable intent journal is required');
    const packet=this.checkpoint(),key=hashAlgorithmData(JSON.stringify(packet)+'\n');
    const receipt=await this.journal.put(key,packet);
    return {...receipt,checkpointSchema:checkpointVersion};
  }
  static async restoreFromJournal({journal,key}={}){
    if(!journal||typeof key!=='string')throw new TypeError('A durable checkpoint reference is required');
    const bytes=await journal.readBytes(key);
    if(hashAlgorithmData(bytes.toString('utf8'))!==key)reject('Durable algorithm checkpoint object changed');
    return AlgorithmExecutionHarness.restore(JSON.parse(bytes.toString('utf8')),{journal});
  }
  static restore(packet,{journal=null}={}){
    assertAlgorithmFields(packet,['schema','controller','timeline','intents','integrity'],'algorithm checkpoint');
    const {integrity,...body}=packet??{};
    if(body.schema!==checkpointVersion||hashAlgorithmData(body)!==integrity)
      reject('Algorithm checkpoint version or integrity mismatch');
    const controller=AlgorithmController.restore(body.controller);
    const harness=new AlgorithmExecutionHarness({program:controller.program,inputGraph:controller.inputGraph,
      capabilities:[...controller.capabilities],sessionId:controller.sessionId,
      invocationId:controller.invocationId,journal});
    harness.controller=controller;
    if(!Array.isArray(body.timeline)||!Array.isArray(body.intents))reject('Incomplete algorithm checkpoint');
    assertAlgorithmDataArray(body.timeline,'checkpoint timeline');
    assertAlgorithmDataArray(body.intents,'checkpoint intents');
    for(const pair of body.intents){
      assertAlgorithmDataArray(pair,'checkpoint intent pair');
      if(pair.length!==2)reject('Checkpoint intent pair arity');
    }
    if(!isDeepStrictEqual(body.timeline.slice(0,2),harness.timeline))
      reject('Checkpoint program or input authority changed');
    // Rebuild the transport lifecycle from the checked transcript; a checksum
    // alone cannot certify selected requests or settled observations.
    const records=[],requests=new Map();
    for(const row of body.timeline.slice(2)){
      if(row.kind==='semantic'){
        assertAlgorithmFields(row,['mode','kind','line'],'generated timeline row');
        if(row.mode!=='generated')reject('Checkpoint generated authority changed');
        const record=decodeAlgorithmRecord(row.line,{role:'generated'});
        records.push({mode:row.mode,line:row.line});
        if(record.kind==='request'){
          if(requests.has(record.id))reject('Duplicate selected request');
          requests.set(record.id,{record,line:row.line,observed:false,dispatched:false,reconciliation:null});
        }
      }else if(row.kind==='dispatch'){
        assertAlgorithmFields(row,['mode','kind','request','key','attempt'],'dispatch timeline row');
        const request=requests.get(row.request);
        if(row.mode!=='observed'||!request||request.observed||request.dispatched||
          row.key!==controller.invocationId+'/'+row.request||row.attempt!==1)
          reject('Checkpoint dispatch order, multiplicity or identity changed');
        request.dispatched=true;
      }else if(row.kind==='observation'){
        assertAlgorithmFields(row,['mode','kind','line',...(Object.hasOwn(row,'reconciliation')?['reconciliation']:[])],
          'observation timeline row');
        const record=decodeAlgorithmRecord(row.line,{role:'observed'}),request=requests.get(record.request);
        if(row.mode!=='observed'||!request||request.observed||Object.hasOwn(row,'reconciliation')&&
          (typeof row.reconciliation!=='string'||!row.reconciliation))
          reject('Checkpoint observation correlation or authority changed');
        request.observed=record;request.reconciliation=row.reconciliation??null;
        records.push({mode:row.mode,line:row.line});
      }else reject('Unknown checkpoint timeline row');
    }
    if(!isDeepStrictEqual(records,controller.history))reject('Checkpoint timeline differs from checked claims');
    if(body.intents.length!==requests.size||new Set(body.intents.map(([id])=>id)).size!==requests.size)
      reject('Checkpoint request identities changed');
    for(const [id,intent] of body.intents){
      const selected=requests.get(id),record=selected?.record;
      assertAlgorithmFields(intent,['id','boundary','operation','arguments','payload','codec','payloadDigest',
        'key','status','attempt','witness',...(intent.status==='settled'?['observation']:[]),
        ...(selected?.reconciliation?['reconciliation']:[])],'checkpoint intent');
      if(!record||intent.id!==id||intent.operation!==record.operation||intent.boundary!==record.boundary||
        !isDeepStrictEqual(intent.arguments,record.arguments)||intent.witness!==selected.line||
        intent.key!==controller.invocationId+'/'+id||intent.attempt!==1||
        hashAlgorithmData(intent.payload)!==intent.payloadDigest||
        !['selected','committing','dispatched','uncertain','settled'].includes(intent.status)||
        Boolean(selected.observed)!==(intent.status==='settled')||
        selected.observed&&!isDeepStrictEqual(selected.observed,intent.observation)||
        selected.reconciliation!==(intent.reconciliation??null)||
        selected.dispatched&&['selected','committing'].includes(intent.status)||
        !selected.dispatched&&intent.status==='dispatched')
        reject('Checkpoint intent differs from certified request');
      // Independently derive transport from committed arguments again.
      const transport=prepareHostRequest({},record.operation,record.arguments);
      if(intent.codec!==transport.codec||intent.payload!==transport.payload||
        intent.payloadDigest!==hashAlgorithmData(transport.payload))
        reject('Checkpoint transport differs from selected arguments');
      const restored=copy(intent);
      if(['committing','dispatched'].includes(restored.status)||restored.status==='selected'&&!journal)
        restored.status='uncertain';
      harness.intents.set(id,restored);
    }
    harness.timeline=copy(body.timeline);
    return harness;
  }
}
