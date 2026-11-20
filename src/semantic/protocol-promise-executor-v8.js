// Resolving functions retain one shared first-call cell. Executor calls use the
// existing public invocation stack; settlement uses its existing Promise jobs.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {allowsPromiseJoinDetailedCallV8} from './protocol-promise-join-v8.js';

export const PROMISE_EXECUTOR_PROFILE_V8='promise-executor/1';
export const PROMISE_EXECUTOR_STATE_V8='semantic-promise-executor-state/1';
export const PROMISE_EXECUTOR_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'promise.executor.enter':['kind','promise','executor','child','resolve','reject'],
  'promise.resolver.call':['kind','resolver','value'],
  'promise.executor.finish':['kind','promise','invocation','completion']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const copy=structuredClone,bound=4096;
const fail=message=>{const error=new TypeError('Promise executor: '+message);error.category='unsupported.promise-executor';throw error;};
const id=value=>{if(typeof value!=='string'||!value||value.length>256)fail('bounded identity required');};
const ref=(value,validate)=>{validate(value);if(value[0]!=='ref')fail('owned reference required');};
const code=(promise,mode)=>'Promise.executor.'+mode+':'+promise;
function completion(value,validate){
  assertAlgorithmFields(value,['kind','value'],'executor completion');
  if(!['return','throw'].includes(value.kind))fail('completion kind');validate(value.value);
}
export function validatePromiseExecutorRecordV8(record,{value:validateValue}={}){
  const fields=PROMISE_EXECUTOR_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'Promise executor record');
  const validate=validateValue??(value=>{if(!Array.isArray(value))fail('tagged value required');});
  if(record.kind==='promise.executor.enter'){
    for(const key of ['promise','child','resolve','reject'])id(record[key]);ref(record.executor,validate);
    if(record.resolve===record.reject)fail('resolving functions must have distinct identities');
  }else if(record.kind==='promise.resolver.call'){ref(record.resolver,validate);validate(record.value);}
  else{id(record.promise);id(record.invocation);completion(record.completion,validate);}
  return true;
}
function state(controller,api){return api.state(controller).promiseExecutors??={schema:PROMISE_EXECUTOR_STATE_V8,capabilities:[],executors:[]};}
function promise(controller,id,api){const node=controller.heap.get(id);
  api.require(node?.kind==='promise'&&node.external===null,'owned internal Promise required');return node;}
function resolverNode(promise,mode){return {kind:'closure',code:code(promise,mode),captures:[],
  functionKind:'ordinary',lexicalReceiver:null,prototype:'ordinary',properties:new Map(),promiseResolver:{promise,mode}};}
