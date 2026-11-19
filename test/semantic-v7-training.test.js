import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {verifyAlgorithmTrainingCase} from '../src/semantic/compiler.js';
import {encodeDetailedRecord,decodeDetailedRecord,projectDetailedV7,verifyDetailedProjection,
  validateDetailedProjection,DETAILED_CONTINUATION_VERSION} from '../src/semantic/detailed-v7.js';
import {buildSemanticFamilyRegistry,verifySemanticFamilyRegistry,
  validateSemanticFamilyAssignments,semanticSplitIdentity} from '../src/semantic/family-registry.js';
import {buildSemanticV7Dataset,prepareSemanticFamilyRegistry,bindSemanticFamilySplit,
  semanticFamilyMembership} from '../src/semantic/dataset-v7.js';
import {buildCausalLmV7Examples,causalLmV7Prompt,encodeCausalLmV7Example,
  createAlgorithmContextResolver,createCausalLmV7Selector} from '../src/semantic/causal-lm-v7.js';
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
      for(const row of result.exported.public.timeline){
        if(row.kind==='model-context')assert.equal(row.selectedState?.schema,DETAILED_CONTINUATION_VERSION,id);
      }
      for(const context of result.exported.contexts){
        if(context.prefix.selectedState)assert.equal(context.prefix.selectedState.schema,DETAILED_CONTINUATION_VERSION,id);
      }
      assert.equal(verifyDetailedProjection(result.exported).valid,true);
      fallbacks.set(id,result.exported);
    }
  });

test('pre-bound family assignment and complete holdout registry cannot be re-seeded, stripped, or subsetted',()=>{
  assert.ok(fallbacks,'fallback fixtures have not been prepared');
  const packets=['branch-1','throw-finally'].map(id=>({id,status:'detailed-fallback',
    exported:fallbacks.get(id)}));
  const freshMembers=packets.map((packet,index)=>semanticFamilyMembership(packet,index));
  const family=freshMembers[0].family,seed=73;
  const initial=prepareSemanticFamilyRegistry(packets,{seed,families:[family]});
  const original=bindSemanticFamilySplit(packets[0],initial.members[0],initial.registry);
  const boundPacket={id:packets[0].id,status:packets[0].status,exported:original};
  const reboundMember=semanticFamilyMembership(boundPacket);
  assert.equal(reboundMember.id,initial.members[0].id);
  const subset=prepareSemanticFamilyRegistry([boundPacket]);
  assert.equal(subset.registry.digest,initial.registry.digest);
  assert.equal(subset.registry.sources.length,2,'a subset must retain the complete source inventory');
  assert.equal(subset.identityById.get(reboundMember.id).split,'test','the family holdout must survive re-export');
  assert.throws(()=>prepareSemanticFamilyRegistry([boundPacket],{seed:seed+1}),/seed/);
  assert.throws(()=>prepareSemanticFamilyRegistry([boundPacket],{seed,families:[]}),/holdout/);
  assert.throws(()=>prepareSemanticFamilyRegistry([boundPacket,packets[1]],{seed}),/bound and unbound/);
  const again=bindSemanticFamilySplit(boundPacket,subset.members[0],subset.registry);
  assert.equal(again.sidecar.splitIdentity.sourceId,original.sidecar.splitIdentity.sourceId);
  assert.equal(again.sidecar.datasetBinding.registryDigest,original.sidecar.datasetBinding.registryDigest);
  assert.equal(hashAlgorithmData(again.public),hashAlgorithmData(original.public));
  assert.equal(hashAlgorithmData(again.contexts),hashAlgorithmData(original.contexts));
});

