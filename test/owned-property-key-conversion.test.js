import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {ownedOutcome,referenceOutcome} from '../src/training/reference.js';
import {describeGraph} from '../src/training/graph.js';
import {validatePropertyKeyConversionState} from '../src/property-key-conversion-validation.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';

const source=body=>'"use strict";function run(){'+body+'}';
const json=value=>JSON.parse(JSON.stringify(value));
const snapshot=runtime=>json(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters')));
const failure=message=>{throw new Error(message);};
function checked(body,expected,{allowHost=false}={}){
  const runtime=createRuntime().startEntry({text:source(body),functionName:'run',args:[],allowHost});
  runtime.drive();const bundle=runtime.exportRun();
  assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  if(expected!==undefined)assert.deepEqual(ownedOutcome(runtime),{kind:'return',graph:describeGraph([expected])});
  return {runtime,bundle};
}

test('computed reads and method calls use string hint and preserve receiver/key/argument order',()=>{
  for(const body of [
    'let log="";const key={[Symbol.toPrimitive](hint){log+=hint;return "x";}};return [{x:7}[key],log];',
    'let log="";const o={x:7,m(v){log+="m";return this.x+v;}};const key={toString(){log+="k";return "m";}};function base(){log+="b";return o;}function argument(){log+="a";return 2;}return [base()[key](argument()),log];',
    'let log="";const key={get [Symbol.toPrimitive](){log+="g";Object.defineProperty(this,Symbol.toPrimitive,{value(){log+="wrong";return "y";}});return function(h){log+=h;return "x";};}};return [{x:3}[key],log];',
    'let log="";const proto={get toString(){log+=this.tag;return function(){log+="c";return this.name;};}};const key=Object.create(proto);key.tag="g";key.name="x";return [{x:5}[key],log];',
    'let log="";const key={toString(){log+="k";return "x";}};const o=null;return [o?.[key],log];',
    'const key={toString(){return "1";}};return ["abc"[key],[1,2][key]];'
  ])runtimeDifferential(body);
});

test('ordinary key fallback gets toString then valueOf lazily and skips noncallable values',()=>{
  for(const body of [
    'let log="";const key={get [Symbol.toPrimitive](){log+="s";return undefined;},get toString(){log+="t";return function(){log+="c";this.valueOf=()=>"x";return {};};},valueOf(){log+="wrong";return "y";}};return [{x:9}[key],log];',
    'let log="";const key={get toString(){log+="t";return 1;},get valueOf(){log+="v";return ()=>"x";}};return [{x:9}[key],log];',
    'const key={set [Symbol.toPrimitive](v){},toString:null,valueOf(){return "x";}};return {x:9}[key];',
    'const key=Object.create(null);key.valueOf=()=>"x";return {x:3}[key];',
    'return [{"[object Object]":2}[{}],{"1,2":3}[[1,2]],{"":4}[[]]];'
  ])runtimeDifferential(body);
});

test('ToPropertyKey preserves Symbol identity and the disjoint escaped string namespace',()=>{
  runtimeDifferential('const first=Symbol("same"),second=Symbol("same");const key={[Symbol.toPrimitive](hint){return first;}};const o={};o[key]=3;o[second]=4;o["\\u0000symbol:"+"fake"]=5;return [o[first],o[second],o["\\u0000symbol:"+"fake"]];');
  runtimeDifferential('const symbol=Symbol("s"),key={toString(){return symbol;}};const o={[key]:6};return [o[symbol],Object.keys(o).length];');
  runtimeDifferential('const key={toString(){return -0;}},big={toString(){return 12n;}};return [{0:2}[key],{12:3}[big]];');
});

test('simple assignment converts after RHS and retains the originally evaluated base and key',()=>{
  runtimeDifferential('let log="";const first={x:0},second={x:9};let current=first;const key={toString(){log+="k";return "x";}};function base(){log+="b";return current;}function property(){log+="p";return key;}function rhs(){log+="r";current=second;return 4;}base()[property()]=rhs();return [first.x,second.x,log];');
  runtimeDifferential('let log="";const key={toString(){log+="old";return "x";}};const target={};target[key]=(key.toString=()=>{log+="new";return "y";},3);return [target.x,target.y,log];');
  runtimeDifferential('let log="";const key={toString(){log+="k";return "x";}};const target={set x(value){log+="s"+value;}};target[key]=(log+="r",3);return log;');
});

test('computed literal/class keys convert before values and destructuring caches rest exclusions',()=>{
  runtimeDifferential('let log="";const key={toString(){log+="k";return "x";}};const o={[key]:(log+="v",3)};return [o.x,log];');
  runtimeDifferential('let log="";const key={toString(){log+="k";return "x";}};class C{[key]=(log+="v",3);}const o=new C();return [o.x,log];');
  runtimeDifferential('let calls=0;const key={toString(){calls++;return "x";}};const {[key]:picked,...rest}={x:1,y:2};return [picked,rest.x,rest.y,calls];');
  runtimeDifferential('let log="";const error={};const key={toString(){log+="k";throw error;}};try{const o={[key]:(log+="wrong",3)};}catch(e){return [e===error,log];}');
});

// These expected values come from ES2026 GetValue/PutValue, which mutate the
// Reference Record's [[ReferencedName]] once. Node 24.22 repeats conversion at
// PutValue for compound/logical/update forms; it is a diagnostic, not this oracle.
test('ES2026 cached reference key is used once by compound/logical/update reads and writes',t=>{
  for(const [expression,initial,expected] of [
    ['o[key]+=(log+="r",2)',1,[3,3,40,'kr',1]],
    ['o[key]&&=(log+="r",2)',1,[2,2,40,'kr',1]],
    ['o[key]||=(log+="r",2)',0,[2,2,40,'kr',1]],
    ['o[key]??=(log+="r",2)',null,[2,2,40,'kr',1]],
    ['o[key]&&=(log+="wrong",2)',0,[0,0,40,'k',1]],
    ['o[key]||=(log+="wrong",2)',1,[1,1,40,'k',1]],
    ['o[key]??=(log+="wrong",2)',1,[1,1,40,'k',1]],
    ['o[key]++',1,[1,2,40,'k',1]],
    ['++o[key]',1,[2,2,40,'k',1]],
    ['o[key]--',1,[1,0,40,'k',1]],
    ['--o[key]',1,[0,0,40,'k',1]]
  ]){
    const body='let log="",calls=0;const key={toString(){log+="k";calls++;return calls===1?"x":"y";}};const o={x:'+JSON.stringify(initial)+',y:40};const result='+expression+';return [result,o.x,o.y,log,calls];';
    const {runtime,bundle}=checked(body,expected),reference=referenceOutcome({source:source(body),entry:'run',args:bundle.entrySpec.arguments,
      initialHeap:bundle.initialState.heap,bundle});
    if(!isDeepStrictEqual(ownedOutcome(runtime),reference))
      t.diagnostic(process.version+' differs from pinned ES2026 cached-reference semantics for '+expression);
  }
});

test('cached compound/logical keys survive target getters/setters and RHS method mutation',()=>{
  checked('let log="",calls=0;const key={toString(){calls++;log+="k";return "x";}};const o={get x(){log+="g";return 3;},set x(value){log+="s"+value;}};const result=o[key]+=(log+="r",2);return [result,log,calls];',[5,'kgrs5',1]);
  checked('let calls=0;const key={toString(){calls++;return "x";}};const o={x:0};const result=o[key]||=(key.toString=()=>"y",4);return [result,o.x,o.y,calls];',[4,4,undefined,1]);
  checked('const a=Symbol("a"),b=Symbol("b");let calls=0;const key={[Symbol.toPrimitive](){calls++;return calls===1?a:b;}};const o={[a]:2,[b]:8};o[key]+=3;return [o[a],o[b],calls];',[5,8,1]);
});

test('nullish base fails before conversion, after RHS only for simple assignment',()=>{
  for(const expression of ['base[key]','base[key]()','base[key]++','base[key]+=rhs()','base[key]&&=rhs()','base[key]=rhs()']){
    for(const base of ['null','undefined']){
      const body='let log="";const key={toString(){log+="wrong";return "x";}};function rhs(){log+="r";return 3;}const base='+base+';try{'+expression+';}catch(e){return [e.name,log];}';
      const {bundle}=checked(body,['TypeError',expression==='base[key]=rhs()'?'r':'']);
      assert(!bundle.events.some(event=>event.operation.startsWith('property.key.')));
    }
  }
});

test('key faults preserve original exceptions, partial effects, finally and nested conversion state',()=>{
  for(const body of [
    'const error={};let log="";const key={get [Symbol.toPrimitive](){log+="g";throw error;}};try{try{({})[key];}finally{log+="f";}}catch(e){return [e===error,log];}',
    'const error={};let log="";const key={toString(){log+="k";throw error;}};try{({})[key]=(log+="r",3);}catch(e){return [e===error,log];}',
    'const key={[Symbol.toPrimitive](){return {};}};try{({})[key];}catch(e){return e.name;}',
    'const key={[Symbol.toPrimitive]:3};try{({})[key];}catch(e){return e.name;}',
    'const key={toString(){return {};},valueOf(){return {};}};try{({})[key];}catch(e){return e.name;}',
    'const inner={get valueOf(){return ()=>3;}};const key={get toString(){const n=Number(inner);return ()=>"x"+n;}};return {x3:9}[key];',
    'const inner={toString(){return "v";}};const number={get valueOf(){return ()=>({v:4})[inner];}};const key={toString(){return "x"+Number(number);}};return {x4:8}[key];',
    'let log="";const key={get toString(){try{return function(){try{return "x";}finally{log+="m";}};}finally{log+="g";}}};return [{x:3}[key],log];',
    'let log="";const number={valueOf(){try{return 4;}finally{log+="n";}}};const key={toString(){return "x"+Number(number);}};return [{x4:6}[key],log];',
    'let log="";const key={toString(){log+="k";return "x";}};const target=new Proxy({x:7},{get(o,p,r){log+="g";return o[p];}});return [target[key],log];'
  ])runtimeDifferential(body);
});

const retainedSource=source('let log="";const key={get [Symbol.toPrimitive](){log+="s";return null;},get toString(){log+="g";return function(){log+="t";return {};};},get valueOf(){log+="v";return function(){log+="c";return "x";};}};const o={x:1};o[key]||=9;return [o.x,log];');
test('every key lookup/call/return boundary and cached reference restores without reevaluation',()=>{
  const original=createRuntime().startEntry({text:retainedSource,functionName:'run',args:[]}),captures=[];
  while(original.state.control.a0.activeFrameId){
    const event=original.step();if(!event)break;
    if(event.operation.startsWith('property.key.')||event.stateChanges.some(change=>
      change.after?.pendingPropertyKeyConversion?.conversion.phase.endsWith('returned')))
      captures.push(snapshot(original));
  }
  original.drive();const expected=json(original.exportRun());
  assert(captures.length>=10,'Getter and fallback phases must all be exposed');
  for(const saved of captures){
    const restored=Object.assign(createRuntime(),saved);restored.drive();
    assert.deepEqual(json(restored.exportRun()),expected);
    assert.equal(validateBundle(restored.exportRun()).valid,true);assert.equal(replayExact(restored.exportRun()).valid,true);
  }
});

test('host blocking inside nested key/Number hooks retains both continuations through JSON restore',()=>{
  const text=source('let log="";const n={get valueOf(){host.store("number",1);return ()=>3;}};const key={get toString(){host.store("key",2);return ()=>"x"+Number(n);}};const o={x3:7};const value=o[key];return [value,log];');
  const original=createRuntime().startEntry({text,functionName:'run',args:[],allowHost:true});
  const progress=original.drive();assert.equal(progress.kind,'waiting');
  const restored=Object.assign(createRuntime(),snapshot(original));
  for(const runtime of [original,restored]){
    for(let count=0;count<2;count++){
      const effect=Object.values(runtime.state.effects).find(effect=>effect.external==='pending');
      assert(effect);assert.equal(effect.dispatch,'dispatched');
      assert.throws(()=>runtime.dispatchPrepared(effect.id),/Not prepared/);
      const input=runtime.recordInputArrival({effectId:effect.id,kind:'immediate',value:['undefined'],abrupt:false});
      runtime.deliverInput(input.inputId);runtime.drive();
    }
    assert.equal(Object.keys(runtime.state.effects).length,2);
    assert.deepEqual(ownedOutcome(runtime),{kind:'return',graph:describeGraph([[7,'']])});
    assert.equal(validateBundle(runtime.exportRun()).valid,true);assert.equal(replayExact(runtime.exportRun()).valid,true);
  }
  assert.deepEqual(json(restored.exportRun()),json(original.exportRun()));
});

test('independent reference checks reject wrong pc, operands, cache, receiver, phase, hint and result',()=>{
  const runtime=createRuntime().startEntry({text:retainedSource,functionName:'run',args:[]});
  while(!Object.values(runtime.state.frames).some(frame=>frame.pendingPropertyKeyConversion))assert(runtime.step());
  const saved=snapshot(runtime),sites=new Set(saved.sites.map(site=>site.siteId));
  for(const mutate of [
    (frame,p)=>p.pc++, (frame,p)=>p.stackIndex--, (frame,p)=>p.opcode='PUT_PROP',
    (frame,p)=>p.stack[0]={value:['undefined'],origin:null},
    (frame,p)=>p.cacheBinding.name='visible', (frame,p)=>p.cacheBinding.version++,
    (frame,p)=>p.conversion.input=['ref','missing'], (frame,p)=>p.conversion.waitingFrameId='missing',
    (frame,p)=>p.conversion.method=p.conversion.input, (frame,p)=>p.extra=true
  ]){
    const state=structuredClone(saved.state),frame=Object.values(state.frames).find(frame=>frame.pendingPropertyKeyConversion);
    mutate(frame,frame.pendingPropertyKeyConversion);
    assert.throws(()=>validatePropertyKeyConversionState(state,saved.programs,sites,failure));
  }
  runtime.drive();const bundle=runtime.exportRun();
  for(const mutate of [
    event=>event.result=['str','y'],
    event=>event.stateChanges.find(change=>change.after?.stack?.at(-1)?.value?.[0]==='str').after.stack.at(-1).value=['str','y'],
    event=>event.stateChanges.find(change=>change.table==='envs').after.bindings['[[logical key 1]]'].token.value=['str','y']
  ]){
    const changed=structuredClone(bundle),event=changed.events.find(event=>event.operation==='property.key.resume'&&event.result?.[0]==='str');
    mutate(event);assert.throws(()=>validateBundle(changed),/PropertyKey|conversion/);
  }
});

test('unowned key conversion profiles fail explicitly and source/public admission remains refused',async()=>{
  for(const body of [
    'const key={toString:async()=>"x"};return {x:1}[key];',
    'const key={toString:function*(){yield "x";}};return {x:1}[key];',
    'const key=new Proxy({toString(){return "x";}},{});return {x:1}[key];',
    'const key=[1];Object.defineProperty(key,"join",{get(){throw 3;}});return {1:1}[key];',
    'const key=[1];const proto={toString:key.toString,join(){return "x";}};Object.setPrototypeOf(key,proto);return {x:1}[key];'
  ]){
    const runtime=createRuntime().startEntry({text:source(body),functionName:'run',args:[]});
    assert.throws(()=>runtime.drive(),/requires its owned|requires an owned/);
    assert.notEqual(runtime.state.control.a0.failure?.kind,'guest-abrupt');
  }
  for(const body of [
    'const key={toString(){return "x";}};return {x:1}[key];',
    'return {"[object Object]":1}[{}];',
    'return Number({get valueOf(){return ()=>1;}});'
  ]){
    const result=await verifyRegionTrainingCase({source:source(body),entry:'run',args:[],
      family:'property-key-unqualified',fixture:{calls:[]}});
    assert.equal(result.status,'projection_refused');
  }
});