function capability(controller,identity,api){
  const row=state(controller,api).capabilities.find(row=>row.resolve===identity||row.reject===identity);
  api.require(row,'undeclared resolving function');return row;
}
export function applyPromiseExecutorRecordV8(controller,record,api){
  if(!validatePromiseExecutorRecordV8(record,{value:api.validateValue}))return false;
  if(record.kind==='promise.executor.enter'){
    const target=promise(controller,record.promise,api),existing=controller.protocol?.promiseExecutors;
    api.require(target.state==='pending'&&target.adopted===null&&!target.join&&
      !existing?.capabilities.some(row=>row.promise===record.promise),'executor requires a fresh pending Promise');
    api.require(!controller.activeJob,'executor inside an active reaction needs its scheduler call profile');
    api.require((existing?.capabilities.length??0)<bound,'capability count bound');
    api.fresh(controller,record.resolve);api.fresh(controller,record.reject);api.known(controller,record.executor);
    const executor=controller.heap.get(record.executor[1]);
    api.require(executor?.kind==='closure'&&!executor.promiseResolver,'executor must be a source closure');
    controller.heap.set(record.resolve,resolverNode(record.promise,'resolve'));
    controller.heap.set(record.reject,resolverNode(record.promise,'reject'));
    const data=state(controller,api),parent=controller.stack.at(-1);
    api.require(parent,'executor requires an active parent');
    api.call(controller,{child:record.child,callee:record.executor,receiver:['undefined'],
      arguments:[['ref',record.resolve],['ref',record.reject]]});
    data.capabilities.push({promise:record.promise,resolve:record.resolve,reject:record.reject,called:false,resolution:null});
    data.executors.push({promise:record.promise,parent,child:record.child,phase:'running',completion:null});
  }else if(record.kind==='promise.resolver.call'){
    api.known(controller,record.resolver);api.known(controller,record.value);
    const row=capability(controller,record.resolver[1],api),target=promise(controller,row.promise,api),
      mode=row.resolve===record.resolver[1]?'resolve':'reject';
    if(row.called)return true;
    if(target.state==='pending'&&mode==='resolve'&&record.value[0]==='ref'){
      // Native resolving functions enqueue assimilation even for an owned
      // Promise. Direct controller adoption omits those observable FIFO jobs.
      api.require(false,controller.heap.get(record.value[1])?.kind==='promise'?
        'Promise adoption requires its resolving-function job protocol':
        'thenable/object resolution requires its separate protocol');
    }
    row.called=true;row.resolution={mode,value:copy(record.value)};
    if(target.state==='pending')controller.settlePromise(row.promise,mode==='resolve'?'fulfilled':'rejected',record.value);
  }else{
    const data=state(controller,api),entry=data.executors.find(row=>row.promise===record.promise),
      cap=data.capabilities.find(row=>row.promise===record.promise),target=promise(controller,record.promise,api);
    api.require(entry?.phase==='running'&&cap&&entry.child===record.invocation&&controller.stack.at(-1)===record.invocation&&
      controller.stack.at(-2)===entry.parent,'executor completion lacks its active call');
    api.known(controller,record.completion.value);
    api.complete(controller,{kind:record.completion.kind,invocation:record.invocation,value:record.completion.value});
    if(record.completion.kind==='throw'&&!cap.called&&target.state==='pending')
      controller.settlePromise(record.promise,'rejected',record.completion.value);
    entry.phase='complete';entry.completion=copy(record.completion);
    controller.lastReturn={kind:'return',value:['ref',record.promise]};
  }
  return true;
}
export function assertPromiseExecutorNextV8(controller,record,api){
  const data=controller.protocol?.promiseExecutors;if(!data)return true;
  const fields=record.fields??record,active=data.executors.find(row=>row.phase==='running'&&row.child===controller.stack.at(-1));
  if(active&&['return','throw'].includes(record.kind))return false;
  if(record.kind==='end'&&data.executors.some(row=>row.phase==='running'))return false;
  if(record.kind==='promise'&&['resolve','reject','adopt'].includes(fields.action)&&data.capabilities.some(row=>row.promise===fields.promise))return false;
  if(record.kind.startsWith('property.')&&[fields.object,fields.receiver?.[0]==='ref'?fields.receiver[1]:null]
    .some(identity=>controller.heap.get(identity)?.promiseResolver))return false;
  return true;
}
export function assertPromiseExecutorCallV8(controller,callee,_options,api){
  api.require(!controller.heap.get(callee[1])?.promiseResolver,'resolving functions require their explicit settlement record');return true;
}
export function allowsPromiseExecutorInternalSchedulerV8(controller,record){
  return record?.kind==='promise.executor.enter'||controller.protocol?.promiseExecutors!==undefined&&controller.protocol.promiseExecutors!==null;
}
export function allowsPromiseExecutorDetailedCallV8(controller,record){
  const fields=record.fields??record;
  return !controller.heap.get(fields.callee)?.promiseResolver&&allowsPromiseJoinDetailedCallV8(controller,record);
}
export function restorePromiseExecutorStateV8(controller,data,api){
  assertAlgorithmFields(data,['schema','capabilities','executors'],'Promise executor state');
  api.require(data.schema===PROMISE_EXECUTOR_STATE_V8,'executor state schema');
  for(const name of ['capabilities','executors']){assertAlgorithmDataArray(data[name],name);api.require(data[name].length<=bound,'executor state count bound');}
  const identities=new Set(),promises=new Set();
  for(const row of data.capabilities){
    assertAlgorithmFields(row,['promise','resolve','reject','called','resolution'],'Promise capability');
    for(const key of ['promise','resolve','reject'])id(row[key]);
    api.require(!promises.has(row.promise)&&row.resolve!==row.reject,'duplicate Promise capability');promises.add(row.promise);
    const target=promise(controller,row.promise,api);
    for(const mode of ['resolve','reject']){
      api.require(!identities.has(row[mode])&&api.eq(controller.heap.get(row[mode]),resolverNode(row.promise,mode)),
        'resolver identity, immutable metadata or first-call link differs');identities.add(row[mode]);
    }
    api.require(typeof row.called==='boolean'&&row.called===(row.resolution!==null),'resolving function first-call cell');
    if(row.resolution!==null){assertAlgorithmFields(row.resolution,['mode','value'],'resolution');
      api.require(['resolve','reject'].includes(row.resolution.mode),'resolution mode');api.known(controller,row.resolution.value);}
    const entry=data.executors.find(entry=>entry.promise===row.promise),thrown=entry?.phase==='complete'&&entry.completion?.kind==='throw'&&
      target.state==='rejected'&&target.adopted===null&&api.eq(target.result,entry.completion.value);
    let resolved=false;
    if(row.resolution){const {mode,value}=row.resolution;
      resolved=(mode==='reject'||value[0]!=='ref')&&target.adopted===null&&
        target.state===(mode==='resolve'?'fulfilled':'rejected')&&api.eq(target.result,value);
    }
    api.require(row.called?(resolved||thrown):(target.state==='pending'&&target.adopted===null||thrown),
      'capability first-call state contradicts Promise settlement');
  }
  const children=new Set(),executed=new Set();
  for(const entry of data.executors){
    assertAlgorithmFields(entry,['promise','parent','child','phase','completion'],'executor continuation');
    for(const key of ['promise','parent','child'])id(entry[key]);
    api.require(promises.has(entry.promise)&&!executed.has(entry.promise)&&!children.has(entry.child),'executor capability/call linkage');
    executed.add(entry.promise);children.add(entry.child);
    api.require(controller.frameFunctions.has(entry.parent)&&controller.frameFunctions.has(entry.child),'executor source frames missing');
    api.require(['running','complete'].includes(entry.phase),'executor phase');
    if(entry.phase==='running'){
      const call=controller.protocol.callFrames.find(row=>row.child===entry.child);
      const cap=data.capabilities.find(row=>row.promise===entry.promise);
      api.require(entry.completion===null&&controller.stack.includes(entry.parent)&&controller.stack.includes(entry.child)&&
        call?.parent===entry.parent&&api.eq(call.arguments,[['ref',cap.resolve],['ref',cap.reject]]),
        'unfinished executor must retain its live call frame and resolving pair');
    }else{
      completion(entry.completion,value=>api.known(controller,value));
      api.require(!controller.stack.includes(entry.child),'completed executor remains active');
    }
  }
  api.require(executed.size===promises.size,'capability lacks its executor');
  for(const [identity,node]of controller.heap)if(node.promiseResolver)api.require(identities.has(identity),'orphan resolver closure');
  return {valid:true};
}
