import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applyProtocolRecordV8,createProtocolStateV8,snapshotProtocolStateV8,
  restoreProtocolStateV8,assertProtocolDetailCompatible,protocolOrdinaryHeapViewV8,
  protocolReservedIdentitiesV8,PROTOCOL_V8_LIMITS} from '../src/semantic/protocol-state-v8.js';
import {encodeProtocolRecordV8,decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const clone=structuredClone,lit=value=>({op:'literal',value}),local=name=>({op:'local',name});
const binary=(operator,left,right)=>({op:'binary',operator,left,right});
function controller(){return {
  heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],
  stack:['invocation1'],frameFunctions:new Map([['invocation1','run']]),
  pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8(),
  ready:[],effects:new Map(),jobs:new Map(),strictRequests:false
};}
function allocation(name,properties=[],extra={}){return {
  kind:'allocate',name,objectKind:'object',length:null,properties,code:null,captures:[],
  functionKind:null,lexicalReceiver:null,...extra
};}
function apply(c,...records){for(const record of records)applyProtocolRecordV8(c,record);return c;}
function data(value,flags={}){return {kind:'data',value,writable:true,enumerable:true,configurable:true,...flags};}
function define(object,key,descriptor,success=true){return {kind:'property.define',object,key,descriptor,success};}
function read(object,key,result){return {kind:'property.get',object,key,receiver:['ref',object],result};}
function set(object,key,value,success=true){return {kind:'property.set',object,key,receiver:['ref',object],value,success};}
function wire(c){return JSON.parse(JSON.stringify({
  heap:[...c.heap].map(([id,node])=>[id,{...node,properties:[...node.properties],
    ...(node.descriptors?{descriptors:[...node.descriptors]}:{})}]),locals:[...c.locals],
  captureAliases:[...c.captureAliases],receiver:c.receiver,stack:c.stack,frameFunctions:[...c.frameFunctions],
  pending:c.pending,lastReturn:c.lastReturn,completion:c.completion,protocol:snapshotProtocolStateV8(c)
}));}
function restore(packet){const c=controller(),p=clone(packet);
  for(const key of ['receiver','stack','pending','lastReturn','completion'])c[key]=p[key];
  c.locals=new Map(p.locals);c.captureAliases=new Map(p.captureAliases);c.frameFunctions=new Map(p.frameFunctions);
  c.heap=new Map(p.heap.map(([id,node])=>[id,{...node,properties:new Map(node.properties),
    ...(node.descriptors?{descriptors:new Map(node.descriptors)}:{})}]));
  restoreProtocolStateV8(c,p.protocol);return c;
}

test('fresh Symbols, registry identity, descriptions and binary64 computations are independently checked',()=>{
  const c=controller();apply(c,
    {kind:'symbol.create',id:'o1',description:['str','same']},
    {kind:'symbol.create',id:'o2',description:['str','same']},
    {kind:'symbol.create',id:'o3',description:['undefined']},
    {kind:'symbol.for',id:'o4',key:'shared'},
    {kind:'symbol.for',id:'o4',key:'shared'},
    {kind:'compute',expr:binary('===',lit(['symbol','o1']),lit(['symbol','o2'])),result:['bool',false],bind:'distinct'},
    {kind:'symbol.read',symbol:['symbol','o4'],operation:'keyFor',result:['str','shared'],bind:'registryKey'},
    {kind:'symbol.read',symbol:['symbol','o3'],operation:'description',result:['undefined'],bind:null},
    {kind:'symbol.read',symbol:['symbol','o3'],operation:'toString',result:['str','Symbol()'],bind:null},
    {kind:'symbol.read',symbol:['symbol','well-known:iterator'],operation:'description',result:['str','Symbol.iterator'],bind:null},
    {kind:'compute',expr:binary('/',lit(['num',1]),lit(['num','-0'])),result:['num','-Infinity'],bind:'division'},
    {kind:'choose',expr:lit(['num',0]),decision:['num',0],path:'else'});
  assert.equal(Symbol('same')===Symbol('same'),c.locals.get('distinct')[1]);
  assert.equal(Symbol.keyFor(Symbol.for('shared')),c.locals.get('registryKey')[1]);
  assert(protocolReservedIdentitiesV8(c).has('o1'));
  for(const record of [
    {kind:'symbol.for',id:'o5',key:'shared'},
    {kind:'symbol.create',id:'o1',description:['str','same']},
    allocation('o2'),
    {kind:'bind',name:'unknown',value:['symbol','o999']},
    {kind:'compute',expr:binary('+',lit(['symbol','o1']),lit(['num',1])),result:['num',1],bind:null},
    {kind:'compute',expr:binary('+',lit(['num',1]),lit(['num',2])),result:['num',4],bind:null},
    {kind:'choose',expr:lit(['num',0]),decision:['num',0],path:'then'}
  ]){const before=wire(c);assert.throws(()=>apply(c,record));assert.deepEqual(wire(c),before);}
});

