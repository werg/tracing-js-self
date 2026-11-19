import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encode} from '../src/values.js';
import {createProtocolStateV8,applyProtocolRecordV8,PROTOCOL_MACHINE_API_V8 as api} from '../src/semantic/protocol-state-v8.js';
import {PROTOCOL_RECORD_V8_FIELDS,validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {GENERATOR_RECORD_FIELDS,validateGeneratorRecordV8,applyGeneratorRecordV8,restoreGeneratorStateV8,
  assertGeneratorCallV8,assertGeneratorNextV8} from '../src/semantic/protocol-generator-v8.js';

const ref=id=>['ref',id],U=['undefined'],num=n=>['num',n];
function fixture(){
  const controller={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:U,stack:['root'],
    frameFunctions:new Map([['root','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};
  function apply(record){validateGeneratorRecordV8(record,{value:validateProtocolValueV8});const staged=structuredClone(controller);
    assertGeneratorNextV8(staged,record,api);assert.equal(applyGeneratorRecordV8(staged,record,api),true);
    assert.equal(restoreGeneratorStateV8(staged,api).valid,true);Object.assign(controller,staged);}
  function detail(record){assertGeneratorNextV8(controller,record,api);applyProtocolRecordV8(controller,record);}
  function closure(id='g',captures=[]){detail({kind:'allocate',name:id,objectKind:'closure',length:null,properties:[],code:id,captures,functionKind:'ordinary',lexicalReceiver:null});}
  function define(id='g',captures=[]){closure(id,captures);apply({kind:'generator.function',object:id,prototype:id+'-prototype',name:id,length:1});}
  function create(id='it',callee='g',args=[num(3)],receiver=U){apply({kind:'generator.create',name:id,child:id+'-body',callee:ref(callee),receiver,arguments:args});}
  function start(id='it'){apply({kind:'generator.start',object:id});}
  function resume(argument=U,{id='it',method='next',bind=null}={}){apply({kind:'generator.resume',object:id,method,argument});
    if(method==='next')apply({kind:'generator.receive',object:id,bind});}
  function yielded(value,name='r0',id='it'){apply({kind:'generator.yield',object:id,value,name});return controller.heap.get(name);}
  function finish(value,name='end',kind='return',id='it'){apply({kind:'generator.finish',object:id,completion:{kind,value},name});}
  function completed(method='next',argument=U,name='done',id='it'){apply({kind:'generator.completed',object:id,method,argument,name});}
  return {controller,apply,detail,closure,define,create,start,resume,yielded,finish,completed};
}
test('generator records expose operands and semantic transitions, never archived frames',()=>{
  for(const fields of Object.values(GENERATOR_RECORD_FIELDS))assert(!fields.some(field=>['state','journal','bytecode','patches','pc','stack'].includes(field)));
  assert.throws(()=>validateGeneratorRecordV8({kind:'generator.yield',object:'it',value:num(1),name:'r',frame:{}},{value:validateProtocolValueV8}),/fields/);
});
test('generator creation start sent values yields and returns match native lifecycle',()=>{
  const f=fixture();f.define();f.create();f.start();
  function* g(n){const sent=yield n;return sent+1;}const native=g(3);
  f.resume(num(99));const first=native.next(99);f.yielded(encode(first.value));
  assert.deepEqual(f.controller.heap.get('r0').properties.get('done'),encode(first.done));
  f.resume(num(7),{bind:'sent'});assert.deepEqual(f.controller.locals.get('sent'),num(7));
  const second=native.next(7);f.finish(encode(second.value));
  f.completed();assert.deepEqual(f.controller.heap.get('done').properties.get('value'),encode(native.next().value));
  assert.equal(f.controller.heap.get('it').phase,'completed');assert.deepEqual(f.controller.stack,['root']);
  assert.equal(f.controller.heap.get('it').invocation,'it-body');assert.equal(f.controller.heap.get('it').yielded,1);
});
test('generator resume restores the same receiver and live capture aliases through nested calls',()=>{
  const f=fixture();f.detail({kind:'allocate',name:'receiver',objectKind:'object',length:null,properties:[],code:null,captures:[],functionKind:null,lexicalReceiver:null});
  f.controller.locals.set('outer:n',num(1));f.define('g',[{binding:'n',cell:'outer:n'}]);f.closure('helper');f.create('it','g',[],ref('receiver'));f.start();
  f.controller.locals.set('outer:n',num(4));f.resume();assert.deepEqual(f.controller.receiver,ref('receiver'));assert.equal(f.controller.captureAliases.get('n'),'outer:n');
  f.detail({kind:'bind',name:'n',value:num(5)});
  f.detail({kind:'call',child:'nested',callee:ref('helper'),receiver:U,arguments:[]});
  f.detail({kind:'return',invocation:'nested',value:num(8)});
  assert.deepEqual(f.controller.receiver,ref('receiver'));assert.equal(f.controller.captureAliases.get('n'),'outer:n');
  f.yielded(num(5));assert.deepEqual(f.controller.receiver,U);assert.equal(f.controller.captureAliases.size,0);
  f.controller.locals.set('outer:n',num(9));f.resume();assert.deepEqual(f.controller.locals.get(f.controller.captureAliases.get('n')),num(9));f.finish(num(9));
});
test('return and throw before start and after yield preserve exact completion without running extra work',()=>{
  for(const method of ['return','throw']){
    const f=fixture();f.define();f.create();f.start();
    const native=(function*(){throw new Error('must not enter body');})();
    if(method==='return'){const result=native.return(7);f.completed(method,num(7),'result');assert.deepEqual(f.controller.heap.get('result').properties.get('value'),encode(result.value));}
    else{assert.throws(()=>native.throw(7),error=>error===7);f.completed(method,num(7),null);assert.deepEqual(f.controller.lastReturn,{kind:'throw',value:num(7)});}
    assert.equal(f.controller.heap.get('it').phase,'completed');f.completed('next',U,'next');
  }
  for(const method of ['return','throw']){
    const f=fixture();f.define();f.create();f.start();f.resume();f.yielded(num(1));
    f.resume(num(4),{method});assert.throws(()=>f.finish(num(9),method==='return'?'end':null,method),/abrupt resume/);
    f.finish(num(4),method==='return'?'end':null,method);assert.equal(f.controller.heap.get('it').phase,'completed');
  }
});
test('generator function metadata and current prototype replacement stay distinct',()=>{
  const f=fixture();f.define();
  assert.deepEqual([...f.controller.heap.get('g').properties.keys()],['length','name','prototype']);
  assert.equal(f.controller.heap.get('g-prototype').properties.size,0);
  f.create('first');f.start('first');
  f.detail({kind:'allocate',name:'replacement',objectKind:'object',length:null,properties:[],code:null,captures:[],functionKind:null,lexicalReceiver:null});
  f.detail({kind:'property.set',object:'g',key:['str','prototype'],receiver:ref('g'),value:ref('replacement'),success:true});
  f.create('second');f.start('second');assert.deepEqual(f.controller.heap.get('first').prototype,ref('g-prototype'));assert.deepEqual(f.controller.heap.get('second').prototype,ref('replacement'));
  assert.throws(()=>f.apply({kind:'generator.lookup',receiver:ref('second'),key:['str','next'],method:'Generator.next'}),/selection/);
  f.detail({kind:'property.set',object:'g',key:['str','prototype'],receiver:ref('g'),value:['null'],success:true});f.create('third');f.start('third');
  assert.equal(f.controller.heap.get('third').prototype,'Generator.prototype');f.apply({kind:'generator.lookup',receiver:ref('third'),key:['str','next'],method:'Generator.next'});
});
test('generator transitions reject reentry duplicate identities and continuation bypass atomically',()=>{
  const f=fixture();f.define();f.create();f.start();f.resume();const before=structuredClone(f.controller);
  for(const record of [
    {kind:'generator.resume',object:'it',method:'next',argument:U},
    {kind:'generator.yield',object:'it',value:num(1),name:'it'},
    {kind:'generator.completed',object:'it',method:'next',argument:U,name:'done'}
  ]){assert.throws(()=>f.apply(record));assert.deepEqual(f.controller,before);}
  assert.throws(()=>assertGeneratorCallV8(f.controller,ref('g'),{},api),/creation\/resume/);
  assert.throws(()=>f.detail({kind:'return',invocation:'it-body',value:num(3)}),/retained continuation/);
  f.yielded(num(1));f.apply({kind:'generator.resume',object:'it',method:'next',argument:num(7)});
  assert.throws(()=>f.yielded(num(2),'r1'),/consumed/);f.apply({kind:'generator.receive',object:'it',bind:'sent'});f.finish(num(7));
});
test('generator checkpoint restoration rejects fabricated continuation and unknown state fields',()=>{
  const f=fixture();f.define();f.create();f.start();f.resume();f.yielded(num(1));
  for(const mutate of [node=>node.invocation='invented',node=>node.phase='executing',node=>node.resume={kind:'next',from:'suspendedYield',value:num(3)},node=>node.pc=42,
    node=>node.handlers.push({catch:'invented'})]){
    const broken=structuredClone(f.controller);mutate(broken.heap.get('it'));assert.throws(()=>restoreGeneratorStateV8(broken,api));
  }
  assert.equal(restoreGeneratorStateV8(structuredClone(f.controller),api).valid,true);
});
test('frozen generator component sequences preserve exact serialized shared state',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/semantic-generator-v8.json',import.meta.url),'utf8'));
  const wire=c=>JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(c).map(key=>[key,key==='heap'?[...c.heap].map(([id,node])=>[id,
    {...node,properties:[...node.properties],...(node.descriptors?{descriptors:[...node.descriptors]}:{})}]):c[key] instanceof Map?[...c[key]]:c[key]]))));
  for(const sample of fixture.cases){
    const c=structuredClone(sample.initialState);
    for(const key of ['heap','locals','captureAliases','frameFunctions'])c[key]=new Map(c[key]);
    for(const line of sample.lines){const record=JSON.parse(line.slice('protocol '.length));assertGeneratorNextV8(c,record,api);
      if(PROTOCOL_RECORD_V8_FIELDS[record.kind])applyProtocolRecordV8(c,record);
      else{validateGeneratorRecordV8(record,{value:validateProtocolValueV8});assert.equal(applyGeneratorRecordV8(c,record,api),true);c.protocol.sequence++;}
      assert.equal(restoreGeneratorStateV8(c,api).valid,true);
    }
    assert.deepEqual(wire(c),sample.expected,sample.id);
  }
});
