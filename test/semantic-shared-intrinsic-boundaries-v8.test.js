import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {applyProtocolRecordV8,createProtocolStateV8,restoreProtocolStateV8,PROTOCOL_MACHINE_API_V8} from '../src/semantic/protocol-state-v8.js';
import {restorePrimitiveConversionStateV8} from '../src/semantic/protocol-primitive-conversion-v8.js';
import {promiseIntrinsicIdV8} from '../src/semantic/protocol-promise-object-v8.js';

const U=['undefined'],ref=id=>['ref',id],key=name=>['str',name],exotic=['symbol','well-known:toPrimitive'];
const intrinsic=name=>ref(promiseIntrinsicIdV8(name)),objectPrototype=promiseIntrinsicIdV8('Object.prototype');
const data=value=>({kind:'data',value,writable:true,enumerable:true,configurable:true});
const accessor=get=>({kind:'accessor',get,set:U,enumerable:false,configurable:true});
const allocate=(name,kind='object')=>({kind:'allocate',name,objectKind:kind,length:kind==='array'?1:null,
  properties:kind==='array'?[{key:key('0'),value:['num',5]}]:[],code:kind==='closure'?name:null,captures:[],
  functionKind:kind==='closure'?'ordinary':null,lexicalReceiver:null});
const define=(object,name,descriptor)=>({kind:'property.define',object,key:typeof name==='string'?key(name):name,descriptor,success:true});
const get=(object,name,result)=>({kind:'property.get',object,key:key(name),receiver:ref(object),result});
const lookup=(id,property,descriptor='missing',value=U,builtin=null)=>({kind:'conversion.lookup',id,key:property,descriptor,value,builtin});
const begin=(id,goal,value=ref('input'))=>({kind:'conversion.begin',id,goal,value});
const finish=(id,result)=>({kind:'conversion.finish',id,result});
function controller(){return {heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:U,
  stack:['root'],frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,
  protocol:createProtocolStateV8(),ready:[],effects:new Map(),jobs:new Map(),strictRequests:false};}
function apply(c,...records){for(const record of records)applyProtocolRecordV8(c,record);
  restoreProtocolStateV8(c,c.protocol);return c;}
function fresh(...records){return apply(controller(),{kind:'promise.intrinsics'},...records);}
function refuse(c,record,pattern){const before=structuredClone(c);
  assert.throws(()=>applyProtocolRecordV8(c,record),pattern);assert.deepEqual(c,before);}
function returned(c,id,child,value,getter=false){apply(c,{kind:'return',invocation:child,value},
  {kind:getter?'conversion.getter.return':'conversion.return',id,value});}
function resolution(kind,then,{inherited=false}={}){
  const h=new RegionExecutionHarness({automaticDelivery:false});
  h.publishProgram({programId:'program',source:'"use strict";function run(){}function callback(){}',entry:'run',capabilities:[]});
  h.admitInvocation({programId:'program',invocationId:'root',trackId:'track',realmId:'realm',triggerId:'entry',args:[]});
  h.select('root',{kind:'promise',fields:{action:'create',promise:'result'}});
  h.select('root',{kind:'promise.intrinsics'});
  const record=allocate('input',kind);if(kind==='closure')record.code='callback';h.select('root',record);
  h.select('root',define(inherited?objectPrototype:'input','then',data(then)));
  return h;
}

test('new intrinsic callable then identities cannot silently fulfill an ordinary resolution',async()=>{
  const native=await Promise.resolve({then:Promise.prototype.then}).then(()=> 'fulfilled',error=>error.name);
  assert.equal(native,'TypeError');
  for(const kind of ['object','array','closure'])for(const name of ['Promise.prototype.then','Object']){
    const h=resolution(kind,intrinsic(name)),before=h.checkpoint();
    assert.throws(()=>h.select('root',{kind:'promise',fields:{action:'resolve',promise:'result',value:ref('input')}}),
      {category:'region-authority',message:/Callable Promise then requires explicit assimilation jobs/});
    assert.deepEqual(h.checkpoint(),before);assert.deepEqual(RegionExecutionHarness.restore(before).checkpoint(),before);
  }
});

test('shared Object.prototype then is checked for ordinary objects, arrays and functions',()=>{
  for(const kind of ['object','array','closure']){
    const h=resolution(kind,intrinsic('Promise.prototype.then'),{inherited:true}),before=h.checkpoint();
    assert.throws(()=>h.select('root',{kind:'promise',fields:{action:'resolve',promise:'result',value:ref('input')}}),
      /Callable Promise then requires explicit assimilation jobs/);
    assert.deepEqual(h.checkpoint(),before);
    h.select('root',define('input','then',data(U)));
    h.select('root',{kind:'promise',fields:{action:'resolve',promise:'result',value:ref('input')}});
    assert.deepEqual(h.controller.promise('result').result,ref('input'));
  }
});