test('logical choices check the current left operand and operator before right-hand work',()=>{
  const c=controller();apply(c,allocation('o1'));
  const cases=[
    [['undefined'],false,true],[['null'],false,true],[['bool',false],false,false],
    [['num',0],false,false],[['num','-0'],false,false],[['num','NaN'],false,false],
    [['str',''],false,false],[['bigint','0'],false,false],
    [['num',1],true,false],[['str','yes'],true,false],[['bigint','1'],true,false],
    [['ref','o1'],true,false],[['symbol','well-known:iterator'],true,false]
  ];
  for(const [value,truthy,nullish]of cases)for(const operator of ['&&','||','??']){
    const skip=operator==='&&'?!truthy:operator==='||'?truthy:!nullish;
    apply(c,{kind:'bind',name:'left',value});
    const record={kind:'choose',expr:{op:'logical-test',operator,arg:local('left')},
      decision:['bool',skip],path:skip?'use-left':'evaluate-right'};
    assert.deepEqual(decodeProtocolRecordV8(encodeProtocolRecordV8(record)),record);
    apply(c,record);
    for(const changed of [
      {...record,path:skip?'evaluate-right':'use-left'},
      {...record,decision:['bool',!skip]},
      {...record,expr:lit(['bool',skip])},
      {...record,expr:{...record.expr,arg:local('futureRight')}}
    ]){const before=wire(c);assert.throws(()=>apply(c,changed));assert.deepEqual(wire(c),before);}
  }
});

test('tagged keys keep NUL strings disjoint and preserve ECMAScript own-key order and filtering',()=>{
  const c=controller();apply(c,
    {kind:'symbol.create',id:'o1',description:['str','s']},allocation('o2'),
    define('o2',['str','z'],data(['num',1])),
    define('o2',['symbol','o1'],data(['num',2])),
    define('o2',['str','2'],data(['num',3])),
    define('o2',['str','1'],data(['num',4])),
    define('o2',['str','\0symbol:o1'],data(['num',5])),
    define('o2',['str','hidden'],data(['num',6],{enumerable:false})),
    read('o2',['symbol','o1'],['num',2]),read('o2',['str','\0symbol:o1'],['num',5]));
  const symbol=Symbol('s'),object={z:1,[symbol]:2,2:3,1:4,'\0symbol:o1':5};
  Object.defineProperty(object,'hidden',{value:6,enumerable:false,configurable:true,writable:true});
  const key=value=>typeof value==='symbol'?['symbol','o1']:['str',value];
  for(const [mode,keys]of [
    ['own',Reflect.ownKeys(object)],['strings',Object.getOwnPropertyNames(object)],
    ['symbols',Object.getOwnPropertySymbols(object)],['enumerable-strings',Object.keys(object)]
  ])apply(c,{kind:'property.keys',object:'o2',mode,name:'keys_'+mode,keys:keys.map(key)});
  apply(c,{kind:'property.delete',object:'o2',key:['str','z'],success:true},
    define('o2',['str','z'],data(['num',7])));
  const keys=['1','2','\0symbol:o1','hidden','z'].map(value=>['str',value]);keys.push(['symbol','o1']);
  apply(c,{kind:'property.keys',object:'o2',mode:'own',name:'after_delete',keys});
  assert.throws(()=>apply(c,{kind:'property.keys',object:'o2',mode:'own',name:'wrong',keys:[...keys].reverse()}),/order/);
});

