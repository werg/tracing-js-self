import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {validateGeneratorState} from '../src/generator-validation.js';
import {replayExact} from '../src/replay.js';
import {independentEffectfulReference,verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

test('generator yield and next retain operands local cells and sent values',()=>{
  runtimeDifferential('function* g(){const n=yield 1;yield n+2;return 9;}const it=g();return [it.next(99),it.next(3),it.next(),it.next()];');
  runtimeDifferential('function* g(){let n=2;const f=()=>++n;yield f;yield n;return n;}const it=g();const f=it.next().value;const a=f();return [a,it.next(),f(),it.next()];');
  runtimeDifferential('const obj={n:4,*items(){yield this.n;}};return obj.items().next();');
  runtimeDifferential('function* g(){return 1+(yield 2)*3;}const it=g();return [it.next(),it.next(4)];');
});
test('generator parameter initialization occurs at call and body starts at first next',()=>{
  runtimeDifferential('let log=[];function* g(x=(log.push("param"),7)){log.push("body");yield x;}const it=g();const before=log.slice();const first=it.next();return [before,first,log];');
  runtimeDifferential('let log=[];function fail(){throw 7;}function* g(x=fail()){log.push("body");yield x;}try{g();}catch(e){return [e,log];}');
  runtimeDifferential('function* g(){yield 1;}const xs=[1,2].map(g);return [xs[0].next(),xs[1].next()];');
});
test('return and throw enter retained finally/catch and can suspend during cleanup',()=>{
  runtimeDifferential('let log=[];function* g(){try{yield 1;}finally{log.push("finally");yield 2;}}const it=g();return [it.next(),it.return(9),it.next(),log];');
  runtimeDifferential('function* g(){try{yield 1;}catch(e){yield e+1;}return 9;}const it=g();return [it.next(),it.throw(4),it.next()];');
  runtimeDifferential('let log=[];function* g(){try{yield 1;}finally{try{yield 2;}finally{log.push("inner");}}}const it=g();return [it.next(),it.return(7),it.return(9),it.next(),log];');
  runtimeDifferential('let log=[];function* g(){try{log.push("body");yield 1;}finally{log.push("finally");}}const a=g(),b=g();const r=a.return(7);try{b.throw(9);}catch(e){return [r,e,a.next(),b.next(),log];}');
});
test('generator reentrancy throws and for-of closing runs cleanup exactly once',()=>{
  runtimeDifferential('let it;function* g(){try{it.next();}catch(e){yield e.name;}return 4;}it=g();return [it.next(),it.next()];');
  runtimeDifferential('let log=[];function* g(){try{yield 1;yield 2;}finally{log.push("closed");}}for(const x of g()){log.push(x);break;}return log;');
  runtimeDifferential('function* g(){yield 1;throw 8;}const it=g();it.next();try{it.next();}catch(e){return [e,it.next(),it.return(4)];}');
});
test('generator suspension restores from plain JSON state without rerunning work',()=>{
  const source='"use strict";function run(){let calls=0;function* g(){calls++;const n=yield calls;calls++;return n+calls;}const it=g();const first=it.next();const second=it.next(4);return [first,second,calls];}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.heap).some(entity=>entity.kind==='generator'&&entity.state==='suspendedYield'))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);
  original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportRun())),JSON.parse(JSON.stringify(original.exportRun())));
  assert.equal(validateBundle(restored.exportRun()).valid,true);
  assert.equal(replayExact(restored.exportRun()).valid,true);
  const broken=structuredClone(snapshot.state),generator=Object.values(broken.heap).find(entity=>entity.kind==='generator');
  generator.state='completed';
  assert.throws(()=>validateGeneratorState(broken,snapshot.programs,message=>{throw new Error(message);}),/Completed generator/);
});
test('independent generator source completions agree while old public formats refuse',async()=>{
  const source='"use strict";function run(){function* g(){const n=yield 2;return n+1;}const it=g();return [it.next(),it.next(4),it.return(8)];}';
  const {bundle}=runtimeDifferential('',{source});
  const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
  const check=compareCompletionObservations(ownedCompletionObservations(bundle,source),reference.completions);
  assert.equal(check.status,'agreed',JSON.stringify(check));
  const admission=await verifyEffectfulTrainingCase({source,entry:'run',family:'generator-continuation',fixture:{calls:[]}});
  assert.equal(admission.status,'projection_refused');
});
test('async generators and delegation remain explicitly outside this slice',()=>{
  for(const source of ['"use strict";function run(){function* g(){yield* [1,2];}return g().next();}',
    '"use strict";function run(){async function* g(){yield 1;}return g().next();}'])
    assert.throws(()=>createRuntime().startEntry({text:source,functionName:'run'}),/Unsupported training/);
});