test('unmodeled Array and Function prototype members never fall through to Object intrinsics',()=>{
  for(const [kind,names]of [['array',['constructor','toString','toLocaleString']],['closure',['constructor','toString']]]){
    const c=fresh(allocate('input',kind));
    for(const name of names)refuse(c,get('input',name,intrinsic(name==='constructor'?'Object':'Object.prototype.'+name)),/inherited intrinsic/);
    // An explicitly selected Object.prototype is the actual chain, even for an
    // array or function. These valid custom-prototype reads must remain usable.
    apply(c,{kind:'property.prototype',object:'input',prototype:intrinsic('Object.prototype'),success:true});
    for(const name of names)apply(c,get('input',name,intrinsic(name==='constructor'?'Object':'Object.prototype.'+name)));
  }
});

test('inherited Object members use live shared state without bypassing Array or Function overrides',()=>{
  for(const kind of ['object','array','closure']){
    const c=fresh(allocate('input',kind),define(objectPrototype,'valueOf',data(['num',7])));
    apply(c,get('input','valueOf',['num',7]));
    refuse(c,get('input','valueOf',intrinsic('Object.prototype.valueOf')),/false property/);
    apply(c,{kind:'property.delete',object:objectPrototype,key:key('valueOf'),success:true},get('input','valueOf',U));
  }
});

test('pristine initialized Object conversion leaves remain supported and deleted methods stay absent',()=>{
  for(const goal of ['Number','PropertyKey']){
    const c=fresh(allocate('input'));apply(c,begin('convert',goal),lookup('convert',exotic));
    if(goal==='Number')apply(c,lookup('convert',key('valueOf'),'builtin',U,'Object.valueOf'),
      {kind:'conversion.builtin',id:'convert',result:ref('input')});
    apply(c,lookup('convert',key('toString'),'builtin',U,'Object.toString'),
      {kind:'conversion.builtin',id:'convert',result:['str','[object Object]']},
      finish('convert',goal==='Number'?['num','NaN']:['str','[object Object]']));
  }
  const c=fresh(allocate('input'),{kind:'property.delete',object:objectPrototype,key:key('valueOf'),success:true});
  apply(c,begin('convert','Number'),lookup('convert',exotic));
  refuse(c,lookup('convert',key('valueOf'),'builtin',U,'Object.valueOf'),/false primitive conversion lookup/);
  apply(c,lookup('convert',key('valueOf')),lookup('convert',key('toString'),'builtin',U,'Object.toString'),
    {kind:'conversion.builtin',id:'convert',result:['str','[object Object]']},finish('convert',['num','NaN']));
});

test('shared conversion getters capture their result once and call it with the original input receiver',()=>{
  for(const goal of ['Number','PropertyKey']){
    const name=goal==='Number'?'valueOf':'toString',value=goal==='Number'?['num',7]:['str','key'];
    const c=fresh(allocate('input'),allocate('getter','closure'),allocate('method','closure'),allocate('replacement','closure'),
      define(objectPrototype,name,accessor(ref('getter'))));
    apply(c,begin('convert',goal),lookup('convert',exotic));
    refuse(c,lookup('convert',key(name),'builtin',U,goal==='Number'?'Object.valueOf':'Object.toString'),/false primitive conversion lookup/);
    apply(c,lookup('convert',key(name),'accessor',ref('getter')),{kind:'conversion.getter.call',id:'convert',child:'getterCall'});
    assert.deepEqual(c.receiver,ref('input'));assert.deepEqual(c.protocol.callFrames.at(-1).arguments,[]);
    apply(c,define(objectPrototype,name,data(ref('replacement'))));
    returned(c,'convert','getterCall',ref('method'),true);
    apply(c,{kind:'conversion.call',id:'convert',child:'methodCall'});
    assert.deepEqual(c.receiver,ref('input'));assert.equal(c.frameFunctions.get('methodCall'),'method');
    returned(c,'convert','methodCall',value);apply(c,finish('convert',value));
  }
});

test('ordinary conversion re-reads the mutated shared fallback after a nonprimitive first result',()=>{
  const c=fresh(allocate('input'),allocate('first','closure'),allocate('old','closure'),allocate('fresh','closure'),
    define(objectPrototype,'valueOf',data(ref('first'))),define(objectPrototype,'toString',data(ref('old'))));
  apply(c,begin('convert','Number'),lookup('convert',exotic),lookup('convert',key('valueOf'),'data',ref('first')),
    {kind:'conversion.call',id:'convert',child:'firstCall'},define(objectPrototype,'toString',data(ref('fresh'))));
  returned(c,'convert','firstCall',ref('input'));
  refuse(c,lookup('convert',key('toString'),'data',ref('old')),/false primitive conversion lookup/);
  apply(c,lookup('convert',key('toString'),'data',ref('fresh')),{kind:'conversion.call',id:'convert',child:'secondCall'});
  assert.deepEqual(c.receiver,ref('input'));returned(c,'convert','secondCall',['str','9']);apply(c,finish('convert',['num',9]));
});