test('restored Symbol descriptors retain readonly flags, ordering and exact value ownership',()=>{
  const c=controller();apply(c,{kind:'symbol.create',id:'o1',description:['str','fixed']},allocation('o2'),
    define('o2',['symbol','o1'],data(['num',3],{writable:false,configurable:false})),
    {kind:'property.preventExtensions',object:'o2'});
  const resumed=restore(wire(c));
  apply(resumed,set('o2',['symbol','o1'],['num',4],false),
    define('o2',['symbol','o1'],data(['num',4],{writable:false,configurable:false}),false),
    {kind:'property.delete',object:'o2',key:['symbol','o1'],success:false},
    define('o2',['str','new'],data(['bool',true]),false),read('o2',['symbol','o1'],['num',3]));
  const before=wire(resumed);
  assert.throws(()=>apply(resumed,set('o2',['symbol','o1'],['num',4],true)),/false property/);
  assert.deepEqual(wire(resumed),before);
  const corrupt=wire(c);corrupt.heap[0][1].descriptors.push(clone(corrupt.heap[0][1].descriptors[0]));
  assert.throws(()=>restore(corrupt),/duplicate semantic descriptor/);
  const missing=wire(c);missing.heap[0][1].properties=[];
  assert.throws(()=>restore(missing),/missing its value/);
});

test('prototype resolution, receiver writes and descriptor invariants use the single shared heap',()=>{
  const c=controller();apply(c,allocation('proto'),allocation('object'),
    define('proto',['str','x'],data(['num',2])),
    {kind:'property.prototype',object:'object',prototype:['ref','proto'],success:true},
    read('object',['str','x'],['num',2]),set('object',['str','x'],['num',5]),
    read('proto',['str','x'],['num',2]),read('object',['str','x'],['num',5]),
    {kind:'property.prototype',object:'proto',prototype:['ref','object'],success:false},
    {kind:'property.preventExtensions',object:'object'},
    {kind:'property.prototype',object:'object',prototype:null,success:false});
  assert.throws(()=>protocolOrdinaryHeapViewV8(c),/ordinary data heap/);
  assert.throws(()=>assertProtocolDetailCompatible(c,{kind:'read',fields:{object:'object',key:'x'}}),/bypasses/);
  assert.equal(assertProtocolDetailCompatible(c,{kind:'compute',fields:{expr:binary('+',lit(['num',2]),lit(['num',3])),result:['num',5]}}),true);
  assert.throws(()=>apply(c,read('proto',['str','toString'],['undefined'])),/intrinsic/);
});

