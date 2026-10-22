import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { validateBundle, reconstruct } from '../src/validation.js';
import { replayExact } from '../src/replay.js';
import { causalPrefix } from '../src/causal.js';
import { parse, compile } from '../src/frontend.js';

const wire = value => JSON.parse(JSON.stringify(value));
const binding = (runtime, name='result') => Object.values(runtime.state.envs)
  .flatMap(env=>Object.entries(env.bindings)).find(([key])=>key===name)?.[1]?.token?.value;
function run(source, options) {
  const runtime=createRuntime(options).start(source), progress=runtime.drive();
  const bundle=wire(runtime.exportRun());
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return {runtime,progress,bundle};
}

test('arithmetic is an owned phase continuation with typed commands and source identities',()=>{
  const {runtime,bundle}=run('let result = 2 + 3;');
  assert.deepEqual(binding(runtime),['num',5]);
  const events=bundle.events.filter(e=>e.spec);
  assert.deepEqual(events.map(e=>e.spec.phase),[
    'left-primitive','right-primitive','select',
    'left-numeric','left-numeric-primitive','left-numeric-kind','left-number',
    'right-numeric','right-numeric-primitive','right-numeric-kind','right-number',
    'numeric-types','apply','complete'
  ]);
  const [record]=Object.values(runtime.state.operations);
  assert.equal(record.status,'completed');assert.equal(record.phase,'done');
  for(const event of events) {
    assert.equal(event.siteId,record.siteId);assert.equal(event.codeId,record.codeId);
    assert.match(event.spec.clause,/^sec-/);assert.match(event.spec.engineRevision,/^[a-f0-9]{40}$/);
    assert.equal(event.stateChanges.filter(p=>p.table==='operations').length,1);
  }
  const commands=bundle.events.flatMap(e=>e.stateChanges).filter(p=>p.table==='operations');
  assert.equal(commands[0].kind,'operation.create');assert.equal(commands.at(-1).kind,'operation.complete');
  assert(commands.every(p=>p.kind!=='operations.replace'));
  const apply=events.find(e=>e.spec.phase==='apply');
  const afterApply=reconstruct(bundle,{throughEventId:apply.eventId});
  assert.equal(afterApply.frames[record.frameId].stack.length,0,'result stays in operation until return phase');
  assert.deepEqual(afterApply.operations[record.id].completion.value.value,['num',5]);
});

test('primitive conversions preserve special numeric/string results and ordering',()=>{
  const cases=[
    ['true + null',['num',1]], ['undefined + 2',['num','NaN']], ["'2' - false",['num',2]],
    ["' 0x10 ' * 2",['num',32]], ["'' / 2",['num',0]], ["'bad' - 1",['num','NaN']],
    ["'x' + null",['str','xnull']], ["'x' + undefined",['str','xundefined']],
    ["'x' + (-0)",['str','x0']], ["'x' + 9007199254740993n",['str','x9007199254740993']],
    ['(-0) * 2',['num','-0']], ['1 / (-0)',['num','-Infinity']], ['0 / 0',['num','NaN']],
    ['2 ** (-2)',['num',0.25]], ['0n ** 0n',['bigint','1']], ['(-7n) % 3n',['bigint','-1']],
    ['7n / (-3n)',['bigint','-2']], ['9007199254740993n + 2n',['bigint','9007199254740995']]
  ];
  for(const [expression,expected] of cases) {
    const {runtime,progress}=run('let result = '+expression+';');
    assert.equal(progress.kind,'terminated',expression);assert.deepEqual(binding(runtime),expected,expression);
  }
  const {bundle}=run("let result='x'+2;");
  const conversions=bundle.events.filter(e=>e.operation==='spec.to-string');
  assert.deepEqual(conversions.map(e=>e.spec.phase),['left-string','right-string']);
  assert(!bundle.events.some(e=>e.operation==='spec.to-numeric'));
});

test('primitive abrupt completions are journaled, replayed and stop later effects',()=>{
  for(const [expression,errorType] of [
    ['1n + 1','TypeError'],['1 - 1n','TypeError'],['1n / 0n','RangeError'],
    ['1n % 0n','RangeError'],['2n ** (-1n)','RangeError']
  ]) {
    let writes=0;
    const {runtime,progress,bundle}=run('let result='+expression+'; host.store("bad",1);',{
      adapters:{'demo.store':()=>{writes++;return {kind:'normal',value:undefined};}}
    });
    assert.equal(progress.kind,'runtime.failure',expression);assert.equal(writes,0);
    assert.equal(runtime.state.control.a0.failure.completion.errorType,errorType);
    assert(bundle.events.some(e=>e.completion?.type==='throw'));
    assert(causalPrefix(bundle).events.some(e=>e.completion?.errorType===errorType));
  }
});