test('Array conversion inherits live Object valueOf while retaining Array toString precedence',()=>{
  const c=fresh(allocate('input','array'),allocate('method','closure'),define(objectPrototype,'valueOf',data(ref('method'))),
    define(objectPrototype,'toString',data(ref('method'))));
  apply(c,begin('number','Number'),lookup('number',exotic),lookup('number',key('valueOf'),'data',ref('method')),
    {kind:'conversion.call',id:'number',child:'valueOfCall'});
  assert.deepEqual(c.receiver,ref('input'));returned(c,'number','valueOfCall',['num',7]);apply(c,finish('number',['num',7]));
  apply(c,begin('key','PropertyKey'),lookup('key',exotic),lookup('key',key('toString'),'builtin',U,'Array.toString'),
    {kind:'conversion.builtin',id:'key',result:['str','5']},finish('key',['str','5']));
});

test('unsupported intrinsic conversion callables cannot become a skipped method or fabricated TypeError',()=>{
  for(const property of [exotic,key('valueOf')]){
    const c=fresh(allocate('input'),define('input',property,data(intrinsic('Promise.prototype.then'))));
    apply(c,begin('convert','Number'));if(property!==exotic)apply(c,lookup('convert',exotic));
    refuse(c,lookup('convert',property,'data',intrinsic('Promise.prototype.then')),/intrinsic.*conversion.*callable|conversion.*callable.*protocol/i);
  }
  const c=fresh(allocate('input'),define('input',exotic,data(['num',1])));
  apply(c,begin('convert','Number'),lookup('convert',exotic,'data',['num',1]));
  const changed=structuredClone(c.protocol.primitiveConversions),row=changed.operations[0];
  row.method=intrinsic('Promise.prototype.then');row.candidate=structuredClone(row.method);
  assert.throws(()=>restorePrimitiveConversionStateV8(c,changed,PROTOCOL_MACHINE_API_V8),/intrinsic.*conversion.*callable|conversion.*callable.*protocol/i);
});

test('the retained Number component reads shared methods and keeps its getter boundary explicit',()=>{
  const c=fresh(allocate('input'),allocate('method','closure'),define(objectPrototype,'valueOf',data(ref('method'))));
  apply(c,{kind:'number.begin',id:'convert',value:ref('input')},
    {kind:'number.select',id:'convert',key:exotic,method:U,builtin:null});
  refuse(c,{kind:'number.select',id:'convert',key:key('valueOf'),method:U,builtin:'Object.valueOf'},/false Number/);
  apply(c,{kind:'number.select',id:'convert',key:key('valueOf'),method:ref('method'),builtin:null},
    {kind:'number.call',id:'convert',child:'methodCall'});
  assert.deepEqual(c.receiver,ref('input'));
  apply(c,{kind:'return',invocation:'methodCall',value:['num',7]},
    {kind:'number.return',id:'convert',value:['num',7]},{kind:'number.finish',id:'convert',result:['num',7]});
  const getter=fresh(allocate('input'),allocate('method','closure'),define(objectPrototype,'valueOf',accessor(ref('method'))));
  apply(getter,{kind:'number.begin',id:'convert',value:ref('input')},
    {kind:'number.select',id:'convert',key:exotic,method:U,builtin:null});
  refuse(getter,{kind:'number.select',id:'convert',key:key('valueOf'),method:U,builtin:'Object.valueOf'},/accessor needs its getter continuation/);
});

test('original shared Object prototype mutation sources retain an explicit owned-runtime profile boundary',()=>{
  const cases=[
    ['const input={x:7};Object.prototype.valueOf=function(){return this.x;};return Number(input);',7,/Not a writable guest object/],
    ['let log="";const input={x:7};Object.defineProperty(Object.prototype,"valueOf",{configurable:true,get(){log+="g";return function(){log+="m";return this.x;};}});return [Number(input),log];',[7,'gm'],/Object.defineProperty requires owned ordinary storage/],
    ['const input={};Object.prototype.toString=function(){return "key";};return Reflect.ownKeys({[input]:1})[0];','key',/Not a writable guest object/],
    ['let log="";const input={x:"key"};Object.defineProperty(Object.prototype,"toString",{configurable:true,get(){log+="g";return function(){log+="m";return this.x;};}});return [Reflect.ownKeys({[input]:1})[0],log];',['key','gm'],/Object.defineProperty requires owned ordinary storage/],
    ['Object.prototype.valueOf=function(){return this[0];};return Number([7]);',7,/Not a writable guest object/]
  ];
  for(const [body,expected,pattern]of cases){
    const source='"use strict";function run(){try{'+body+'}catch(error){return "guest catch";}}';
    const native=vm.runInNewContext(source+';run()',{}, {timeout:1000});
    assert.deepEqual(JSON.parse(JSON.stringify(native)),expected);
    const runtime=createRuntime().startEntry({text:source,functionName:'run'});
    assert.throws(()=>runtime.drive(),pattern);
  }
});
