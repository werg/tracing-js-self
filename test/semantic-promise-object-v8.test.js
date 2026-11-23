import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {promiseIntrinsicIdV8} from '../src/semantic/protocol-promise-object-v8.js';

const U=['undefined'],ref=id=>['ref',id],key=name=>['str',name],
  intrinsic=name=>ref(promiseIntrinsicIdV8(name)),prototype=promiseIntrinsicIdV8('Promise.prototype');
const artifacts=[],nativeReceipts=[];
// These are direct public-protocol transition controls. Source correspondence is
// tested separately; a replay receipt here is deliberately not training admission.
function recording(h=new RegionExecutionHarness({automaticDelivery:false}),contexts=[]){
  h.selectedContexts=contexts;const original=h.select.bind(h);
  h.select=(owner,line,options)=>{const context=h.modelContext(owner),result=original(owner,line,options);
    h.selectedContexts.push(context);return result;};return h;
}
const detail=(h,kind,fields)=>h.select('invocation1',encodeDetailedRecord({kind,fields},{role:'generated'}));
const select=(h,record)=>h.select('invocation1',encodeProtocolRecordV8(record));
const data=(value,flags={})=>({kind:'data',value,writable:true,enumerable:true,configurable:true,...flags});
const accessor=(get,set=U,flags={})=>({kind:'accessor',get,set,enumerable:false,configurable:true,...flags});
const define=(h,object,name,descriptor,success=true)=>select(h,{kind:'property.define',object,key:key(name),descriptor,success});
const get=(h,object,name,result,receiver=ref(object))=>select(h,{kind:'property.get',object,key:key(name),receiver,result});
const allocate=(h,name,objectKind='object',code=null)=>select(h,{kind:'allocate',name,objectKind,length:null,
  properties:[],code,captures:[],functionKind:objectKind==='closure'?'ordinary':null,lexicalReceiver:null});
function setup({initialize=true}={}){
  const h=recording();
  h.publishProgram({programId:'program1',source:'"use strict";function run(){return 0;}function getter(){return this;}function setter(value){return value;}',entry:'run',capabilities:[]});
  h.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'promise-object',
    inputGraph:{roots:[],objects:[]},realmPolicy:'fresh'});
  for(const promise of ['p1','p2']){
    detail(h,'promise',{action:'create',promise});detail(h,'promise',{action:'resolve',promise,value:['num',7]});
  }
  if(initialize)select(h,{kind:'promise.intrinsics'});return h;
}
function roundtrip(h){const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(h.controller));return recording(restored,h.selectedContexts);}
function refuses(h,record,pattern){const before=sharedRegionState(h.controller);
  assert.throws(()=>select(h,record),pattern);assert.deepEqual(sharedRegionState(h.controller),before);}
function finish(h,name){
  select(h,{kind:'return',invocation:'invocation1',value:['num',0]});
  select(h,{kind:'end',completion:'return'});
  roundtrip(h);artifacts.push({name,artifact:{public:h.exportEpisode(),contexts:h.selectedContexts},state:sharedRegionState(h.controller)});
}
function cloneController(h,mutate){
  const c=Object.assign(Object.create(Object.getPrototypeOf(h.controller)),h.controller);
  for(const name of ['heap','protocol','locals','stack','frameFunctions','receiver','captureAliases','jobs','ready','scheduler','continuations'])
    c[name]=structuredClone(c[name]);mutate(c);return c;
}

test('intrinsic initialization is atomic, collision-free, shared and retained by subsequent Promises',()=>{
  const collision=setup({initialize:false});allocate(collision,prototype);
  refuses(collision,{kind:'promise.intrinsics'},/duplicate/);
  let h=setup();refuses(h,{kind:'promise.intrinsics'},/already initialized/);
  for(const object of ['p1','p2'])select(h,{kind:'property.getPrototypeOf',object,result:intrinsic('Promise.prototype')});
  detail(h,'promise',{action:'create',promise:'p3'});detail(h,'promise',{action:'resolve',promise:'p3',value:['num',8]});
  select(h,{kind:'property.getPrototypeOf',object:'p3',result:intrinsic('Promise.prototype')});
  select(h,{kind:'promise.intrinsic.get',base:'Promise',key:key('prototype'),result:intrinsic('Promise.prototype')});
  select(h,{kind:'promise.intrinsic.get',base:'Object',key:key('prototype'),result:intrinsic('Object.prototype')});
  refuses(h,{kind:'promise.intrinsic.get',base:'Promise',key:key('prototype'),result:intrinsic('Object.prototype')},/identity/);
  for(const name of ['Promise','Object','Promise.prototype.then']){
    const expr={op:'unary',operator:'typeof',arg:{op:'literal',value:intrinsic(name)}};
    refuses(h,{kind:'compute',expr,result:['str','object'],bind:null},/computation/);
    select(h,{kind:'compute',expr,result:['str','function'],bind:null});
  }
  h=roundtrip(h);get(h,'p1','constructor',intrinsic('Promise'));get(h,'p2','then',intrinsic('Promise.prototype.then'));
  finish(h,'intrinsic-identity');
});

