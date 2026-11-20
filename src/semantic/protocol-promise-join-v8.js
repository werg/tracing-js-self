// Bounded Promise.all/race protocol transitions. The controller's existing
// Promise heap, job table, ready queue and scheduler remain authoritative.
import {analyzeSemanticProgram} from '../training/semantic-program.js';
export const PROMISE_JOIN_PROFILE_V8='promise-join/1';
export const PROMISE_JOIN_STATE_V8='semantic-promise-join-state/1';
export const PROMISE_JOIN_RECORD_FIELDS=Object.freeze({
  'promise.join':Object.freeze(['kind','mode','result','inputs','jobs','output','error']),
  'promise.join.step':Object.freeze(['kind','result','job','entry','output','error','status','value'])
});
const modes=new Set(['all','race']);
const fail=message=>{const error=new TypeError('Promise join: '+message);error.category='unsupported.promise-join';throw error;};
const copy=structuredClone;
const ident=value=>{if(typeof value!=='string'||!value||value.length>256)fail('identity');};
const list=(value,label)=>{if(!Array.isArray(value)||value.length>4096)fail(label+' array bound');};
const isId=value=>typeof value==='string'&&value.length>0&&value.length<=256;

export function validatePromiseJoinRecordV8(record,{value}={}){
  if(!record||typeof record!=='object'||Array.isArray(record))return false;
  const fields=PROMISE_JOIN_RECORD_FIELDS[record.kind];if(!fields)return false;
  if(Object.keys(record).length!==fields.length||fields.some(field=>!Object.hasOwn(record,field)))fail('record fields');
  ident(record.result);
  if(record.kind==='promise.join'){
    if(!modes.has(record.mode))fail('unsupported mode');
    list(record.inputs,'inputs');list(record.jobs,'jobs');
    if(record.inputs.length!==record.jobs.length)fail('input/job count');
    record.inputs.forEach(ident);record.jobs.forEach(ident);
    if(new Set(record.jobs).size!==record.jobs.length)fail('duplicate join job');
    for(const id of [record.output,record.error])if(id!==null)ident(id);
    if(record.mode==='all'&&record.inputs.length===0){if(record.output===null||record.error!==null)fail('empty all allocation identity');}
    else if(record.output!==null||record.error!==null)fail('join registration leaks a future allocation identity');
  }else{
    ident(record.job);
    for(const id of [record.entry,record.output,record.error])if(id!==null)ident(id);
    if(!['pending','fulfilled','rejected'].includes(record.status))fail('result Promise status');
    if(record.status==='pending'){if(record.value!==null)fail('pending result has a value');}
    else{if(record.value===null)fail('settled result lacks a value');if(value)value(record.value);}
  }
  return true;
}

function promise(controller,id){
  const node=controller.heap.get(id);
  if(!node||node.kind!=='promise')fail('Promise identity');
  if(!['pending','fulfilled','rejected'].includes(node.state)||!Array.isArray(node.reactions))fail('Promise state shape');
  if(node.state==='pending'&&node.result!==null||node.state!=='pending'&&node.result===null)fail('Promise settlement shape');
  return node;
}
function registerJob(controller,id,input,result,index){
  controller.jobs.set(id,{status:'waiting',owner:controller.rootInvocation,promise:input,
    reaction:'join',closure:null,rejectionClosure:null,target:null,sequence:++controller.scheduler.registration,
    joinResult:result,joinIndex:index});
}
function outputArray(controller,id,values,api){
  api.fresh(controller,id);const properties=new Map();
  values.forEach((value,index)=>properties.set(String(index),copy(value)));
  properties.set('length',['num',values.length]);
  controller.heap.set(id,{kind:'array',code:null,captures:[],prototype:'ordinary',properties});
}
function status(controller,node){return {status:node.state,value:node.state==='pending'?null:copy(node.result)};}
function normalizeClaim(controller,node,record,api){
  const actual=status(controller,node);
  api.require(actual.status===record.status&&api.eq(actual.value,record.value),'false join result settlement claim');
}

