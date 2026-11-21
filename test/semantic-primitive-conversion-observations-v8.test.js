import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {createPrimitiveConversionObservationAdapterV8,PRIMITIVE_CONVERSION_OBSERVATION_PROFILE_V8}
  from '../src/semantic/protocol-primitive-conversion-observations-v8.js';
import {prepareProtocolObservationExtensionsV8} from '../src/semantic/protocol-source-observations-v8.js';
import {instrumentCompletionSource,createCompletionCapture,ownedCompletionObservations,COMPLETION_HOOK}
  from '../src/training/completion-reference.js';

const factory=createPrimitiveConversionObservationAdapterV8;
const source=body=>'"use strict";function run(){'+body+'}';
function observed(text,{args=[],completions=false}={}){
  const extensions=prepareProtocolObservationExtensionsV8({source:text,initialValues:args,adapters:[factory]}),
    capture=createCompletionCapture({initialValues:args}),context=vm.createContext({...extensions.globals,
      __args:args,__result:undefined,__kind:'return',[COMPLETION_HOOK]:capture.capture});
  extensions.initializeRealm(expression=>vm.runInContext(expression,context));
  const instrumented=extensions.instrument(completions?instrumentCompletionSource(text):text);
  vm.runInContext(instrumented+';try{__result=run(...__args);}catch(error){__kind="throw";__result=error;}',context);
  return {kind:context.__kind,result:structuredClone(context.__result),rows:extensions.observations()[0]?.rows??[],
    completions:capture.observations};
}
function archive(text,args=[]){
  const runtime=createRuntime().startEntry({text,functionName:'run',args});runtime.drive();return runtime.exportRun();
}
function checked(body,{expected,completions=false}={}){
  const text=source(body),original=vm.createContext({__result:undefined,__kind:'return'});
  vm.runInContext(text+';try{__result=run();}catch(error){__kind="throw";__result=error;}',original);
  const native=observed(text,{completions}),bundle=archive(text),owned=factory({source:text,side:'owned',bundle}).observations();
  assert.equal(native.kind,original.__kind);
  assert.deepEqual(native.result,structuredClone(original.__result),'instrumentation must preserve the original result and side effects');
  if(expected!==undefined)assert.deepEqual(native.result,expected);
  assert.deepEqual(native.rows,owned,'native selection and callback observations must agree with the archived owned trace');
  if(completions)assert.deepEqual(native.completions,ownedCompletionObservations(bundle,text));
  return {text,bundle,rows:owned};
}

test('one observer independently measures Number and PropertyKey with goal-derived hint and order',()=>{
  const checkedCase=checked('let log="";const key={valueOf(){log+="wrong";return 0;},toString(){log+="k";return "x";}};'+
    'const number={toString(){log+="wrong";return "9";},valueOf(){log+="n";return 4;}};return [{x:7}[key],Number(number),log];',
  {expected:[7,4,'kn']});
  assert.deepEqual(checkedCase.rows.filter(row=>row.kind==='begin').map(({goal,hint})=>({goal,hint})),
    [{goal:'PropertyKey',hint:'string'},{goal:'Number',hint:'number'}]);
  assert.deepEqual(checkedCase.rows.filter(row=>row.kind==='lookup').map(row=>row.key),
    [['symbol','well-known:toPrimitive'],['str','toString'],['symbol','well-known:toPrimitive'],['str','valueOf']]);
  assert.equal(factory({source:'"use strict";function run(){return 3;}'}),null);
  assert.equal(PRIMITIVE_CONVERSION_OBSERVATION_PROFILE_V8,'primitive-conversion-observations/1');
});

test('getter selection captures the returned method once despite descriptor replacement',()=>{
  for(const body of [
    'let log="";const key={get [Symbol.toPrimitive](){log+="g";Object.defineProperty(this,Symbol.toPrimitive,{value(){log+="wrong";return "y";}});return function(h){log+=h;return "x";};}};return [{x:3,y:9}[key],log];',
    'let log="";const number={get valueOf(){log+="g";Object.defineProperty(this,"valueOf",{value(){log+="wrong";return 9;}});return function(){log+="m";return 3;};}};return [Number(number),log];',
    'let log="";const proto={get toString(){log+=this.tag;return function(){log+="c";return this.name;};}};const key=Object.create(proto);key.tag="g";key.name="x";return [{x:5}[key],log];'
  ]){
    const {rows}=checked(body);
    const getterReturn=rows.find(row=>row.kind==='getter.return'),call=rows.find(row=>row.kind==='call');
    assert(getterReturn);assert(call);assert.deepEqual(call.method,getterReturn.value);
    assert.equal(rows.filter(row=>row.kind==='getter.call').length,1);
  }
});