test('Promise data descriptors, aliases, reflection and failed definitions use shared ordinary state',()=>{
  let h=setup();select(h,{kind:'bind',name:'alias',value:ref('p1')});
  define(h,'p1','x',data(['num',3]));get(h,'p1','x',['num',3]);
  select(h,{kind:'property.set',object:'p1',key:key('x'),receiver:ref('p1'),value:['num',4],success:true});
  get(h,'p1','x',['num',4]);assert.deepEqual(h.controller.locals.get('alias'),ref('p1'));
  for(const [name,result]of [['x',true],['constructor',false]])select(h,{kind:'property.hasOwn',object:'p1',key:key(name),result:['bool',result]});
  select(h,{kind:'property.descriptor',object:'p1',key:key('x'),descriptor:data(['num',4]),name:'descriptor1'});
  select(h,{kind:'property.descriptor',object:'p1',key:key('missing'),descriptor:null,name:null});
  get(h,'descriptor1','value',['num',4]);get(h,'descriptor1','configurable',['bool',true]);
  refuses(h,{kind:'property.descriptor',object:'p1',key:key('x'),descriptor:data(['num',99]),name:'forged'},/descriptor/);
  define(h,'p1','fixed',data(['num',9],{writable:false,configurable:false}));
  refuses(h,{kind:'property.define',object:'p1',key:key('fixed'),descriptor:data(['num',10],{writable:false,configurable:false}),success:true},/compatibility/);
  define(h,'p1','fixed',data(['num',10],{writable:false,configurable:false}),false);
  select(h,{kind:'property.delete',object:'p1',key:key('fixed'),success:false});
  select(h,{kind:'property.keys',object:'p1',mode:'strings',name:'keys1',keys:[key('x'),key('fixed')]});
  h=roundtrip(h);finish(h,'ordinary-descriptors');
});

test('inherited Promise getters retain their original receiver across nested calls and completion restoration',()=>{
  let h=setup();allocate(h,'getter1','closure','getter');define(h,prototype,'constructor',accessor(ref('getter1')));
  select(h,{kind:'property.descriptor',object:prototype,key:key('constructor'),descriptor:accessor(ref('getter1')),name:'accessor1'});
  select(h,{kind:'property.get.call',id:'read1',child:'gettercall1',object:'p1',key:key('constructor'),receiver:ref('p1')});
  assert.deepEqual(h.controller.receiver,ref('p1'));assert.deepEqual(h.controller.locals.get('gettercall1:this'),ref('p1'));
  h=roundtrip(h);
  // Reflect.get may select the descriptor through one object with another receiver.
  select(h,{kind:'property.get.call',id:'read2',child:'gettercall2',object:'p1',key:key('constructor'),receiver:ref('p2')});
  assert.deepEqual(h.controller.receiver,ref('p2'));h=roundtrip(h);
  select(h,{kind:'return',invocation:'gettercall2',value:ref('p2')});
  refuses(h,{kind:'property.finish',id:'read1',completion:{kind:'normal',value:ref('p2')}},/exact returned/);
  select(h,{kind:'property.finish',id:'read2',completion:{kind:'normal',value:ref('p2')}});
  assert.deepEqual(h.controller.receiver,ref('p1'));
  select(h,{kind:'return',invocation:'gettercall1',value:intrinsic('Promise')});h=roundtrip(h);
  refuses(h,{kind:'bind',name:'reordered',value:['num',1]},/completion must be consumed/);
  refuses(h,{kind:'property.finish',id:'read1',completion:{kind:'normal',value:ref('p2')}},/false property completion/);
  select(h,{kind:'property.finish',id:'read1',completion:{kind:'normal',value:intrinsic('Promise')}});
  finish(h,'getter-reentry-and-order');
});