test('causal exporter reuses a pre-bound holdout registry across subsets and repeated exports',
  {timeout:120000},()=>{
    assert.ok(fallbacks,'fallback fixtures have not been prepared');
    const sourcePackets=['branch-1','throw-finally'].map(id=>({id,status:'detailed-fallback',
      exported:fallbacks.get(id)}));
    const fresh=prepareSemanticFamilyRegistry(sourcePackets,{seed:83,families:[
      semanticFamilyMembership(sourcePackets[0]).family]});
    const bound=bindSemanticFamilySplit(sourcePackets[0],fresh.members[0],fresh.registry);
    const temporary=mkdtempSync(join(process.cwd(),'semantic-v7-prebound-'));
    try{
      const input=join(temporary,'candidate.jsonl'),adapter=join(temporary,'tokenizer.mjs');
      writeFileSync(input,JSON.stringify({id:sourcePackets[0].id,status:sourcePackets[0].status,exported:bound})+'\n');
      writeFileSync(adapter,`export const tokenizer={identity:'${'a'.repeat(64)}',encode:text=>[...Buffer.from(text,'utf8')],decode:ids=>Buffer.from(ids)};\n`+
        `export const eosTokenId=256;\n`+
        `export const tokenizerEvidence={identity:{fingerprint:'${'a'.repeat(64)}',tokenizerSha256:'${'b'.repeat(64)}'},qualification:{schema:'semantic-codec-meter/1',status:'qualified',scope:'byte-exact-token-meter-only',nativeAdmission:false,consumerRevision:'${'c'.repeat(40)}'}};\n`);
      const exportCorpus=directory=>execFileSync(process.execPath,[resolve('tools/export-algorithm-training.mjs'),
        '--input',input,'--tokenizer-module',adapter,'--max-context','100000','--seed','83','--allow-local',
        '--out',directory],{cwd:process.cwd(),encoding:'utf8'});
      const first=join(temporary,'out-one'),second=join(temporary,'out-two');
      exportCorpus(first);exportCorpus(second);
      const registryOne=JSON.parse(readFileSync(join(first,'family-registry.json'),'utf8'));
      const registryTwo=JSON.parse(readFileSync(join(second,'family-registry.json'),'utf8'));
      assert.equal(registryOne.digest,fresh.registry.digest);
      assert.equal(registryTwo.digest,registryOne.digest);
      assert.equal(registryOne.sources.length,2,'the omitted source must remain in the frozen registry');
      assert.deepEqual(registryOne.holdouts,fresh.registry.holdouts,
        'omitting holdout flags must not clear a pre-bound holdout');
      assert.ok(readFileSync(join(first,'test.jsonl'),'utf8').trim().length>0);
      assert.equal(readFileSync(join(first,'train.jsonl'),'utf8'),readFileSync(join(second,'train.jsonl'),'utf8'));
      assert.equal(readFileSync(join(first,'test.jsonl'),'utf8'),readFileSync(join(second,'test.jsonl'),'utf8'));
      assert.throws(()=>execFileSync(process.execPath,[resolve('tools/export-algorithm-training.mjs'),
        '--input',input,'--tokenizer-module',adapter,'--max-context','100000','--seed','84','--allow-local',
        '--out',join(temporary,'changed-seed')],{cwd:process.cwd(),encoding:'utf8',stdio:'pipe'}),
        /seed cannot replace/);
      assert.throws(()=>execFileSync(process.execPath,[resolve('tools/export-algorithm-training.mjs'),
        '--input',input,'--tokenizer-module',adapter,'--max-context','100000','--seed','83','--allow-local',
        '--holdout-family','different-family','--out',join(temporary,'changed-holdout')],
        {cwd:process.cwd(),encoding:'utf8',stdio:'pipe'}),/holdouts cannot replace/);
    }finally{rmSync(temporary,{recursive:true,force:true});}
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

test('exact v7 segment encoding masks only public-context tokens',async()=>{
  assert.ok(fallbacks,'fallback fixtures have not been prepared');
  const exported=fallbacks.get('throw-finally'),target=exported.public.timeline.find(row=>row.kind==='semantic');
  const context=exported.contexts[0];
  const encoded=await encodeCausalLmV7Example(context,target.line,{tokenizer,eosTokenId,
    maxContextTokens:100000,representation:'detailed'});
  assert.deepEqual(encoded.inputIds.slice(0,encoded.boundaries.promptTokens),
    tokenizer.encode(causalLmV7Prompt(context)));
  assert(encoded.labels.slice(0,encoded.boundaries.promptTokens).every(id=>id===-100));
  assert.deepEqual(encoded.labels.slice(encoded.boundaries.promptTokens),
    [...tokenizer.encode(target.line),eosTokenId]);
  await assert.rejects(encodeCausalLmV7Example(context,target.line,{tokenizer,eosTokenId,
    maxContextTokens:10,representation:'detailed'}),/budget exceeded/);
});

test('algorithm flat prompts resolve earlier public definition/input publications identically for training and serving',
  {timeout:120000},async()=>{
    const candidate=await verifyAlgorithmTrainingCase(fixture('counter-0'));
    assert.equal(candidate.status,'locally_verified');
    assert.equal(candidate.exported.public.representation,'algorithm');
    const contexts=candidate.exported.contexts;
    assert(contexts.length>1);
    assert(Object.hasOwn(contexts[0],'program')&&Object.hasOwn(contexts[0],'inputGraph'));
    assert(contexts.slice(1).every(context=>!Object.hasOwn(context,'program')&&!Object.hasOwn(context,'inputGraph')),
      'later snapshots should exercise hash-only references');
    const dataset=await buildSemanticV7Dataset([candidate],{seed:91,allowLocal:true,tokenizer,eosTokenId,
      maxContextTokens:100000});
    const examples=Object.values(dataset.examplesBySplit).flat();
    assert.equal(examples.length,contexts.length);
    const promptContexts=examples.map(row=>{
      const start=row.prompt.indexOf('\n')+1,end=row.prompt.lastIndexOf('\nNext record:\n');
      return JSON.parse(row.prompt.slice(start,end));
    });
    for(const context of promptContexts){
      assert.equal(context.program.source,fixture('counter-0').source);
      assert.equal(context.program.definitionDigest,context.definition);
      assert.equal(context.program.coreDigest,candidate.exported.sidecar.coreDigest);
      assert.deepEqual(context.inputGraph,contexts[0].inputGraph);
      assert.equal(hashAlgorithmData(context.program),hashAlgorithmData(contexts[0].program));
    }

    const checkpointIdentity='d'.repeat(64),targets=candidate.exported.public.timeline.filter(row=>row.kind==='semantic');
    const servingPrompts=[],runtime={
      async initialize(request){return {checkpointIdentity,tokenizerIdentity:tokenizer.identity,seed:request.seed};},
      async generate(request){
        servingPrompts.push(request.inputIds);
        const target=targets[servingPrompts.length-1].line;
        return {tokenIds:[...tokenizer.encode(target),eosTokenId],stopReason:'eos'};
      }
    };
    const selector=createCausalLmV7Selector({runtime,tokenizer,checkpointIdentity,eosTokenId,
      maxContextTokens:100000,maxNewTokens:10000,representation:'algorithm'});
    await selector.initialize({checkpointIdentity,seed:11});
    for(const context of contexts)await selector(context);
    assert.equal(servingPrompts.length,examples.length);
    for(let index=0;index<examples.length;index++)
      assert.deepEqual(servingPrompts[index],examples[index].inputIds.slice(0,examples[index].boundaries.promptTokens));

    const resolver=createAlgorithmContextResolver();
    resolver.resolve(contexts[0]);resolver.resolve(contexts[1]);
    assert.throws(()=>resolver.resolve(contexts[0]),/moved backward/);
    assert.throws(()=>createAlgorithmContextResolver().resolve(contexts[1]),/not publicly published/);
    const changed=structuredClone(contexts[1]);changed.definition='a'.repeat(64);
    assert.throws(()=>{
      const isolated=createAlgorithmContextResolver();isolated.resolve(contexts[0]);isolated.resolve(changed);
    },/not publicly published/);
  });

test('old v6 detailed exports cannot be passed through the v7 context projector',()=>{
  assert.ok(fallbacks,'fallback fixtures have not been prepared');
  const artifact=fallbacks.get('throw-finally').sidecar.sourceArtifact;
  assert.equal(artifact.public.schema,'semantic-execution/6');
  assert.throws(()=>validateDetailedProjection(artifact),/public v7 envelope/);
  return assert.rejects(buildCausalLmV7Examples(artifact,{tokenizer,eosTokenId,maxContextTokens:100000,
    allowLocal:true}),/new v7 execution artifact required/);
});