test('fallback lookup is lazy after getter returns, method mutation, null and noncallable candidates',()=>{
  for(const body of [
    'let log="";const key={get [Symbol.toPrimitive](){log+="s";return undefined;},get toString(){log+="t";return function(){log+="c";this.valueOf=()=>"x";return {};};},valueOf(){log+="wrong";return "y";}};return [{x:9}[key],log];',
    'let log="";const key={get toString(){log+="t";return 1;},get valueOf(){log+="v";return ()=>"x";}};return [{x:9}[key],log];',
    'const key={set [Symbol.toPrimitive](v){},toString:null,valueOf(){return "x";}};return {x:9}[key];',
    'const key=Object.create(null);key.valueOf=()=>"x";return {x:3}[key];',
    'let log="";const number={valueOf(){log+="v";this.toString=()=>"7";return {};},toString(){log+="wrong";return "9";}};return [Number(number),log];'
  ])checked(body);
});

test('single writes retain base and key but convert only after RHS mutations',()=>{
  checked('let log="";const first={x:0},second={x:9};let current=first;const key={toString(){log+="k";return "x";}};'+
    'function base(){log+="b";return current;}function property(){log+="p";return key;}function rhs(){log+="r";current=second;return 4;}'+
    'base()[property()]=rhs();return [first.x,second.x,log];',{expected:[4,9,'bprk'],completions:true});
  checked('let log="";const key={toString(){log+="old";return "x";}};const target={};'+
    'target[key]=(key.toString=()=>{log+="new";return "y";},3);return [target.x,target.y,log];',
  {expected:[undefined,3,'new']});
  checked('let log="";const key={toString(){log+="k";return "x";}};const target={set x(value){log+="s"+value;}};'+
    'target[key]=(log+="r",3);return log;',{expected:'rks3'});
});

test('computed calls preserve receiver and argument order, private brands and optional short circuit',()=>{
  checked('let log="";const o={x:7,m(v){log+="m";return this.x+v;}};const key={toString(){log+="k";return "m";}};'+
    'function base(){log+="b";return o;}function argument(){log+="a";return 2;}return [base()[key](argument()),log];',
  {expected:[9,'bkam'],completions:true});
  checked('class Key{#name="x";[Symbol.toPrimitive](hint){return hint==="string"?this.#name:"wrong";}};'+
    'const key=new Key();return {x:3}[key];',{expected:3});
  checked('let log="";const key={toString(){log+="wrong";return "x";}};const o=null;return [o?.[key],log];',
  {expected:[undefined,'']});
  for(const expression of ['target[key]','target[key]()','target[key]=(log+="r",3)']){
    checked('let log="";const key={toString(){log+="wrong";return "x";}};const target=null;try{'+expression+';}catch(e){return log;}',
    {expected:expression.includes('=')?'r':''});
  }
});

test('computed literal, class and destructuring keys retain their source anchors and timing',()=>{
  for(const body of [
    'let log="";const key={toString(){log+="k";return "x";}};const o={[key]:(log+="v",3)};return [o.x,log];',
    'let log="";const key={toString(){log+="k";return "x";}};class C{[key]=(log+="v",3);}const o=new C();return [o.x,log];',
    'const key={toString(){return "m";}};class C{[key](){return 3;}}return new C().m();',
    'let calls=0;const key={toString(){calls++;return "x";}};const {[key]:picked,...rest}={x:1,y:2};return [picked,rest.x,rest.y,calls];'
  ])checked(body);
});