test('Promise setters preserve the assignment result and getter throws retain exact thrown identity',()=>{
  let h=setup();allocate(h,'getter1','closure','getter');allocate(h,'setter1','closure','setter');
  define(h,'p1','value',accessor(ref('getter1'),ref('setter1')));
  select(h,{kind:'property.set.call',id:'write1',child:'settercall1',object:'p1',key:key('value'),receiver:ref('p1'),value:['num',11]});
  assert.deepEqual(h.controller.locals.get('settercall1:argument:0'),['num',11]);h=roundtrip(h);
  select(h,{kind:'return',invocation:'settercall1',value:['num',99]});
  refuses(h,{kind:'property.finish',id:'write1',completion:{kind:'normal',value:['num',99]}},/false property completion/);
  select(h,{kind:'property.finish',id:'write1',completion:{kind:'normal',value:['num',11]}});
  select(h,{kind:'property.get.call',id:'read1',child:'gettercall1',object:'p1',key:key('value'),receiver:ref('p1')});
  select(h,{kind:'throw',invocation:'gettercall1',value:ref('p2')});h=roundtrip(h);
  refuses(h,{kind:'property.finish',id:'read1',completion:{kind:'throw',value:ref('p1')}},/false property completion/);
  select(h,{kind:'property.finish',id:'read1',completion:{kind:'throw',value:ref('p2')}});
  finish(h,'accessor-completions');
});

test('Promise prototype mutations, cycle checks and extensibility are ordinary checked transitions',()=>{
  let h=setup();allocate(h,'custom');define(h,'custom','value',data(['num',6]));
  refuses(h,{kind:'property.prototype',object:promiseIntrinsicIdV8('Object.prototype'),prototype:ref('custom'),success:true},/transition/);
  select(h,{kind:'property.prototype',object:promiseIntrinsicIdV8('Object.prototype'),prototype:ref('custom'),success:false});
  select(h,{kind:'property.prototype',object:promiseIntrinsicIdV8('Object.prototype'),prototype:null,success:true});
  allocate(h,'ordinary');select(h,{kind:'property.preventExtensions',object:'ordinary'});
  select(h,{kind:'property.prototype',object:'ordinary',prototype:intrinsic('Object.prototype'),success:true});
  select(h,{kind:'property.getPrototypeOf',object:'ordinary',result:intrinsic('Object.prototype')});
  select(h,{kind:'property.prototype',object:'p1',prototype:ref('custom'),success:true});
  get(h,'p1','value',['num',6]);select(h,{kind:'property.getPrototypeOf',object:'p1',result:ref('custom')});
  refuses(h,{kind:'property.getPrototypeOf',object:'p1',result:intrinsic('Promise.prototype')},/identity/);
  refuses(h,{kind:'property.prototype',object:'custom',prototype:ref('p1'),success:true},/transition/);
  select(h,{kind:'property.prototype',object:'custom',prototype:ref('p1'),success:false});
  select(h,{kind:'property.preventExtensions',object:'p1'});
  select(h,{kind:'property.isExtensible',object:'p1',result:['bool',false]});
  refuses(h,{kind:'property.isExtensible',object:'p1',result:['bool',true]},/extensibility/);
  define(h,'p1','extra',data(['num',1]),false);
  select(h,{kind:'property.prototype',object:'p1',prototype:null,success:false});
  h=roundtrip(h);finish(h,'prototype-and-extensibility');
});

test('restored Promise object state rejects altered intrinsic identities, descriptors and pending receiver',()=>{
  const h=setup();allocate(h,'getter1','closure','getter');define(h,prototype,'constructor',accessor(ref('getter1')));
  select(h,{kind:'property.get.call',id:'read1',child:'gettercall1',object:'p1',key:key('constructor'),receiver:ref('p1')});
  for(const mutate of [
    c=>{c.protocol.promiseObjects=null;},
    c=>{c.protocol.promiseObjects.initialized=false;},
    c=>{c.heap.get(promiseIntrinsicIdV8('Promise')).intrinsicName='Object';},
    c=>{c.heap.get('p1').prototype=ref('missing');},
    c=>{c.heap.get(promiseIntrinsicIdV8('Object.prototype')).prototype=ref('p1');},
    c=>{c.heap.get('p1').prototype=ref('p2');c.heap.get('p2').prototype=ref('p1');},
    c=>{c.heap.get(prototype).properties.set('constructor',intrinsic('Promise'));},
    c=>{c.protocol.pendingCalls[0].receiver=ref('p2');}
  ]){
    const controller=cloneController(h,mutate);
    assert.throws(()=>restoreProtocolStateV8(controller,controller.protocol));
  }
});