export function applyPromiseJoinRecordV8(controller,record,api){
  if(!validatePromiseJoinRecordV8(record,{value:value=>{
    if(value[0]==='ref'&&record.kind==='promise.join.step'&&record.output===value[1])return;
    api.known(controller,value);
  }}))return false;
  if(record.kind==='promise.join'){
    const result=promise(controller,record.result);
    if(result.state!=='pending'||result.join||result.adopted!==null||result.external!==null)
      fail('result must be a fresh pending internal join Promise');
    if(record.inputs.includes(record.result))fail('result Promise cannot be an input');
    const occupied=new Set([...controller.heap.keys(),...controller.jobs.keys(),...controller.continuations.keys()]);
    for(const job of record.jobs)if(occupied.has(job))fail('join job identity is not fresh');
    for(const input of record.inputs)promise(controller,input);
    if(record.output!==null)api.fresh(controller,record.output);
    if(record.error!==null)api.fresh(controller,record.error);
    if(record.output!==null&&record.error!==null&&record.output===record.error)fail('duplicate result allocation identity');
    result.join={schema:PROMISE_JOIN_STATE_V8,owner:controller.rootInvocation,mode:record.mode,inputs:copy(record.inputs),jobs:copy(record.jobs),
      observed:record.inputs.map(()=>false),values:record.inputs.map(()=>null),output:record.output,error:record.error,
      settled:false};
    if(record.inputs.length===0){
      if(record.mode==='all'){
        outputArray(controller,record.output,[],api);controller.settlePromise(record.result,'fulfilled',['ref',record.output]);result.join.settled=true;
      }
      return true;
    }
    record.jobs.forEach((job,index)=>registerJob(controller,job,record.inputs[index],record.result,index));
    controller.refreshReady();return true;
  }
  if(record.entry!==null||record.error!==null)fail('unused entry/error allocation identity');
  const result=promise(controller,record.result),join=result.join;
  if(!join||join.schema!==PROMISE_JOIN_STATE_V8||!modes.has(join.mode))fail('unknown join result');
  if(join.owner!==controller.rootInvocation)fail('join belongs to another invocation');
  const index=join.jobs.indexOf(record.job);if(index<0)fail('job is not registered with result Promise');
  const job=controller.jobs.get(record.job);
  if(!job||job.owner!==join.owner||job.reaction!=='join'||job.joinResult!==record.result||job.joinIndex!==index||job.promise!==join.inputs[index])fail('join scheduler job linkage');
  if(controller.stack.length||controller.activeJob||[...controller.jobs.values()].some(row=>row.status==='running')||
    controller.ready[0]!==record.job||job.status!=='queued')fail('join step violates FIFO or stack turn');
  const input=promise(controller,join.inputs[index]);if(input.state==='pending')fail('join step before input settlement');
  controller.ready.shift();job.status='completed';join.observed[index]=true;join.values[index]=copy(input.result);
  let expectedOutput=null;
  if(!join.settled){
    if(join.mode==='race'){
      controller.settlePromise(record.result,input.state,copy(input.result));join.settled=true;
    }else if(input.state==='rejected'){
      controller.settlePromise(record.result,'rejected',copy(input.result));join.settled=true;
    }else if(join.observed.every(Boolean)){
      if(record.output===null)fail('final Promise.all fulfillment requires an output allocation identity');
      outputArray(controller,record.output,join.values,api);expectedOutput=record.output;join.output=record.output;
      controller.settlePromise(record.result,'fulfilled',['ref',record.output]);join.settled=true;
    }
  }
  if(expectedOutput===null&&record.output!==null)fail('unused step output identity');
  if(expectedOutput!==record.output)fail('false output allocation identity');
  normalizeClaim(controller,result,record,api);controller.refreshReady();return true;
}

export function assertPromiseJoinNextV8(controller,record){
  const fields=record.fields??record,selected=controller.jobs?.get(fields.job);
  if(record.kind==='promise'&&['resolve','reject','adopt'].includes(fields.action)&&
    controller.heap.get(fields.promise)?.join)return false;
  // The callback's return empties its JS stack before the existing scheduler
  // commits its result Promise. Completing that turn precedes the next job.
  if(record.kind==='job'&&fields.action==='complete'&&selected?.status==='running'&&selected.reaction!=='join')return true;
  const head=controller.ready?.[0],job=head&&controller.jobs?.get(head);
  if(controller.stack?.length===0&&job?.reaction==='join')
    return record.kind==='promise.join.step'&&record.job===head;
  if(record.kind==='promise.join.step')return true;
  if(record.kind==='job'&&fields.action==='dispatch'&&controller.jobs?.get(fields.job)?.reaction==='join')return false;
  return true;
}
export function allowsPromiseJoinInternalSchedulerV8(controller,record){
  if(record?.kind==='promise.join')return true;
  return [...(controller.heap?.values?.()??[])].some(node=>node.kind==='promise'&&node.join?.schema===PROMISE_JOIN_STATE_V8);
}
export function allowsPromiseJoinWithoutStackV8(controller,record){
  if(record?.kind!=='promise.join.step'||controller.stack?.length!==0)return false;
  const result=controller.heap?.get(record.result),join=result?.join;
  return result?.kind==='promise'&&join?.schema===PROMISE_JOIN_STATE_V8&&join.owner===controller.rootInvocation&&join.jobs?.includes(record.job)===true&&
    controller.ready?.[0]===record.job;
}
export function allowsPromiseJoinDetailedCallV8(controller,record){
  const fields=record?.fields??record;
  if(record?.kind!=='call'||controller.protocol?.pendingCalls?.length||controller.protocol?.callFrames?.length)return false;
  const identity=fields.callee;
  if(typeof identity!=='string'||!identity||identity.length>256)return false;
  const callee=controller.heap?.get(identity);
  if(callee)return callee.kind==='closure'&&(callee.functionKind===undefined||callee.functionKind==='ordinary')&&
    callee.callable==null&&callee.constructorKind==null&&!callee.generatorFunction&&!callee.promiseResolver;
  // Detailed-source lifecycle carries immutable source callable names. Match
  // them against this invocation's analyzed source rather than accepting
  // arbitrary names or any class constructor.
  if(identity.startsWith('class:'))return false;
  const source=controller.source?.source;
  if(typeof source!=='string')return false;
  let functions;
  try{functions=analyzeSemanticProgram(source).functions;}catch{return false;}
  const named=functions.some(fn=>fn.name===identity||identity==='function:'+fn.start);
  return named&&!controller.callableMetadata?.[identity]?.richProtocol;
}

