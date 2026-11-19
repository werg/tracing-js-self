import test from 'node:test';
import assert from 'node:assert/strict';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {verifyAlgorithmTrainingCase} from '../src/semantic/compiler.js';
import {encodeDetailedRecord,decodeDetailedRecord,projectDetailedV7,verifyDetailedProjection,
  validateDetailedProjection} from '../src/semantic/detailed-v7.js';
import {buildSemanticFamilyRegistry,verifySemanticFamilyRegistry,
  validateSemanticFamilyAssignments,semanticSplitIdentity} from '../src/semantic/family-registry.js';
import {buildSemanticV7Dataset} from '../src/semantic/dataset-v7.js';
import {buildCausalLmV7Examples,causalLmV7Prompt,encodeCausalLmV7Example} from '../src/semantic/causal-lm-v7.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const fixture=id=>structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id===id));
const eosTokenId=256;
const tokenizer={identity:'a'.repeat(64),encode:text=>[...Buffer.from(text,'utf8')],
  decode:ids=>Buffer.from(ids)};

test('v7 detail codec uses strict typed wrappers and rejects old or fragment records',()=>{
  const line=encodeDetailedRecord({kind:'transfer',fields:{kind:'throw',value:['num',2],handler:'catch'}},
    {role:'generated'});
  assert.equal(line,'detail {"fields":{"handler":"catch","kind":"throw","value":["num",2]},"kind":"transfer"}');
  assert.deepEqual(decodeDetailedRecord(line,{role:'generated'}),
    {kind:'transfer',fields:{handler:'catch',kind:'throw',value:['num',2]}});
  assert.throws(()=>decodeDetailedRecord('return 2',{role:'generated'}),/detail record/);
  for(const kind of ['value-open','value-part','value-close'])
    assert.throws(()=>encodeDetailedRecord({kind,fields:kind==='value-open'?{id:'r1',type:'semantic-record'}:
      kind==='value-part'?{id:'r1',data:'return 1'}:{id:'r1'}}),/fragments/);
  assert.throws(()=>decodeDetailedRecord(line,{role:'observed'}),/observed detail/);
});

test('semantic-family registry joins lineage, exact source, and normalized-core variants before splitting',()=>{
  const sources=[
    {id:'lineage-a',family:'family-a',source:'"use strict";function run(n){return n+1;}',entry:'run'},
    {id:'lineage-b',family:'family-a',source:'"use strict";function run(n){return n+2;}',entry:'run'},
    {id:'same-core',family:'family-b',source:'"use strict";function run(value){return value+1;}',entry:'run'},
    {id:'same-source',family:'family-c',source:'"use strict";function run(n){return n+1;}',entry:'run'}
  ];
  const registry=buildSemanticFamilyRegistry(sources,{seed:29,families:['family-b']});
  assert.equal(verifySemanticFamilyRegistry(registry).valid,true);
  assert.equal(registry.components.length,1);
  assert.equal(registry.components[0].split,'test');
  const identities=sources.map(row=>semanticSplitIdentity(registry,row));
  const assigned=sources.map((row,index)=>({...row,split:identities[index].split,splitIdentity:identities[index]}));
  assert.equal(validateSemanticFamilyAssignments(registry,assigned).valid,true);
  assert.throws(()=>validateSemanticFamilyAssignments(registry,[{...assigned[0],family:'renamed'}]),/relabeled/);
  assert.throws(()=>validateSemanticFamilyAssignments(registry,[{...assigned[0],split:'train'}]),/forged|mixed/);
  const changed=structuredClone(registry);changed.sources.pop();
  assert.throws(()=>verifySemanticFamilyRegistry(changed),/digest|membership/);
});

const unsupportedIds=['branch-1','throw-finally','rejection-finally','callback-captured-write',
  'persistent-external-trigger'];
let fallbacks;
test('all five existing unsupported gallery cases now export independently replayable v7 detailed fallbacks',
  {timeout:180000},async()=>{
    fallbacks=new Map();
    for(const id of unsupportedIds){
      const result=await verifyAlgorithmTrainingCase(fixture(id));
      assert.equal(result.status,'detailed-fallback',id+': '+result.reason);
      assert.equal(result.representation,'detailed');
      assert.equal(result.profile,'selected-detailed/1');
      assert.equal(result.exported.public.schema,'semantic-execution/7');
      assert.equal(result.exported.public.traceFormat,'semantic-trace/7');
      assert.equal(result.exported.public.representation,'detailed');
      assert.equal(result.exported.sidecar.schema,'semantic-algorithm-evidence/2');
      assert.equal(result.exported.sidecar.profile,'selected-detailed/1');
      assert.equal(verifyDetailedProjection(result.exported).valid,true);
      fallbacks.set(id,result.exported);
    }
  });

