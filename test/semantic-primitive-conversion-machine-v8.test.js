import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProtocolRecordV8,createProtocolStateV8,restoreProtocolStateV8,PROTOCOL_MACHINE_API_V8} from '../src/semantic/protocol-state-v8.js';
import {validateProtocolValueV8,encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {PRIMITIVE_CONVERSION_RECORD_FIELDS,PRIMITIVE_CONVERSION_FAULTS_V8,
  validatePrimitiveConversionRecordV8,assertPrimitiveConversionNextV8,applyPrimitiveConversionRecordV8,
  restorePrimitiveConversionStateV8} from '../src/semantic/protocol-primitive-conversion-v8.js';

const copy=structuredClone,undefinedValue=['undefined'],exotic=['symbol','well-known:toPrimitive'];
const allocation=(name,properties=[],extra={})=>({kind:'allocate',name,objectKind:'object',length:null,properties,
  code:null,captures:[],functionKind:null,lexicalReceiver:null,...extra});
const closure=(name,extra={})=>allocation(name,[],{objectKind:'closure',code:name,captures:[],functionKind:'ordinary',...extra});
const data=value=>({kind:'data',value,writable:true,enumerable:true,configurable:true});
const define=(object,key,descriptor)=>({kind:'property.define',object,key,descriptor,success:true});
const lookup=(id,key,descriptor='missing',value=undefinedValue,builtin=null)=>({kind:'conversion.lookup',id,key,descriptor,value,builtin});
const begin=(id,goal,value)=>({kind:'conversion.begin',id,goal,value});
const end=(id,result)=>({kind:'conversion.finish',id,result});
function controller(){return {heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:undefinedValue,
  stack:['invocation1'],frameFunctions:new Map([['invocation1','run']]),pending:null,lastReturn:null,completion:null,
  protocol:{...createProtocolStateV8(),primitiveConversions:null},ready:[],effects:new Map(),jobs:new Map(),strictRequests:false};}
// The same component transitions are now also registered by the public API.
// This helper preserves atomic mutation checks for individual component probes.
function apply(c,...records){for(const record of records){
  const staged=copy(c);assertPrimitiveConversionNextV8(staged,record,PROTOCOL_MACHINE_API_V8);
  if(Object.hasOwn(PRIMITIVE_CONVERSION_RECORD_FIELDS,record.kind)){
    validatePrimitiveConversionRecordV8(record,{value:validateProtocolValueV8});
    applyPrimitiveConversionRecordV8(staged,record,PROTOCOL_MACHINE_API_V8);staged.protocol.sequence++;
  }else applyProtocolRecordV8(staged,record);
  Object.assign(c,staged);restorePrimitiveConversionStateV8(c,c.protocol.primitiveConversions,PROTOCOL_MACHINE_API_V8);
}return c;}
const row=c=>c.protocol.primitiveConversions.operations.at(-1);
function refuse(c,record,pattern){const before=copy(c);assert.throws(()=>apply(c,record),pattern);assert.deepEqual(c,before);}
function returnValue(c,id,child,value,{getter=false}={}){apply(c,{kind:'return',invocation:child,value},
  {kind:getter?'conversion.getter.return':'conversion.return',id,value});}
function ordinary(c,id,goal='PropertyKey'){
  apply(c,begin(id,goal,['ref','input']),lookup(id,exotic));
}

test('both conversion goals independently finish scalar leaves and preserve Symbol identities',()=>{
  const c=controller();apply(c,{kind:'symbol.create',id:'o1',description:['str','key']});
  const cases=[
    [undefinedValue,['num','NaN'],['str','undefined']],[['null'],['num',0],['str','null']],
    [['bool',false],['num',0],['str','false']],[['num','-0'],['num','-0'],['str','0']],
    [['str',' 2.5 '],['num',2.5],['str',' 2.5 ']],[['bigint','9007199254740993'],['num',9007199254740992],['str','9007199254740993']]
  ];let next=0;
  for(const [input,numeric,key]of cases)for(const [goal,result]of [['Number',numeric],['PropertyKey',key]]){
    const id='scalar'+(++next);apply(c,begin(id,goal,input));
    refuse(c,end(id,['str','invented']),/false primitive scalar/);apply(c,end(id,result));assert.deepEqual(row(c).result,result);
  }
  apply(c,begin('symbolKey','PropertyKey',['symbol','o1']),end('symbolKey',['symbol','o1']));
  assert.deepEqual(row(c).candidate,['symbol','o1']);
  apply(c,begin('symbolNumber','Number',['symbol','o1']));assert.equal(row(c).fault,'symbol-to-number');
  refuse(c,end('symbolNumber',['num',0]),/requires conversion.fault/);
  apply(c,{kind:'conversion.fault',id:'symbolNumber',error:'typeError'});
  assert.deepEqual(c.heap.get('typeError').properties.get('message'),['str',PRIMITIVE_CONVERSION_FAULTS_V8['symbol-to-number']]);
  assert.deepEqual(c.lastReturn,{kind:'throw',value:['ref','typeError']});
});

test('goal derives method order and callback hint, including snapshot refusal after field mutation',()=>{
  for(const goal of ['Number','PropertyKey']){
    const c=controller();apply(c,closure('method'),allocation('input',[{key:exotic,value:['ref','method']}]));
    apply(c,begin('convert',goal,['ref','input']));
    refuse(c,lookup('convert',['str','valueOf'],'data',['ref','method']),/method order/);
    refuse(c,lookup('convert',exotic,'missing'),/false primitive conversion lookup/);
    apply(c,lookup('convert',exotic,'data',['ref','method']),{kind:'conversion.call',id:'convert',child:'methodCall'});
    assert.deepEqual(c.protocol.callFrames.at(-1).arguments,[['str',goal==='Number'?'number':'string']]);
    assert.deepEqual(c.receiver,['ref','input']);
    for(const mutate of [p=>{p.goal=goal==='Number'?'PropertyKey':'Number';},p=>{p.index=0;},p=>{p.child='invocation1';},p=>{p.lookupKind='missing';}]){
      const snapshot=copy(c.protocol.primitiveConversions);mutate(snapshot.operations[0]);
      assert.throws(()=>restorePrimitiveConversionStateV8(c,snapshot,PROTOCOL_MACHINE_API_V8));
    }
    returnValue(c,'convert','methodCall',['str','7']);apply(c,end('convert',goal==='Number'?['num',7]:['str','7']));
  }
});

test('getter result is captured once despite live descriptor replacement and call receiver is retained',()=>{
  const c=controller();apply(c,closure('getter'),closure('returnedMethod'),closure('replacement'),allocation('input'),
    define('input',['str','toString'],{kind:'accessor',get:['ref','getter'],set:undefinedValue,enumerable:true,configurable:true}));
  ordinary(c,'convert');apply(c,lookup('convert',['str','toString'],'accessor',['ref','getter']),
    {kind:'conversion.getter.call',id:'convert',child:'getterCall'});
  assert.deepEqual(c.protocol.callFrames.at(-1).arguments,[]);
  apply(c,define('input',['str','toString'],data(['ref','replacement'])));
  returnValue(c,'convert','getterCall',['ref','returnedMethod'],{getter:true});
  assert.equal(row(c).child,null);assert.deepEqual(row(c).method,['ref','returnedMethod']);
  refuse(c,lookup('convert',['str','toString'],'data',['ref','replacement']),/requires conversion.call/);
  refuse(c,{kind:'conversion.call',id:'convert',child:'getterCall'},/duplicate invocation/);
  apply(c,{kind:'conversion.call',id:'convert',child:'methodCall'});
  assert.equal(c.frameFunctions.get('methodCall'),'returnedMethod');assert.deepEqual(c.receiver,['ref','input']);
  returnValue(c,'convert','methodCall',['str','x']);apply(c,end('convert',['str','x']));
});

test('ordinary fallback performs a fresh live lookup after the first method mutates the fallback',()=>{
  const c=controller();apply(c,closure('first'),closure('old'),closure('fresh'),allocation('nonprimitive'),allocation('input',[
    {key:['str','toString'],value:['ref','first']},{key:['str','valueOf'],value:['ref','old']} ]));
  ordinary(c,'convert');apply(c,lookup('convert',['str','toString'],'data',['ref','first']),{kind:'conversion.call',id:'convert',child:'firstCall'},
    define('input',['str','valueOf'],data(['ref','fresh'])));
  returnValue(c,'convert','firstCall',['ref','nonprimitive']);assert.equal(row(c).phase,'lookup');assert.equal(row(c).index,1);
  refuse(c,lookup('convert',['str','valueOf'],'data',['ref','old']),/false primitive conversion lookup/);
  apply(c,lookup('convert',['str','valueOf'],'data',['ref','fresh']),{kind:'conversion.call',id:'convert',child:'secondCall'});
  returnValue(c,'convert','secondCall',['str','x']);apply(c,end('convert',['str','x']));
});

test('getter and method original abrupt values retain identity through nested conversions',()=>{
  for(const getter of [true,false]){
    const c=controller();apply(c,closure('method'),allocation('thrown'),allocation('input'),define('input',['str','toString'],getter?
      {kind:'accessor',get:['ref','method'],set:undefinedValue,enumerable:true,configurable:true}:data(['ref','method'])));
    ordinary(c,'outer');apply(c,lookup('outer',['str','toString'],getter?'accessor':'data',['ref','method']),
      {kind:getter?'conversion.getter.call':'conversion.call',id:'outer',child:'child'},
      begin('inner','Number',['str','7']),end('inner',['num',7]));
    apply(c,{kind:'throw',invocation:'child',value:['ref','thrown']});
    refuse(c,{kind:'conversion.throw',id:'outer',value:['str','replacement']},/abrupt completion differs/);
    apply(c,{kind:'conversion.throw',id:'outer',value:['ref','thrown']});
    const outer=c.protocol.primitiveConversions.operations[0];assert.equal(outer.phase,'abrupt');
    assert.deepEqual(outer.result,['ref','thrown']);assert.equal(outer.child,'child');assert.equal(outer.fault,null);
  }
});

test('four fault causes are derived and fault records allocate only fresh bounded error objects atomically',()=>{
  for(const cause of ['exotic-not-callable','exotic-nonprimitive','ordinary-exhausted']){
    const c=controller();apply(c,closure('method'),allocation('input'),allocation('nonprimitive'),allocation('occupied'));
    if(cause==='exotic-not-callable'){
      apply(c,define('input',exotic,data(['num',1])),begin('convert','PropertyKey',['ref','input']),lookup('convert',exotic,'data',['num',1]));
    }else if(cause==='exotic-nonprimitive'){
      apply(c,define('input',exotic,data(['ref','method'])),begin('convert','Number',['ref','input']),lookup('convert',exotic,'data',['ref','method']),
        {kind:'conversion.call',id:'convert',child:'child'});returnValue(c,'convert','child',['ref','nonprimitive']);
    }else{
      apply(c,{kind:'property.prototype',object:'input',prototype:null,success:true});ordinary(c,'convert');
      apply(c,lookup('convert',['str','toString']),lookup('convert',['str','valueOf']));
    }
    assert.equal(row(c).fault,cause);refuse(c,{kind:'conversion.fault',id:'convert',error:'occupied'},/duplicate allocation identity/);
    refuse(c,{kind:'conversion.fault',id:'convert',error:'error',message:'invented'},/fields/);
    apply(c,{kind:'conversion.fault',id:'convert',error:'error'});
    assert.deepEqual([...c.heap.get('error').properties],[['name',['str','TypeError']],['message',['str',PRIMITIVE_CONVERSION_FAULTS_V8[cause]]]]);
    // The caught object is ordinary mutable state. A later mutation must not
    // invalidate the retained fact that conversion originally produced it.
    apply(c,define('error',['str','message'],data(['str','changed by catch'])));
  }
});

test('public fault allocations reject invalid reference identities before mutation',()=>{
  const c=controller();applyProtocolRecordV8(c,begin('convert','Number',['symbol','well-known:iterator']));
  for(const error of ['bad/name','bad name','0error',...['\n','\r','\u2028','\u2029'].map(ending=>'error'+ending)]){
    const record={kind:'conversion.fault',id:'convert',error},before=copy(c);
    assert.throws(()=>applyProtocolRecordV8(c,record),/value reference/);
    assert.deepEqual(c,before,'invalid error identities must not allocate or complete the conversion');
    assert.throws(()=>encodeProtocolRecordV8(record),/value reference/);
    restoreProtocolStateV8(c,c.protocol);
  }
  applyProtocolRecordV8(c,{kind:'conversion.fault',id:'convert',error:'typeError'});
  assert.deepEqual(c.lastReturn,{kind:'throw',value:['ref','typeError']});
  restoreProtocolStateV8(c,c.protocol);
});

test('ordinary builtin leaves use live descriptors and retain explicit accessor, join and element boundaries',()=>{
  const c=controller();apply(c,allocation('input'));
  ordinary(c,'object');apply(c,lookup('object',['str','toString'],'builtin',undefinedValue,'Object.toString'),
    {kind:'conversion.builtin',id:'object',result:['str','[object Object]']},end('object',['str','[object Object]']));
  apply(c,allocation('array',[{key:['str','0'],value:['num',7]},{key:['str','1'],value:['null']}],{objectKind:'array',length:2}));
  apply(c,begin('arrayKey','PropertyKey',['ref','array']),lookup('arrayKey',exotic),
    lookup('arrayKey',['str','toString'],'builtin',undefinedValue,'Array.toString'),
    {kind:'conversion.builtin',id:'arrayKey',result:['str','7,']},end('arrayKey',['str','7,']));
  for(const boundary of ['tag-getter','join-override','sparse','symbol-element']){
    const fresh=controller();apply(fresh,closure('getter'),allocation('input',boundary==='symbol-element'?
      [{key:['str','0'],value:['symbol','well-known:iterator']}]:[],boundary==='tag-getter'?{}:{objectKind:'array',length:1}));
    if(boundary==='tag-getter')apply(fresh,define('input',['symbol','well-known:toStringTag'],
      {kind:'accessor',get:['ref','getter'],set:undefinedValue,enumerable:true,configurable:true}));
    if(boundary==='join-override')apply(fresh,define('input',['str','join'],data(['ref','getter'])));
    ordinary(fresh,'convert');apply(fresh,lookup('convert',['str','toString'],'builtin',undefinedValue,
      boundary==='tag-getter'?'Object.toString':'Array.toString'));
    refuse(fresh,{kind:'conversion.builtin',id:'convert',result:['str','fabricated']},/getter|join override|dense own scalar/);
  }
});

test('public registry refuses unmodeled function prototype fallback and preserves its own callable hooks',()=>{
  const nativeInput=Object.create(function parent(){});
  assert.throws(()=>Reflect.ownKeys({[nativeInput]:1}),TypeError);
  assert.throws(()=>Number(nativeInput),TypeError);
  for(const goal of ['PropertyKey','Number']){
    const c=controller();
    const records=[closure('parent'),allocation('input'),
      {kind:'property.prototype',object:'input',prototype:['ref','parent'],success:true},
      begin('convert',goal,['ref','input']),lookup('convert',exotic)];
    if(goal==='Number')records.push(lookup('convert',['str','valueOf'],'builtin',undefinedValue,'Object.valueOf'),
      {kind:'conversion.builtin',id:'convert',result:['ref','input']});
    for(const record of records)applyProtocolRecordV8(c,record);
    const before=copy(c);
    assert.throws(()=>applyProtocolRecordV8(c,
      lookup('convert',['str','toString'],'builtin',undefinedValue,'Object.toString')),/function intrinsic prototype/);
    assert.deepEqual(c,before);
  }
  const c=controller();
  for(const record of [closure('parent'),closure('method'),allocation('input'),
    define('parent',['str','toString'],data(['ref','method'])),
    {kind:'property.prototype',object:'input',prototype:['ref','parent'],success:true},
    begin('convert','PropertyKey',['ref','input']),lookup('convert',exotic),
    lookup('convert',['str','toString'],'data',['ref','method']),{kind:'conversion.call',id:'convert',child:'methodCall'},
    {kind:'return',invocation:'methodCall',value:['str','key']},
    {kind:'conversion.return',id:'convert',value:['str','key']},end('convert',['str','key'])])applyProtocolRecordV8(c,record);
  assert.deepEqual(c.lastReturn,{kind:'return',value:['str','key']});
});

test('the separately retained Number component cannot bypass the same intrinsic prototype boundary',()=>{
  const c=controller();
  for(const record of [closure('parent'),allocation('input'),
    {kind:'property.prototype',object:'input',prototype:['ref','parent'],success:true},
    {kind:'number.begin',id:'convert',value:['ref','input']},
    {kind:'number.select',id:'convert',key:exotic,method:undefinedValue,builtin:null},
    {kind:'number.select',id:'convert',key:['str','valueOf'],method:undefinedValue,builtin:'Object.valueOf'},
    {kind:'number.builtin',id:'convert',result:['ref','input']}])applyProtocolRecordV8(c,record);
  const before=copy(c);
  assert.throws(()=>applyProtocolRecordV8(c,{kind:'number.select',id:'convert',key:['str','toString'],
    method:undefinedValue,builtin:'Object.toString'}),/function intrinsic prototype/);
  assert.deepEqual(c,before);
});