test('owned valueOf is an observable guest call with this and arithmetic continuation',()=>{
  for(const [expression,expected] of [
    ['object + 1',['num',10]],
    ["'x' + object",['str','x9']],
    ['object * 2',['num',18]]
  ]) {
    let calls=0;
    const {runtime,progress,bundle}=run('function convert(){host.store("converted",this.tag);return 9;}'+
      'let object={tag:1,valueOf:convert};let result='+expression+';',{
      adapters:{'demo.store':()=>{calls++;return {kind:'normal',value:undefined};}}
    });
    assert.equal(progress.kind,'terminated');assert.equal(calls,1);
    assert.deepEqual(binding(runtime),expected);
    assert(bundle.events.some(e=>e.operation==='spec.internal.call'));
    assert(bundle.events.some(e=>e.operation==='reference.this'));
    assert(bundle.events.some(e=>e.operation==='spec.internal.return'));
  }
});

test('unmodeled function object coercion stays unsupported and calls no host code',()=>{
  const {progress,runtime}=run('function f(){}let result=f+1;');
  assert.equal(progress.kind,'unsupported');
  assert.equal(runtime.state.control.a0.failure.completion.feature,'ToPrimitive(Object)');
});

test('terminal guest throw or arithmetic failure cannot drain already queued jobs',()=>{
  for(const tail of ['throw "stop";','let result=1n+1;','function f(){}let result=f+1;']) {
    let stores=0;
    const {runtime,progress}=run('async function later(){await Promise.resolve(1);host.store("bad",2);}later();'+tail,{
      adapters:{'demo.store':()=>{stores++;return {kind:'normal',value:undefined};}}
    });
    assert(['runtime.failure','unsupported'].includes(progress.kind));
    assert.equal(stores,0);assert.equal(runtime.state.control.a0.queue.length,1);
  }
});

test('JSON round trips at every phase preserve the continuation without native generator state',()=>{
  for(const expression of ['true + null',"'x' + 2",'2n ** (-1n)','{} + 2']) {
    const source='let result='+expression+';', original=createRuntime().start(source),snapshots=[];
    while(original.state.control.a0.activeFrameId) {
      original.step();
      const frame=original.state.frames[original.state.control.a0.activeFrameId];
      if(frame?.operationId) snapshots.push(wire({state:original.state,events:original.events,
        initialState:original.initialState,checkpoints:original.checkpoints,chunkStart:original.chunkStart,
        chunkBefore:original.chunkBefore,chunks:original.chunks}));
    }
    original.drive();const expected=wire(original.exportRun());assert(snapshots.length>0);
    for(const snapshot of snapshots) {
      // Test-only reconstruction: compiled code comes from source, and all
      // continuation data comes from the JSON snapshot. This is not a durable
      // restore API or permission to trust arbitrary archived checkpoints.
      const restored=createRuntime().start(source);Object.assign(restored,snapshot);restored.drive();
      assert.deepEqual(wire(restored.exportRun()),expected);
    }
  }
});

test('typed spec commands reject missing writes, wrong versions, malformed phases and provenance',()=>{
  const {bundle}=run('let result=2+3;');
  const mutate=callback=>{const changed=wire(bundle);callback(changed);assert.throws(()=>validateBundle(changed));};
  const phase=(b,p)=>b.events.find(e=>e.spec?.phase===p);
  const command=e=>e.stateChanges.find(p=>p.table==='operations');
  mutate(b=>{command(phase(b,'left-primitive')).writes=[];});
  mutate(b=>{command(phase(b,'left-primitive')).expectedVersion++;});
  mutate(b=>{command(phase(b,'left-primitive')).to='apply';});
  mutate(b=>{command(phase(b,'left-primitive')).writes[0].after.origin='a0:e999';});
  mutate(b=>{phase(b,'select').operands=[['num',200],['num',300]];phase(b,'select').operandOrigins=[];});
  mutate(b=>{phase(b,'apply').spec.clause='sec-invented';});
  mutate(b=>{phase(b,'apply').invocationId='f999';});
  mutate(b=>{b.events.find(e=>e.operation==='primitive.binary').invocationId='f999';});
  mutate(b=>{const event=phase(b,'left-primitive');event.completion={type:'throw',errorType:'TypeError',message:'fake',origin:event.eventId};});
  mutate(b=>{const event=phase(b,'complete');event.stateChanges.push(wire(command(event)));});
  mutate(b=>{command(phase(b,'complete')).completion.value.value=['num',999];});
});