test('Symbol identity and primitive key formatting remain distinct from string keys',()=>{
  checked('const first=Symbol("same"),second=Symbol("same");const key={[Symbol.toPrimitive](hint){return first;}};const o={};'+
    'o[key]=3;o[second]=4;o["\\u0000symbol:"+"fake"]=5;return [o[first],o[second],o["\\u0000symbol:"+"fake"]];',
  {expected:[3,4,5]});
  checked('const symbol=Symbol("s"),key={toString(){return symbol;}};const o={[key]:6};return [o[symbol],Object.keys(o).length];',
  {expected:[6,0]});
  checked('const key={toString(){return -0;}},big={toString(){return 12n;}};return [{0:2}[key],{12:3}[big]];',
  {expected:[2,3]});
  checked('return [Number(),Number("-0"),Number(9007199254740993n),Number(null),Number(undefined)];');
});

test('bounded ordinary builtins use actual native calls and independent dense data observations',()=>{
  checked('return [{"[object Object]":2}[{}],{"1,2":3}[[1,2]],{"":4}[[]],Number({}),Number([3])];');
  checked('const key={[Symbol.toStringTag]:"Key"};return {"[object Key]":9}[key];',{expected:9});
  checked('const key={};Object.defineProperty(key,"toString",{value:function(){return this===key?"x":"wrong";},writable:false,configurable:false});'+
    'return [{x:4}[key],Object.getOwnPropertyDescriptor(key,"toString").writable];',{expected:[4,false]});
});

test('nested getter and callback conversions retain ordered shared identities and finally effects',()=>{
  for(const body of [
    'const inner={get valueOf(){return ()=>3;}};const key={get toString(){const n=Number(inner);return ()=>"x"+n;}};return {x3:9}[key];',
    'const inner={toString(){return "v";}};const number={get valueOf(){return ()=>({v:4})[inner];}};const key={toString(){return "x"+Number(number);}};return {x4:8}[key];',
    'let log="";const key={get toString(){try{return function(){try{return "x";}finally{log+="m";}};}finally{log+="g";}}};return [{x:3}[key],log];',
    'let log="";const number={valueOf(){try{return 4;}finally{log+="n";}}};const key={toString(){return "x"+Number(number);}};return [{x4:6}[key],log];'
  ])checked(body,{completions:true});
});

test('original getter and method throws retain identity, partial effects and deepest-first unwinding',()=>{
  for(const body of [
    'const error={};let log="";const key={get [Symbol.toPrimitive](){log+="g";throw error;}};try{try{({})[key];}finally{log+="f";}}catch(e){return [e===error,log];}',
    'const error={};let log="";const key={toString(){log+="k";throw error;}};try{({})[key]=(log+="r",3);}catch(e){return [e===error,log];}',
    'const key={get toString(){throw 5;},valueOf(){throw 99;}};return {x:7}[key];',
    'const key={toString(){throw 5;}};const number={valueOf(){return Number({valueOf(){return {x:7}[key];}});}};return Number(number);'
  ]){
    const {rows}=checked(body,{completions:true});
    assert(rows.some(row=>row.kind==='abrupt'));
    assert(!rows.some(row=>row.kind==='finish'));
  }
});

test('source observation rejects changed read, captured getter result, receiver, hint and completion even with the same final scalar',()=>{
  const {text,bundle,rows}=checked('const key={get [Symbol.toPrimitive](){return function(hint){return "x";};}};return {x:7}[key];');
  for(const mutate of [
    changed=>{changed.events.find(event=>event.operation==='property.key.convert').readObservations[0].value=['undefined'];},
    changed=>{const event=changed.events.find(event=>event.operation==='property.key.resume'&&event.result===null);
      event.stateChanges.find(change=>change.after?.pendingPropertyKeyConversion).after.pendingPropertyKeyConversion.conversion.method=['ref','missing'];},
    changed=>{const event=changed.events.find(event=>event.operation==='property.key.resume'&&event.result===null);
      event.stateChanges.find(change=>change.table==='frames'&&change.before===null).after.thisValue=['undefined'];},
    changed=>{const event=changed.events.find(event=>event.operation==='property.key.resume'&&event.result===null);
      const environment=event.stateChanges.find(change=>change.table==='envs'&&change.after?.bindings.hint).after;
      environment.bindings.hint.token.value=['str','number'];}
  ]){
    const changed=structuredClone(bundle);mutate(changed);
    assert.throws(()=>factory({source:text,side:'owned',bundle:changed}).observations(),/read|method|receiver|hint/);
  }
  const changed=structuredClone(bundle);
  changed.events.find(event=>event.operation==='property.key.resume'&&event.result?.[0]==='str').result=['str','y'];
  assert.notDeepEqual(factory({source:text,side:'owned',bundle:changed}).observations(),rows);
  assert.deepEqual(changed.finalState,bundle.finalState,'the independent observation catches a different conversion despite an unchanged terminal state');
});

