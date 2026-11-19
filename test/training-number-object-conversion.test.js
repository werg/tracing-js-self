import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {validateNumberConversionState} from '../src/number-conversion-validation.js';
import {independentEffectfulReference,verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

const counter='"use strict";function run(x){class Counter{#n;constructor(n){this.#n=n;}[Symbol.toPrimitive](){return ++this.#n;}}const value=new Counter(x);return [Number(value),Number(value)];}';
test('Number calls the actual private conversion method with number hint and retains side effects',()=>{
  runtimeDifferential('',{source:counter,args:[2]});
  runtimeDifferential('let log="";const o={[Symbol.toPrimitive](hint){log+=hint;return "4";}};const n=Number(o,(log+="extra"));return [n,log];');
  runtimeDifferential('let calls=0;const o={[Symbol.toPrimitive](hint){calls++;return 9007199254740993n;}};return [Number(o),calls];');
  runtimeDifferential('const o={[Symbol.toPrimitive](...args){return args.length===1&&args[0]==="number"?7:8;}};return Number(o);');
  runtimeDifferential('const inner={valueOf(){return 2;}};const outer={valueOf(){return Number(inner)+3;}};return Number(outer);');
});

test('Number ordinary fallback observes live method mutation and skips noncallable properties',()=>{
  runtimeDifferential('let log="";const o={valueOf(){log+="v";this.toString=()=>"7";return {};},toString(){return "9";}};const n=Number(o);return [n,log];');
  runtimeDifferential('return [Number({valueOf:1,toString(){return "5";}}),Number({}),Number([3]),Number([])];');
  runtimeDifferential('const proto={valueOf(){return 6;}};const o=Object.create(proto);return Number(o);');
});

test('Number distinguishes guest conversion failures from unsupported callable or accessor profiles',()=>{
  for(const body of [
    'const o={[Symbol.toPrimitive](){return {};}};try{Number(o);}catch(e){return e.name;}',
    'const o={[Symbol.toPrimitive]:1};try{Number(o);}catch(e){return e.name;}',
    'const o={valueOf(){return {};},toString(){return {};}};try{Number(o);}catch(e){return e.name;}',
    'const o={[Symbol.toPrimitive](){return Symbol("x");}};try{Number(o);}catch(e){return e.name;}',
    'const o={valueOf(){throw 7;}};try{Number(o);}catch(e){return e+1;}'
  ])runtimeDifferential(body);
  for(const body of [
    'const o={get [Symbol.toPrimitive](){return ()=>1;}};return Number(o);',
    'const o={valueOf:async()=>1};return Number(o);'
  ]){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run',args:[]});
    assert.throws(()=>runtime.drive(),/requires its owned|requires an owned/);
    assert.notEqual(runtime.state.control.a0.failure?.kind,'guest-abrupt');
  }
});

test('Number waiting and returned callbacks resume from plain JSON without repeating effects',()=>{
  for(const phase of ['waiting','returned']){
    const original=createRuntime().startEntry({text:counter,functionName:'run',args:[2]});
    while(!Object.values(original.state.frames).some(frame=>frame.pendingNumberConversion?.phase===phase))original.step();
    const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters')))),
      restored=Object.assign(createRuntime(),snapshot);
    original.drive();restored.drive();assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),JSON.parse(JSON.stringify(original.exportRun())));
    assert.equal(validateBundle(restored.exportRun()).valid,true);assert.equal(replayExact(restored.exportRun()).valid,true);
    const changed=structuredClone(snapshot.state),frame=Object.values(changed.frames).find(frame=>frame.pendingNumberConversion);
    frame.pendingNumberConversion.waitingFrameId='missing';
    assert.throws(()=>validateNumberConversionState(changed,snapshot.programs,new Set(snapshot.sites.map(site=>site.siteId)),message=>{throw Error(message);}),/callback identity/);
  }
});

test('Number source completions agree independently and historical projection retains its refusal',async()=>{
  const {bundle}=runtimeDifferential('',{source:counter,args:[2]}),reference=await independentEffectfulReference({source:counter,entry:'run',
    inputGraph:encodeNativeGraph([2]),fixture:{calls:[]},mode:'completions'}),
    audit=compareCompletionObservations(ownedCompletionObservations(bundle,counter),reference.completions);
  assert.equal(audit.status,'agreed',JSON.stringify(audit));
  const result=await verifyEffectfulTrainingCase({source:counter,entry:'run',args:[2],family:'owned-number-private',fixture:{calls:[]}});
  assert.equal(result.status,'projection_refused');
});