test('a structurally coherent arithmetic lie is rejected by deterministic replay',()=>{
  const {bundle}=run('let result=2+3;');
  const replace=value=>{
    if(Array.isArray(value)&&value[0]==='num'&&value[1]===5)value[1]=6;
    else if(value&&typeof value==='object')for(const child of Object.values(value))replace(child);
  };
  replace(bundle);
  assert.equal(validateBundle(bundle).valid,true,'structure is not arithmetic correctness');
  assert.throws(()=>replayExact(bundle),/semantic event/);
  const forgedProfile=run('let result=1;').bundle;forgedProfile.manifest.completeEcma262=true;
  assert.throws(()=>replayExact(forgedProfile),/runtime profile manifest/);
});

test('noncanonical external scalar tags are refused before arrival commits',()=>{
  const runtime=createRuntime().start('let value=host.readNumber("x");let result=value+0;');runtime.drive();
  const effectId=Object.values(runtime.state.effects)[0].id, before=wire(runtime.exportRun());
  for(const value of [['num',NaN],['num',Infinity],['num',-0],['bigint','-0'],['bigint','01']]) {
    assert.throws(()=>runtime.recordInputArrival({effectId,kind:'immediate',value}),/canonical/);
    assert.deepEqual(wire(runtime.exportRun()),before);
  }
  const input=runtime.recordInputArrival({effectId,kind:'immediate',value:NaN});
  runtime.deliverInput(input.inputId);runtime.drive();
  assert.deepEqual(binding(runtime),['num','NaN']);assert.equal(replayExact(wire(runtime.exportRun())).valid,true);
});

test('update expressions and unparenthesized unary or await exponentiation fail before execution',()=>{
  for(const source of ['let x=1;++x;','let x=1;x++;','let x=1;--x;','let x=1;x--;',
    'let result=-2 ** 2;','let result=+2 ** 2;','let result=typeof 2 ** 2;',
    'async function f(){let result=await 2 ** 3;}f();'])
    assert.throws(()=>compile(parse(source)),SyntaxError,source);
  assert.deepEqual(binding(run('let result=(-2) ** 2;').runtime),['num',4]);
  assert.deepEqual(binding(run('let result=2 ** -2;').runtime),['num',0.25]);
  const {progress}=run('async function f(){let result=(await 2) ** 3;}f();');
  assert.equal(progress.kind,'terminated');
});

test('private host arrival cannot change arithmetic-visible prefixes before delivery',()=>{
  const capture=value=>{
    const runtime=createRuntime().start('let input=host.readNumber("x");let result=input+2;');runtime.drive();
    runtime.recordInputArrival({effectId:Object.values(runtime.state.effects)[0].id,kind:'immediate',value});
    return causalPrefix(runtime.exportRun());
  };
  assert.deepEqual(capture(1),capture(999));
});

test('host abruptness stays private until delivery then differs from the same normal payload',()=>{
  const capture=abrupt=>{
    const runtime=createRuntime().start('host.readNumber("x");');runtime.drive();
    const input=runtime.recordInputArrival({effectId:Object.values(runtime.state.effects)[0].id,
      kind:'immediate',value:'same payload',abrupt});
    const before=causalPrefix(runtime.exportRun());
    runtime.deliverInput(input.inputId);runtime.drive();
    const bundle=wire(runtime.exportRun());assert.equal(replayExact(bundle).valid,true);
    return {before,after:causalPrefix(bundle)};
  };
  const normal=capture(false), abrupt=capture(true);
  assert.deepEqual(normal.before,abrupt.before);
  assert.equal(normal.after.events.find(e=>e.supplied).supplied.completion,'normal');
  assert.equal(abrupt.after.events.find(e=>e.supplied).supplied.completion,'throw');
});
