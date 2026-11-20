import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {encode} from '../src/values.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {decodeWitness} from '../src/training/format.js';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {independentEffectfulReference} from '../src/training/effectful-admit.js';
import {ownedCompletionObservations,compareCompletionObservations} from '../src/training/completion-reference.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {describeGraph,realizeGraph} from '../src/training/graph.js';

const strict=body=>'"use strict";function run(){'+body+'}';
const declaration=inherited=>inherited?
  'const parent={};Object.defineProperty(parent,"x",{get:()=>1});const box=Object.create(parent);':
  'const box={};Object.defineProperty(box,"x",{get:()=>1});';

async function certified(source,{inherited=false}={}){
  const result=await verifyEffectfulTrainingCase({source,entry:'run',
    family:'strict-accessor-assignment',fixture:{calls:[]}});
  if(inherited){
    assert.equal(result.status,'projection_refused',result.reason);
    assert.match(result.reason,/prototype.*(?:state|profile)|(?:state|profile).*prototype/i);
    const {bundle,reference}=runtimeDifferential('',{source});
    const observed=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode:'completions'});
    const completions=compareCompletionObservations(ownedCompletionObservations(bundle,source),observed.completions);
    assert.equal(completions.status,'agreed',JSON.stringify(completions));
    return {public:null,sidecar:{archive:bundle,reference:{outcome:reference}}};
  }
  assert.equal(result.status,'locally_verified',result.reason);
  const bundle=result.exported.sidecar.archive;
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return result.exported;
}
const records=exported=>exported.public.timeline.filter(x=>x.line).map(x=>{
  const {kind,fields}=decodeWitness(x.line);
  return {kind,...fields};
});

const bindingValues=(exported,name)=>exported.public?records(exported).filter(x=>x.kind==='bind'&&x.name===name).map(x=>x.value):
  exported.sidecar.archive.events.filter(event=>['binding.initialize','binding.write'].includes(event.operation)&&
    exported.sidecar.archive.programs[event.codeId]?.instructions.find(i=>i.siteId===event.siteId)?.arg===name).map(event=>event.result);

test('strict own and inherited getter-only writes enter catch before returning',async()=>{
  for(const inherited of [false,true]){
    const source=strict(declaration(inherited)+
      'try{box.x=2;}catch(e){return 7;}return box.x;');
    const exported=await certified(source,{inherited});
    assert.deepEqual(exported.sidecar.reference.outcome.graph.roots,[['num',7]]);
    const failure=exported.sidecar.archive.events.find(event=>
      event.operation==='property.write'&&event.completion?.errorType==='TypeError');
    assert(failure,'failed strict write must produce its own abrupt completion');
    assert.equal(failure.result,null,'failed assignment must not produce its RHS');
  }
});

test('overwriting the final answer does not invent an intermediate successful assignment',async()=>{
  for(const inherited of [false,true]){
    const source=strict(declaration(inherited)+
      'let answer=0;try{answer=(box.x=2);}catch(e){answer=7;}answer=0;return answer;');
    const exported=await certified(source,{inherited}),steps=exported.public?records(exported):[];
    assert.deepEqual(bindingValues(exported,'answer'),
      [['num',0],['num',7],['num',0]]);
    if(exported.public)assert(steps.some(x=>x.kind==='throw'||x.kind==='transfer'&&x.handler==='catch-or-finally'));
    else assert(exported.sidecar.archive.events.some(e=>e.operation==='property.write'&&e.completion?.errorType==='TypeError'));
    assert.deepEqual(exported.sidecar.reference.outcome.graph.roots,[['num',0]]);
  }
});

test('strict setter success preserves the RHS and throwing setters preserve catch and finally',async()=>{
  for(const inherited of [false,true]){
    const base='let seen=0;const parent={};Object.defineProperty(parent,"x",{get:()=>seen,';
    for(const setter of ['set:v=>{seen=v;return 99;}','set:v=>{seen=v;throw 8;}']){
      const body=base+setter+'});'+
        (inherited?'const box=Object.create(parent);':'const box=parent;')+
        'let assigned=0;try{assigned=(box.x=2);}catch(e){assigned=e;}finally{seen+=10;}'+
        'return assigned+seen;';
      const exported=await certified(strict(body),{inherited});
      const expected=vm.runInNewContext(strict(body)+';run();');
      assert.deepEqual(exported.sidecar.reference.outcome.graph.roots,[encode(expected)]);
      assert.deepEqual(bindingValues(exported,'assigned'),[['num',0],['num',setter.includes('throw')?8:2]]);
    }
  }
});