function accessorController(){const c=controller();apply(c,
  {kind:'bind',name:'captured',value:['num',0]},
  {kind:'bind',name:'parent',value:['num',20]},
  allocation('object',[{key:['str','base'],value:['num',3]}]),
  allocation('getter',[],{objectKind:'closure',code:'get',captures:[{binding:'count',cell:'captured'}],functionKind:'ordinary'}),
  allocation('setter',[],{objectKind:'closure',code:'set',captures:[{binding:'count',cell:'captured'}],functionKind:'ordinary'}),
  {kind:'symbol.create',id:'o1',description:['str','value']},
  define('object',['symbol','o1'],{kind:'accessor',get:['ref','getter'],set:['ref','setter'],enumerable:false,configurable:true}));
  c.captureAliases=new Map([['count','parent']]);return c;
}
test('accessor calls preserve this, live captures, argument cells, checkpoint scope and setter assignment completion',()=>{
  let c=accessorController();apply(c,{kind:'property.get.call',id:'access1',child:'get1',object:'object',key:['symbol','o1'],receiver:['ref','object']});
  assert.deepEqual(c.receiver,['ref','object']);assert.equal(c.captureAliases.get('count'),'captured');
  c=restore(wire(c));
  apply(c,read('object',['str','base'],['num',3]),
    {kind:'compute',expr:binary('+',local('count'),lit(['num',1])),result:['num',1],bind:'count'},
    {kind:'return',invocation:'get1',value:['num',3]});
  assert.deepEqual(c.receiver,['undefined']);assert.equal(c.captureAliases.get('count'),'parent');
  assert.throws(()=>apply(c,{kind:'bind',name:'tooEarly',value:['num',1]}),/completion must be consumed/);
  apply(c,{kind:'property.finish',id:'access1',completion:{kind:'normal',value:['num',3]}},
    {kind:'property.set.call',id:'access2',child:'set1',object:'object',key:['symbol','o1'],receiver:['ref','object'],value:['num',8]});
  assert.deepEqual(c.locals.get('set1:argument:0'),['num',8]);
  apply(c,{kind:'compute',expr:binary('+',local('count'),local('set1:argument:0')),result:['num',9],bind:'count'},
    set('object',['str','base'],['num',8]),{kind:'return',invocation:'set1',value:['num',999]});
  const before=wire(c);assert.throws(()=>apply(c,{kind:'property.finish',id:'access2',completion:{kind:'normal',value:['num',999]}}),/false property completion/);
  assert.deepEqual(wire(c),before);
  apply(c,{kind:'property.finish',id:'access2',completion:{kind:'normal',value:['num',8]}});
  assert.deepEqual(c.locals.get('captured'),['num',9]);assert.deepEqual(c.locals.get('parent'),['num',20]);
  assert.equal(c.protocol.callFrames.length,0);assert.equal(c.protocol.pendingCalls.length,0);
});

test('accessor abrupt completion dominates assignment and cannot be replaced with the assignment value',()=>{
  const c=accessorController();apply(c,
    {kind:'property.set.call',id:'access',child:'setter1',object:'object',key:['symbol','o1'],receiver:['ref','object'],value:['num',8]},
    {kind:'throw',invocation:'setter1',value:['str','failure']});
  assert.throws(()=>apply(c,{kind:'property.finish',id:'access',completion:{kind:'normal',value:['num',8]}}),/false property completion/);
  apply(c,{kind:'property.finish',id:'access',completion:{kind:'throw',value:['str','failure']}},
    {kind:'throw',invocation:'invocation1',value:['str','failure']},{kind:'end',completion:'throw'});
  assert.deepEqual(c.completion,{kind:'throw',value:['str','failure']});
});

test('arrow receiver capture differs from a dynamic method receiver and scoped detail calls cannot bypass restoration',()=>{
  const c=controller();apply(c,allocation('outer'),allocation('receiver'),
    allocation('arrow',[],{objectKind:'closure',code:'arrow',functionKind:'arrow',lexicalReceiver:['ref','outer']}),
    {kind:'call',child:'arrow1',callee:['ref','arrow'],receiver:['ref','receiver'],arguments:[]});
  assert.deepEqual(c.receiver,['ref','outer']);
  assert.throws(()=>assertProtocolDetailCompatible(c,{kind:'return',fields:{value:['num',1]}}),/scoped/);
  apply(c,{kind:'return',invocation:'arrow1',value:['ref','outer']});
  assert.deepEqual(c.receiver,['undefined']);
});