test('seeded input identities cannot be exchanged behind equal-looking object conversions',()=>{
  const text='"use strict";function run(first,second){first.valueOf=()=>3;second.valueOf=()=>3;return [Number(first),Number(second)];}',
    args=[{},{}],native=observed(text,{args:structuredClone(args)}),bundle=archive(text,args),
    rows=factory({source:text,side:'owned',bundle}).observations();
  assert.deepEqual(native.rows,rows);
  const starts=rows.filter(row=>row.kind==='begin');assert.notDeepEqual(starts[0].value,starts[1].value);
  const changed=structuredClone(bundle),events=changed.events.filter(event=>event.operation==='call.enter'&&event.operands[0]?.[1]==='Number');
  events[0].operands[1]=events[1].operands[1];
  assert.throws(()=>factory({source:text,side:'owned',bundle:changed}).observations(),/receiver|continuation/);
});

test('generated intrinsic faults keep an explicit unsupported observation disposition',()=>{
  for(const body of [
    'return Number(Symbol("x"));',
    'const key={[Symbol.toPrimitive]:3};try{return {x:1}[key];}catch(e){return e.name;}',
    'const key={[Symbol.toPrimitive](){return {};}};try{return {x:1}[key];}catch(e){return e.name;}',
    'const key={toString(){return {};},valueOf(){return {};}};try{return {x:1}[key];}catch(e){return e.name;}'
  ]){
    const text=source(body);
    assert.throws(()=>observed(text),/intrinsic conversion fault/);
    assert.throws(()=>factory({source:text,side:'owned',bundle:archive(text)}).observations(),/intrinsic conversion fault/);
  }
});

test('unsupported exotic and builtin boundaries cannot be hidden by a guest catch',()=>{
  for(const [body,reason]of [
    ['const key=new Proxy({toString(){return "x";}},{});try{({x:1})[key];}catch(e){}return 0;',/Proxy/],
    ['const key={toString:async()=>"x"};try{({x:1})[key];}catch(e){}return 0;',/ordinary source function/],
    ['const key={toString:function*(){yield "x";}};try{({x:1})[key];}catch(e){}return 0;',/ordinary source function/],
    ['const key={get toString(){return Object.prototype.toString;}};try{({})[key];}catch(e){}return 0;',/getter-returned builtin/],
    ['const key={get [Symbol.toStringTag](){throw 9;}};try{({})[key];}catch(e){}return 0;',/toStringTag accessor/],
    ['const key=[1];Object.defineProperty(key,"join",{get(){throw 9;}});try{({})[key];}catch(e){}return 0;',/join override or accessor/],
    ['const key=[{}];try{({})[key];}catch(e){}return 0;',/dense scalar data/]
  ])assert.throws(()=>observed(source(body)),reason);
});

test('Node24 compound, logical and update differences are refused while primitive keys stay unchanged',()=>{
  for(const expression of ['object[key]+=2','object[key]||=2','object[key]++']){
    const body='const key={toString(){return "x";}};const object={x:0};try{'+expression+';}catch(e){}return object.x;',text=source(body);
    assert.throws(()=>observed(text),/compound\/logical\/update/);
    assert.throws(()=>factory({source:text,side:'owned',bundle:archive(text)}).observations(),/compound\/logical\/update/);
  }
  checked('const key="x",object={x:1};object[key]+=2;object[key]++;return object.x;',{expected:4});
  const deletion=source('const key={toString(){return "x";}};const object={x:1};try{delete object[key];}catch(e){}return 0;');
  assert.throws(()=>observed(deletion),/computed deletion/);
  assert.throws(()=>archive(deletion),/Unsupported.*unary operator/);
});

test('reserved hook names and altered instrumentation inventories are rejected',()=>{
  assert.throws(()=>factory({source:'function run(){return __tracingProtocolConversionKey(0,{});}'}),/reserved observer/);
  const text=source('const key={toString(){return "x";}};return {x:1}[key];'),adapter=factory({source:text});
  assert.throws(()=>adapter.instrument(text+';({})[{}];'),/inventory changed/);
});