test('independent native transitions reproduce all Promise object cases and reject altered records',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
    assert.equal(artifacts.length,5);
    const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import copy,json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
from megatoken.data.protocol_v8 import validate_protocol_state
rows=json.load(sys.stdin);out=[]
for row in rows:
    artifact=row['artifact'];receipt=validate_v8_artifact(artifact)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state'],row['name']
    rejected=0
    for event in artifact['public']['timeline']:
        if event['kind']!='protocol':continue
        record=json.loads(event['fields']['line'][9:])
        if record['kind'] not in ['promise.intrinsic.get','property.descriptor','property.getPrototypeOf','property.isExtensible','property.finish','compute','property.prototype']:continue
        bad=copy.deepcopy(artifact);target=bad['public']['timeline'][event['sequence']-1]
        if record['kind']=='property.descriptor':
            if record['descriptor'] is None:continue
            record['descriptor']['configurable']=not record['descriptor']['configurable']
        elif record['kind']=='property.finish':record['completion']['value']=['num',404]
        elif record['kind']=='property.isExtensible':record['result']=['bool',not record['result'][1]]
        elif record['kind']=='compute':record['result']=['str','object']
        elif record['kind']=='property.prototype':record['success']=not record['success']
        else:record['result']=['ref','p2']
        target['fields']['line']='protocol '+json.dumps(record,separators=(',',':'),sort_keys=True)
        try:validate_v8_artifact(bad)
        except Exception:rejected+=1
        else:raise AssertionError('native accepted altered '+record['kind'])
    initialized=next(context['state'] for context in artifact['contexts'] if (context['state'].get('protocol') or {}).get('promiseObjects'))
    mutations=[]
    changed=copy.deepcopy(initialized);changed['protocol']['promiseObjects']=None;mutations.append(changed)
    changed=copy.deepcopy(initialized);changed['protocol']['promiseObjects']['initialized']=False;mutations.append(changed)
    changed=copy.deepcopy(initialized);dict(changed['heap'])['intrinsicpromise']['intrinsicName']='Object';mutations.append(changed)
    changed=copy.deepcopy(initialized);dict(changed['heap'])['p1']['prototype']=['ref','missing'];mutations.append(changed)
    changed=copy.deepcopy(initialized);dict(changed['heap'])['intrinsicobjectprototype']['prototype']=['ref','p1'];mutations.append(changed)
    changed=copy.deepcopy(initialized);dict(changed['heap'])['p1']['prototype']=['ref','p2'];dict(changed['heap'])['p2']['prototype']=['ref','p1'];mutations.append(changed)
    pending=next((context['state'] for context in artifact['contexts'] if (context['state'].get('protocol') or {}).get('pendingCalls')),None)
    if pending:
        changed=copy.deepcopy(pending);changed['protocol']['pendingCalls'][0]['receiver']=['ref','p2'];mutations.append(changed)
    for changed in mutations:
        try:validate_protocol_state(changed['protocol'],changed['heap'],changed)
        except Exception:pass
        else:raise AssertionError('native accepted altered restored Promise object state')
    out.append({'name':row['name'],'counts':receipt['counts'],'rejectedAlterations':rejected,'rejectedRestorations':len(mutations)})
print(json.dumps(out))
`;
    const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
      env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts.push(...JSON.parse(result.stdout));
    assert.equal(nativeReceipts.length,5);assert(nativeReceipts.reduce((n,row)=>n+row.rejectedAlterations,0)>=10);
  });

after(()=>{
  if(process.env.PROMISE_OBJECT_CASES_OUT)writeFileSync(process.env.PROMISE_OBJECT_CASES_OUT,JSON.stringify(artifacts));
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-object-public-native-evidence.json'),JSON.stringify({
    schema:'promise-object-public-native-evidence/1',publicCases:artifacts.length,actualNativeCases:nativeReceipts.length,
    nativeReceipts,sourceCorrespondence:false,trainingAdmission:false,cases:artifacts}));
});