test('nested protocol completions preserve their active scheduler job and restore the parent call scope',()=>{
  for(const kind of ['return','throw']){
    const c=controller();apply(c,
      {kind:'bind',name:'captured',value:['num',1]},
      allocation('receiver'),
      allocation('helper',[],{objectKind:'closure',code:'helper',functionKind:'ordinary',captures:[{binding:'value',cell:'captured'}]}));
    c.activeJob='job1';c.captureAliases=new Map([['parent','captured']]);
    const before=wire(c);
    assert.throws(()=>apply(c,{kind,invocation:'invocation1',value:['num',2]}),/scheduler profile/);
    assert.deepEqual(wire(c),before);
    apply(c,{kind:'call',child:'helper1',callee:['ref','helper'],receiver:['ref','receiver'],arguments:[]});
    assert.deepEqual(c.receiver,['ref','receiver']);
    assert.equal(c.captureAliases.get('value'),'captured');
    assert.throws(()=>assertProtocolDetailCompatible(c,{kind,fields:{value:['num',2]}}),/scoped/);
    apply(c,{kind,invocation:'helper1',value:['num',2]});
    assert.equal(c.activeJob,'job1');assert.deepEqual(c.stack,['invocation1']);
    assert.deepEqual(c.receiver,['undefined']);assert.deepEqual([...c.captureAliases],[['parent','captured']]);
    assert.deepEqual(c.lastReturn,{kind,value:['num',2]});assert.equal(c.protocol.callFrames.length,0);
    assert.throws(()=>apply(c,{kind,invocation:'invocation1',value:['num',2]}),/scheduler profile/);
  }
});

test('canonical protocol records refuse unknown fields, noncanonical JSON and observing inputs',()=>{
  const record={kind:'symbol.create',id:'o1',description:['str','x']},line=encodeProtocolRecordV8(record);
  assert.deepEqual(decodeProtocolRecordV8(line),record);
  assert.throws(()=>decodeProtocolRecordV8(line+' '),/noncanonical/);
  assert.throws(()=>encodeProtocolRecordV8({...record,origin:'private'}),/fields/);
  let observed=0;const getter={get kind(){observed++;return 'symbol.create';},id:'o1',description:['str','x']};
  assert.throws(()=>encodeProtocolRecordV8(getter));
  // A malicious discriminator is rejected before any getter is invoked.
  assert.equal(observed,0);
  for(const kind of [null,0,['return'],{toString(){observed++;return 'return';}},'toString','__proto__'])
    assert.throws(()=>encodeProtocolRecordV8({kind,value:['num',1],invocation:'invocation1'}),/record kind/);
  assert.equal(observed,0,'record dispatch must not coerce a supplied discriminator');
});

test('property capacity counts data, accessors and array length while allowing existing writes',()=>{
  const count=PROTOCOL_V8_LIMITS.properties,c=controller(),properties=Array.from({length:count-1},(_,i)=>({key:['str','p'+i],value:['num',i]}));
  apply(c,allocation('object',properties),
    define('object',['str','accessor'],{kind:'accessor',get:['undefined'],set:['undefined'],enumerable:true,configurable:true}));
  apply(c,set('object',['str','p0'],['num',7]),
    define('object',['str','accessor'],data(['num',8])));
  assert.equal(c.heap.get('object').properties.size,count);
  const before=wire(c);
  for(const record of [set('object',['str','extra'],['num',9]),define('object',['str','extra'],data(['num',9]))]){
    assert.throws(()=>apply(c,record),/property count bound/);assert.deepEqual(wire(c),before);
  }
  apply(c,{kind:'property.delete',object:'object',key:['str','p0'],success:true},set('object',['str','extra'],['num',9]));
  assert.equal(restore(wire(c)).heap.get('object').properties.size,count);
  const oversized=wire(c);oversized.heap[0][1].properties.push(['forged',['num',1]]);
  assert.throws(()=>restore(oversized),/property count bound/);

  const array=controller(),items=Array.from({length:count-1},(_,i)=>({key:['str',String(i)],value:['num',i]}));
  apply(array,allocation('array',items,{objectKind:'array',length:count-1}));
  const arrayBefore=wire(array);
  assert.throws(()=>apply(array,set('array',['str',String(count-1)],['num',9])),/property count bound/);
  assert.deepEqual(wire(array),arrayBefore,'failed array growth preserves its length');
  assert.throws(()=>apply(array,allocation('too-large',[...items,{key:['str',String(count-1)],value:['num',9]}],
    {objectKind:'array',length:count})),/property count bound/);
  assert.deepEqual(wire(array),arrayBefore);
});