export function restorePromiseJoinStateV8(controller,api){
  for(const [id,node]of controller.heap){
    if(node.kind!=='promise')continue;
    if(!(node.properties instanceof Map)||!['pending','fulfilled','rejected'].includes(node.state)||!Array.isArray(node.reactions))fail('restored Promise shape');
    if(node.state==='pending'&&node.result!==null||node.state!=='pending'&&node.result===null)fail('restored Promise settlement');
    if(node.result!==null)api.known(controller,node.result,id);
    const join=node.join;
    if(join===undefined||join===null)continue;
    if(node.external!==null||node.adopted!==null)fail('restored join must own its internal settlement');
    if(!join||join.schema!==PROMISE_JOIN_STATE_V8||!isId(join.owner)||!modes.has(join.mode)||!Array.isArray(join.inputs)||!Array.isArray(join.jobs)||
      !Array.isArray(join.observed)||!Array.isArray(join.values)||join.inputs.length!==join.jobs.length||
      join.inputs.length!==join.observed.length||join.inputs.length!==join.values.length||typeof join.settled!=='boolean')fail('restored join metadata');
    if(join.settled!==(node.state!=='pending'))fail('join settled flag differs from result Promise');
    const jobs=new Set();
    for(let i=0;i<join.inputs.length;i++){
      ident(join.inputs[i]);ident(join.jobs[i]);if(jobs.has(join.jobs[i]))fail('restored duplicate join job');jobs.add(join.jobs[i]);
      if(typeof join.observed[i]!=='boolean')fail('restored join observation flag');
      const value=join.values[i];if(join.observed[i])api.known(controller,value,id);else if(value!==null)fail('unobserved join input has value');
      const job=controller.jobs.get(join.jobs[i]);if(join.owner!==controller.rootInvocation){
        if(job)fail('foreign join job in invocation scheduler');
        const input=promise(controller,join.inputs[i]);
        if(join.observed[i]&&(input.state==='pending'||!api.eq(value,input.result)))fail('foreign join observed value differs from input');
        continue;
      }
      if(!job||job.owner!==join.owner||job.reaction!=='join'||job.joinResult!==id||job.joinIndex!==i||job.promise!==join.inputs[i])fail('restored join scheduler linkage');
      if((job.status==='completed')!==join.observed[i])fail('restored join observation/job lifecycle');
      const input=promise(controller,join.inputs[i]);
      if(join.observed[i]&&(input.state==='pending'||!api.eq(value,input.result)))fail('restored join observed value differs from input settlement');
    }
    if(join.mode==='all'&&join.inputs.length===0){
      if(node.state!=='fulfilled'||!isId(join.output)||join.error!==null||node.result[0]!=='ref'||node.result[1]!==join.output)fail('restored empty all');
      const output=controller.heap.get(join.output);if(output?.kind!=='array'||output.properties.get('length')?.[1]!==0)fail('restored empty all output');
    }
    if(join.mode==='race'&&join.inputs.length===0&&(join.output!==null||join.error!==null||node.state!=='pending'))fail('restored empty race');
    if(join.inputs.length>0&&join.output!==null&&join.output!==undefined&&node.state!=='fulfilled')fail('premature join output');
    if(join.error!==null&&join.error!==undefined)fail('unsupported join error storage');
  }
  for(const [id,job]of controller.jobs)if(job.reaction==='join'){
    const result=controller.heap.get(job.joinResult);if(result?.kind!=='promise'||!result.join?.jobs.includes(id)||result.join.owner!==controller.rootInvocation||job.owner!==controller.rootInvocation)fail('orphan join job');
    if(!['waiting','queued','completed'].includes(job.status))fail('join job lifecycle');
    if(job.status==='queued'&&!controller.ready.includes(id))fail('queued join job missing from ready queue');
  }
  return {valid:true};
}