test('finally can replace a failed strict assignment completion',async()=>{
  for(const tail of ['return 11;','throw 13;']){
    const exported=await certified(strict(declaration(false)+
      'try{box.x=2;}finally{'+tail+'}'));
    assert.equal(exported.sidecar.reference.outcome.kind,tail.startsWith('return')?'return':'throw');
    assert.deepEqual(exported.sidecar.reference.outcome.graph.roots,
      [['num',tail.startsWith('return')?11:13]]);
  }
});

test('an escaping strict getter-only failure retains its declared TypeError outcome',async()=>{
  for(const inherited of [false,true]){
    const exported=await certified(strict(declaration(inherited)+'box.x=2;return 0;'),{inherited});
    assert.equal(exported.sidecar.reference.outcome.kind,'throw');
    const error=exported.sidecar.reference.outcome.graph.objects[0];
    assert.deepEqual(error.properties.find(([name])=>name==='name')[1],['str','TypeError']);
  }
});

test('failed strict assignment evaluates base, key and RHS once without invoking the getter',async()=>{
  const source=strict('let order="";const box={};'+
    'Object.defineProperty(box,"x",{get:()=>{order+="g";return 1;}});'+
    'function base(){order+="b";return box;}'+
    'function key(){order+="k";return "x";}'+
    'function rhs(){order+="r";return 2;}'+
    'try{base()[key()]=rhs();}catch(e){order+="c";}return order;');
  const exported=await certified(source);
  assert.deepEqual(exported.sidecar.reference.outcome.graph.roots,[['str','bkrc']]);
});

function compareScript(source,{returnRuntime=false}={}){
  const runtime=createRuntime().start(source);
  assert.equal(runtime.drive().kind,'terminated');
  const out=Object.values(runtime.state.envs).flatMap(env=>Object.entries(env.bindings))
    .find(([name])=>name==='out')?.[1].token.value;
  assert.deepEqual(describeGraph(realizeGraph(runtime.state.heap,[out])),describeGraph([vm.runInNewContext(source+'\nout;')]));
  assert.equal(validateBundle(runtime.exportRun()).valid,true);
  assert.equal(replayExact(runtime.exportRun()).valid,true);
  return returnRuntime?runtime:out;
}
const ordinary='function get(){return 1;}const box={};Object.defineProperty(box,"x",{get:get});';
const assignment='try{box.x=2;return 2;}catch(e){return 7;}';

test('sloppy getter-only assignments remain silent and yield the RHS',()=>{
  for(const inherited of [false,true]){
    const source='function get(){return 1;}const parent={};'+
      'Object.defineProperty(parent,"x",{get:get});'+
      (inherited?'const box=Object.create(parent);':'const box=parent;')+
      'let out=0;try{out=(box.x=2);}catch(e){out=7;}';
    assert.deepEqual(compareScript(source),['num',2]);
  }
});

test('strictness follows script and function directive prologues and lexical nesting',()=>{
  const cases=[
    ['"use strict";'+ordinary+'function write(){'+assignment+'}let out=write();',7],
    [ordinary+'function write(){"use strict";'+assignment+'}let out=write();',7],
    [ordinary+'function write(){"annotation";"use strict";'+assignment+'}let out=write();',7],
    [ordinary+'const write=function(){"use strict";'+assignment+'};let out=write();',7],
    [ordinary+'function outer(){"use strict";function inner(){'+assignment+'}return inner();}let out=outer();',7],
    [ordinary+'function write(){'+assignment+'}function caller(){"use strict";return write();}let out=caller();',2]
  ];
  for(const [source,expected] of cases)assert.deepEqual(compareScript(source),['num',expected]);
});

test('escaped, parenthesized, block and post-prologue strings do not enable strict assignment',()=>{
  for(const prefix of ['"use\\x20strict";','("use strict");',';"use strict";',
    '{"use strict";}','0;"use strict";']){
    const source=ordinary+'function write(){'+prefix+assignment+'}let out=write();';
    assert.deepEqual(compareScript(source),['num',2],prefix);
  }
});

test('strict training arrows and nested function expressions inherit failed-assignment behavior',async()=>{
  for(const expression of ['()=>{box.x=2;}','function(){box.x=2;}']){
    const exported=await certified(strict(declaration(false)+
      'const write='+expression+';try{write();}catch(e){return e.name;}return "wrong";'));
    assert.deepEqual(exported.sidecar.reference.outcome.graph.roots,[['str','TypeError']]);
  }
});