test('detailed writes cannot bypass protocol property capacity or leave descriptor order stale',()=>{
  const c=controller();apply(c,allocation('object'),define('object',['str','x'],data(['num',1])));
  const before=wire(c);
  for(const fields of [
    {object:'object',key:'x',present:false,value:['undefined']},
    {object:'object',key:'x',present:true,value:['num',2]},
    {object:'object',key:'y',present:true,value:['num',2]}
  ])assert.throws(()=>assertProtocolDetailCompatible(c,{kind:'write',fields}),/descriptor\/order/);
  assert.deepEqual(wire(c),before);
  apply(c,set('object',['str','y'],['num',2]),{kind:'property.delete',object:'object',key:['str','x'],success:true});
  assert.deepEqual(wire(restore(wire(c))),wire(c));

  const ordered=controller();apply(ordered,allocation('ordered'));
  ordered.heap.get('ordered').keyOrder=[];
  assert.deepEqual(wire(restore(wire(ordered))),wire(ordered));
  assert.throws(()=>assertProtocolDetailCompatible(ordered,{kind:'write',fields:{object:'ordered',key:'x',present:true,value:['num',1]}}),/descriptor\/order/);

  const count=PROTOCOL_V8_LIMITS.properties,full=controller(),properties=Array.from({length:count},(_,i)=>({key:['str','p'+i],value:['num',i]}));
  apply(full,allocation('full',properties));
  assert.equal(assertProtocolDetailCompatible(full,{kind:'write',fields:{object:'full',key:'p0',present:true,value:['num',9]}}),true);
  assert.throws(()=>assertProtocolDetailCompatible(full,{kind:'write',fields:{object:'full',key:'extra',present:true,value:['num',9]}}),/property count bound/);
  assert.throws(()=>assertProtocolDetailCompatible(full,{kind:'allocate',fields:{name:'new',kind:'array',length:count,
    properties:properties.map(({key,value})=>({key:key[1],value}))}}),/property count bound/);
});

test('versioned protocol fixtures replay through canonical bytes and retain checkpoint identity',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/semantic-protocol-v8.json',import.meta.url),'utf8'));
  assert.equal(fixture.schema,'semantic-protocol-fixtures/1');
  for(const row of fixture.cases){let c=restore(row.initialState);
    row.lines.forEach((line,index)=>{apply(c,decodeProtocolRecordV8(line));if(row.checkpoints.includes(index+1))c=restore(wire(c));});
    assert.deepEqual(wire(c),row.expected,row.id);
  }
});


test('null prototypes have no intrinsic fallback and detail allocation cannot steal a Symbol identity',()=>{
  const c=controller();apply(c,{kind:'symbol.create',id:'o1',description:['str','key']},allocation('object'),
    {kind:'property.prototype',object:'object',prototype:null,success:true},
    read('object',['str','toString'],['undefined']),read('object',['str','constructor'],['undefined']));
  assert.equal(restore(wire(c)).heap.get('object').prototype,null);
  assert.throws(()=>assertProtocolDetailCompatible(c,{kind:'allocate',fields:{name:'o1'}}),/reserved Symbol/);
  assert.throws(()=>assertProtocolDetailCompatible(c,{kind:'call',fields:{child:'child',callee:'unknown',receiver:['undefined'],arguments:[]}}),/scoped/);
  const nested=controller();delete nested.protocol;nested.stack.push('legacyChild');
  assert.throws(()=>apply(nested,{kind:'symbol.create',id:'o2',description:['str','key']}),/unmodeled nested/);
});