test('source replay rejects wrong observations and v7 context validation rejects future observations',()=>{
  assert.ok(fallbacks,'fallback fixtures have not been prepared');
  const original=fallbacks.get('branch-1');
  const wrong=structuredClone(original.sidecar.sourceArtifact);
  const resultRow=wrong.public.timeline.find(row=>row.kind==='result');
  resultRow.result=['num',999];
  assert.throws(()=>projectDetailedV7(wrong),/result and observed witness disagree/);

  const future=structuredClone(original),firstTarget=future.public.timeline.find(row=>row.kind==='semantic');
  const observed=future.public.timeline.find(row=>row.kind==='result');
  const context=future.contexts[0];
  const translated=structuredClone(observed);translated.schema='semantic-execution/7';
  const {kind,fields}=decodeDetailedRecord(context.prefix.realmCommitted.find(row=>row.kind==='semantic')?.line??
    future.public.timeline.find(row=>row.kind==='semantic').line,{role:'generated'});
  assert.ok(kind&&fields);
  context.prefix.realmCommitted.push(translated);
  context.prefix.committed.push(translated);
  context.visibleThrough=observed.sequence;
  context.prefixDigest=hashAlgorithmData(context.prefix);
  future.sidecar.contextDigest=hashAlgorithmData(future.contexts);
  assert.ok(firstTarget.sequence<observed.sequence);
  assert.throws(()=>validateDetailedProjection(future),/context target alignment/);
});

test('v7 prepared contexts hide private future data until the observation is committed',
  {timeout:120000},async()=>{
    const secret='private-canary-after-observation-79f4';
    const candidate=fixture('branch-1');
    candidate.fixture.calls[0].result=secret;
    candidate.fixture.calls[1].arguments[1]=0;
    const verified=await verifyAlgorithmTrainingCase(candidate);
    assert.equal(verified.status,'detailed-fallback',verified.reason);
    const dataset=await buildSemanticV7Dataset([verified],{seed:41,allowLocal:true,
      tokenizer,eosTokenId,maxContextTokens:100000});
    const rows=Object.values(dataset.examplesBySplit).flat();
    const observation=verified.exported.public.timeline.find(row=>row.kind==='result');
    const before=rows.filter(row=>row.metadata.sequence<observation.sequence);
    const after=rows.filter(row=>row.metadata.sequence>observation.sequence);
    assert.ok(before.length>0);assert.ok(after.length>0);
    assert(before.every(row=>!row.prompt.includes(secret)&&!row.target.includes(secret)));
    assert(after.some(row=>row.prompt.includes(secret)));
    assert.equal(dataset.manifest.admitted,false);
    assert.equal(dataset.manifest.scope,'candidate-local-diagnostic');
  });

test('exact v7 segment encoding masks only public-context tokens',()=>{
  assert.ok(fallbacks,'fallback fixtures have not been prepared');
  const exported=fallbacks.get('throw-finally'),target=exported.public.timeline.find(row=>row.kind==='semantic');
  const context=exported.contexts[0];
  const encoded=encodeCausalLmV7Example(context,target.line,{tokenizer,eosTokenId,
    maxContextTokens:100000,representation:'detailed'});
  assert.deepEqual(encoded.inputIds.slice(0,encoded.boundaries.promptTokens),
    tokenizer.encode(causalLmV7Prompt(context)));
  assert(encoded.labels.slice(0,encoded.boundaries.promptTokens).every(id=>id===-100));
  assert.deepEqual(encoded.labels.slice(encoded.boundaries.promptTokens),
    [...tokenizer.encode(target.line),eosTokenId]);
  assert.throws(()=>encodeCausalLmV7Example(context,target.line,{tokenizer,eosTokenId,
    maxContextTokens:10,representation:'detailed'}),/budget exceeded/);
});

test('old v6 detailed exports cannot be passed through the v7 context projector',()=>{
  assert.ok(fallbacks,'fallback fixtures have not been prepared');
  const artifact=fallbacks.get('throw-finally').sidecar.sourceArtifact;
  assert.equal(artifact.public.schema,'semantic-execution/6');
  assert.throws(()=>validateDetailedProjection(artifact),/public v7 envelope/);
  return assert.rejects(buildCausalLmV7Examples(artifact,{tokenizer,eosTokenId,maxContextTokens:100000,
    allowLocal:true}),/new v7 execution artifact required/);
});