test('readonly data assignments match owned/native TypeErrors while historical source projection keeps its descriptor guard',async()=>{
  for(const descriptor of ['{value:1}','{value:1,writable:false}','{writable:false}']){
    const source=strict('const box={};Object.defineProperty(box,"x",'+descriptor+');let error="";let assigned=0;'+
      'try{assigned=(box.x=2);}catch(e){error=e.name;}const d=Object.getOwnPropertyDescriptor(box,"x");'+
      'return [error,assigned,box.x,d.value,d.writable,d.enumerable,d.configurable];');
    const {bundle}=runtimeDifferential('',{source}),failure=bundle.events.find(event=>
      event.operation==='property.write'&&event.completion?.errorType==='TypeError');
    assert(failure);assert.equal(failure.result,null);
    const result=await verifyEffectfulTrainingCase({source,entry:'run',
      family:'strict-accessor-negative-control',fixture:{calls:[]}});
    assert.equal(result.status,'projection_refused');
    assert.match(result.reason,/descriptor.*(?:state|profile)|(?:state|profile).*descriptor/i);
  }
});

test('own and inherited readonly data follow strictness without changing descriptors or creating shadows',()=>{
  for(const strictMode of [false,true])for(const inherited of [false,true])for(const descriptor of ['{value:1}','{value:1,writable:false}','{writable:false}']){
    const source=(strictMode?'"use strict";':'')+'const parent={};Object.defineProperty(parent,"x",'+descriptor+');'+
      (inherited?'const box=Object.create(parent);':'const box=parent;')+
      'let assigned=-1;let error="";try{assigned=(box.x=2);}catch(e){error=e.name;}const d=Object.getOwnPropertyDescriptor(parent,"x");'+
      'let out=[assigned,error,box.x,Object.hasOwn(box,"x"),d.value,d.writable,d.enumerable,d.configurable];';
    const runtime=compareScript(source,{returnRuntime:true}),write=runtime.events.find(event=>
      event.operation==='property.write'&&(event.operands[1]?.[1]==='x'||event.completion?.errorType==='TypeError'));
    assert(write);assert.deepEqual(write.result,strictMode?null:['num',2]);
    assert.equal(write.completion?.errorType,strictMode?'TypeError':undefined);
    assert(!write.stateChanges.some(change=>change.table==='heap'&&change.before!==null),
      'failed data assignment must leave the existing heap and descriptors untouched');
  }
});

test('readonly simple and compound assignments retain evaluation order and their sloppy expression values',()=>{
  for(const strictMode of [false,true])for(const inherited of [false,true])for(const expression of [
    'base()[key()]=rhs()','base()[key()]+=rhs()'
  ]){
    const source=(strictMode?'"use strict";':'')+'let order="";const parent={};Object.defineProperty(parent,"x",{value:"1"});'+
      (inherited?'const box=Object.create(parent);':'const box=parent;')+
      'function base(){order+="b";return box;}function key(){order+="k";return "x";}function rhs(){order+="r";return 2;}'+
      'let assigned=0;let error="";try{assigned=('+expression+');}catch(e){order+="c";error=e.name;}'+
      'let out=[order,assigned,error,box.x,Object.hasOwn(box,"x"),Object.getOwnPropertyDescriptor(parent,"x").writable];';
    compareScript(source);
  }
});

test('strict readonly prefix and postfix updates evaluate the reference once and never commit a shadow',()=>{
  for(const inherited of [false,true])for(const expression of ['++base()[key()]','base()[key()]++']){
    const body='let order="";const parent={};Object.defineProperty(parent,"x",{value:"1"});'+
      (inherited?'const box=Object.create(parent);':'const box=parent;')+
      'function base(){order+="b";return box;}function key(){order+="k";return "x";}'+
      'let assigned=0;let error="";try{assigned=('+expression+');}catch(e){order+="c";error=e.name;}'+
      'return [order,assigned,error,box.x,Object.hasOwn(box,"x")];';
    const {bundle}=runtimeDifferential(body),write=bundle.events.find(event=>event.operation==='property.update');
    assert.equal(write.completion?.errorType,'TypeError');assert.equal(write.result,null);
    assert(!write.stateChanges.some(change=>change.table==='heap'&&change.before!==null));
  }
});

test('escaping strict readonly errors retain native messages for ordinary, null-prototype and Symbol properties',()=>{
  for(const body of [
    'const box={};Object.defineProperty(box,"x",{value:1});box.x=2;',
    'const parent={};Object.defineProperty(parent,"x",{value:1});const box=Object.create(parent);box.x=2;',
    'const box=Object.create(null);const key=Symbol("x");Object.defineProperty(box,key,{value:1});box[key]=2;'
  ])runtimeDifferential(body);
});

test('writable inherited data still shadows normally and builtin writes retain throwing semantics',()=>{
  compareScript('const parent={};Object.defineProperty(parent,"x",{value:1,writable:true});const box=Object.create(parent);'+
    'box.x=2;const d=Object.getOwnPropertyDescriptor(box,"x");let out=[box.x,parent.x,d.writable,d.enumerable,d.configurable];');
  compareScript('const box={};Object.defineProperty(box,"x",{value:1});let error="";try{Object.assign(box,{x:2});}catch(e){error=e.name;}let out=[error,box.x];');
});
