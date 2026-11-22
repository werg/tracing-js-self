import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRegionFamilyRegistry,deriveRegionCoreIdentity,regionSplitIdentity,
  verifyRegionFamilyRegistry,verifyRegionSplitIdentity,validateRegionFamilyAssignments,
  verifyRegionDatasetBinding,REGION_FAMILY_REGISTRY_SCHEMA} from '../src/semantic/family-registry-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {buildRegionDataset,exportRegionDatasetJSONL} from '../src/semantic/dataset-v8.js';
import {V8_CONTRACT_DIGEST,V8_FIXTURE_DIGEST,V8_INTEROPERABILITY_DIGEST,V8_NATIVE_CHECKS} from '../src/semantic/native-v8.js';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const affine='"use strict";function run(x){const y=x+1;return y*2;}';
const alias='"use strict";function run(value){let next=value+1;return next*2;}';
const detailA='"use strict";function run(o){o.x=1;return o;}';
const detailB='"use strict";function run(o){o.y=2;return o;}';
const row=(id,family,source,ancestors=[])=>({id,family,source,entry:'run',ancestors});
const resign=registry=>{const {digest,...body}=registry;registry.digest=hashAlgorithmData(body);return registry;};
const tokenizer={identity:'e'.repeat(64),encode:text=>[...Buffer.from(text)],decode:ids=>Buffer.from(ids)};
const options={tokenizer,eosTokenId:256,maxContextTokens:1000000,allowLocal:true,seed:17};
let fixturePromise;
async function qualified(){
  fixturePromise??=(async()=>{
    const fixture={id:'affine-source',family:'affine-source',ancestorIds:['original-affine'],
      source:affine,entry:'run',args:[3],fixture:{calls:[]}};
    const result=await verifyRegionTrainingCase(fixture);assert(result.exported,JSON.stringify(result));
    return {...fixture,...result};
  })();
  return structuredClone(await fixturePromise);
}
const refused={id:'refused-write',family:'refused-write',ancestors:['original-affine'],source:detailA,
  entry:'run',status:'unsupported',category:'unsupported.fixture',phase:'source',reason:'retained source refusal'};

test('v8 source, /2 core and declared ancestry edges are frozen together before holdout',()=>{
  assert.equal(deriveRegionCoreIdentity(affine,'run').coreDigest,deriveRegionCoreIdentity(alias,'run').coreDigest);
  const sources=[row('a','first',affine),row('b','second',alias,['ancestor']),
    row('c','third',alias),row('d','ancestor',detailA)];
  const registry=buildRegionFamilyRegistry(sources,{seed:71,families:['first']});
  assert.equal(registry.schema,REGION_FAMILY_REGISTRY_SCHEMA);
  assert.equal(registry.components.length,1);
  assert.deepEqual(registry.components[0].members,['ancestor','first','second','third']);
  assert.equal(registry.components[0].split,'test');
  assert.deepEqual(buildRegionFamilyRegistry([...sources].reverse(),{seed:71,families:['first']}),registry);
  assert.equal(verifyRegionFamilyRegistry(registry).valid,true);
  const assignments=sources.map(source=>({...source,split:'test',splitIdentity:regionSplitIdentity(registry,source)}));
  assert.equal(validateRegionFamilyAssignments(registry,assignments,{expectedSplit:'test'}).valid,true);
  for(const source of sources)assert.equal(verifyRegionSplitIdentity(regionSplitIdentity(registry,source),source).valid,true);
});

test('unrelated detailed and refused sources never share a synthetic null-core component',()=>{
  const sources=[row('a','write-x',detailA),row('b','write-y',detailB),
    row('c','malformed','"use strict";function run( {')];
  const registry=buildRegionFamilyRegistry(sources,{seed:13});
  assert.equal(registry.components.length,3);
  assert.deepEqual(registry.sources.map(source=>source.coreDigest),[null,null,null]);
  assert.deepEqual(registry.sources.map(source=>source.coreStatus),['detailed','detailed','source-refused']);
  assert.equal(registry.diagnostics.withoutNormalizedCore,3);
  assert.throws(()=>buildRegionFamilyRegistry([row('pure','affine',affine)].map(x=>({...x,coreDigest:null})),{seed:13}),/source-derived/);
});

test('current v8 registry groups common-shingle clones and holds out the entire related population',()=>{
  const body=Array.from({length:30},(_,i)=>'o.value'+i+'=input+'+i+';').join('');
  const sources=Array.from({length:140},(_,i)=>row('clone-'+i,'family-'+i,
    '"use strict";function run(o,input){'+body+'o.marker='+i+';return o;}'));
  const registry=buildRegionFamilyRegistry(sources,{seed:71,families:['family-0']});
  assert.equal(registry.components.length,1);
  assert.equal(registry.components[0].split,'test');
  assert.equal(registry.diagnostics.cloneAudit.complete,true);
  assert.equal(registry.diagnostics.cloneAudit.comparedSourceVariants,140);
  assert.equal(registry.diagnostics.nearPairs,140*139/2);
  assert(registry.sources.every(source=>source.sourceFingerprintStatus==='tokenized'));
  assert.equal(verifyRegionFamilyRegistry(registry).valid,true);
  assert.deepEqual(buildRegionFamilyRegistry([...sources].reverse(),{seed:71,families:['family-0']}),registry);
});

test('current v8 clone accounting rejects forged fingerprints and retains lexical uncertainty',()=>{
  const sources=[row('quoted','bad-string','"unterminated'),row('comment','empty','/* no tokens */'),
    row('valid','valid',detailA)];
  const registry=buildRegionFamilyRegistry(sources,{seed:17,families:['empty']});
  const audit=registry.diagnostics.cloneAudit;
  assert.equal(audit.complete,false);assert.equal(audit.assessedSources,1);
  assert.deepEqual(audit.unassessedSources,['comment','quoted']);
  assert.equal(audit.unassessedPolicy,'same-component');
  assert.equal(registry.components.find(component=>component.members.includes('empty')).split,'test');
  assert(registry.components.find(component=>component.members.includes('empty')).members.includes('bad-string'));
  assert.equal(verifyRegionFamilyRegistry(registry).valid,true);
  const forged=structuredClone(registry);forged.sources.find(source=>source.id==='valid').sourceFingerprint.alphaHash='0'.repeat(64);
  assert.throws(()=>verifyRegionFamilyRegistry(resign(forged)),/fingerprint differs/);
  const costs=structuredClone(registry);costs.diagnostics.cloneAudit.costs.comparisons++;
  assert.throws(()=>verifyRegionFamilyRegistry(resign(costs)),/changed/);
  assert.throws(()=>buildRegionFamilyRegistry([row('valid','valid',detailA)],{seed:17,cloneBudget:{maxIndexEntries:0}}),
    error=>error.status==='resource_exhausted'&&error.complete===false);
});

test('input expansions do not multiply current v8 clone comparison work or impose a corpus ceiling',()=>{
  const sources=Array.from({length:20001},(_,i)=>row('input-'+i,'same-family',affine));
  const registry=buildRegionFamilyRegistry(sources,{seed:17,cloneBudget:{maxComparisons:0}});
  assert.equal(registry.sources.length,20001);
  assert.equal(registry.diagnostics.cloneAudit.comparedSourceVariants,1);
  assert.equal(registry.diagnostics.cloneAudit.costs.comparisons,0);
  assert.equal(registry.components.length,1);
});

test('rehashing cannot relabel a frozen member, change a component, substitute v7 or erase a holdout',()=>{
  const source=row('a','held-out',affine,['original']);
  const registry=buildRegionFamilyRegistry([source],{seed:7,families:['original']});
  const identity=regionSplitIdentity(registry,source);
  const altered=structuredClone(identity);altered.split='train';
  assert.throws(()=>verifyRegionSplitIdentity(altered,source),/split assignment/);
  assert.throws(()=>verifyRegionSplitIdentity(identity,{...source,family:'rename'}),/relabeled/);
  assert.throws(()=>verifyRegionSplitIdentity(identity,{...source,ancestors:[]}),/changed source/);
  const forged=structuredClone(registry);forged.components[0].split='train';
  assert.throws(()=>verifyRegionFamilyRegistry(resign(forged)),/membership|split/);
  const missing=structuredClone(registry);missing.components[0].holdout=null;
  assert.throws(()=>verifyRegionFamilyRegistry(resign(missing)),/holdout/);
  const legacy=structuredClone(registry);legacy.schema='semantic-family-registry/1';
  assert.throws(()=>verifyRegionFamilyRegistry(resign(legacy)),/unsupported/);
  assert.throws(()=>validateRegionFamilyAssignments(registry,[{...source,split:'train'}]),/forged/);
  assert.throws(()=>buildRegionFamilyRegistry([source],{seed:7,coreDigests:['0'.repeat(64)]}),/unknown/);
});

test('whole local artifacts, lazy causal masks and original source refusal denominator are exported together',async()=>{
  const result=await buildRegionDataset([await qualified(),refused,
    {id:'no-source',family:'original-missing-family',status:'unsupported',reason:'no exact source'}],
    {...options,families:['original-affine']});
  assert.equal(result.manifest.inputCandidates,3);assert.equal(result.dispositions.length,3);
  assert.equal(result.manifest.refusalCount,2);assert.equal(result.manifest.exactSourceVariants,2);
  assert.equal(result.manifest.admitted,false);assert.equal(result.manifest.nativeRequired,false);
  assert.equal(result.manifest.optimizerSteps,0);assert.equal(result.manifest.learnedSuccess,null);
  assert.equal(result.registry.components.length,1,'refused lineage participates before splitting');
  assert.equal(result.artifactsBySplit.test.length,1);assert.equal(result.examplesBySplit.test.length,2);
  assert.equal(result.dispositions[1].family,'refused-write');assert.equal(result.dispositions[1].split,'test');
  assert.equal(result.dispositions[2].family,'original-missing-family');assert.equal(result.dispositions[2].split,null);
  const artifact=result.artifactsBySplit.test[0].exported;
  assert.equal(verifyRegionDatasetBinding(artifact,{expectedSplit:'test'}).valid,true);
  assert.equal(artifact.sidecar.sourceArtifact.sidecar.referenceInput.source,affine);
  assert.deepEqual(artifact.sidecar.splitIdentity.ancestors,['original-affine']);
  for(const example of result.examplesBySplit.test){
    assert.equal(example.metadata.split,'test');assert.equal(example.metadata.nativeAdmission,false);
    assert.deepEqual(example.labels.slice(0,example.boundaries.promptTokens),
      Array(example.boundaries.promptTokens).fill(-100));
    assert.deepEqual(example.labels.slice(example.boundaries.promptTokens),[...Buffer.from(example.target),256]);
    assert.equal(example.prompt.includes('splitIdentity'),false);assert.equal(example.prompt.includes('sourceArtifact'),false);
  }
});

test('production export rejects absent native admission and never emits part of a refused episode',async()=>{
  const candidate=await qualified();
  const production=await buildRegionDataset([candidate],{...options,allowLocal:false});
  assert.equal(production.manifest.nativeRequired,true);assert.equal(production.manifest.admitted,false);
  assert.equal(production.dispositions[0].status,'export-refused');
  assert.match(production.dispositions[0].reason,/pinned consumer|native/i);
  assert.equal(Object.values(production.examplesBySplit).flat().length,0);
  assert.equal(Object.values(production.artifactsBySplit).flat().length,0);
  const budget=await buildRegionDataset([candidate],{...options,maxExamplesPerEpisode:1});
  assert.equal(budget.dispositions[0].status,'export-refused');assert.match(budget.dispositions[0].reason,/partial episodes/);
  assert.equal(Object.values(budget.examplesBySplit).flat().length,0);
  const context=await buildRegionDataset([candidate],{...options,maxContextTokens:64});
  assert.equal(context.dispositions[0].status,'export-refused');assert.match(context.dispositions[0].reason,/truncation is forbidden/);
  assert.equal(context.manifest.registeredCandidates,1);
});

test('bound artifact reexport preserves the complete registry and rejects seed, holdout, family and byte changes',async()=>{
  const original=await buildRegionDataset([await qualified(),refused],{...options,families:['original-affine']});
  const item=original.artifactsBySplit.test[0];
  const {seed,...withoutSeed}=options;
  const reused=await buildRegionDataset([item],withoutSeed);
  assert.deepEqual(reused.registry,original.registry);assert.equal(reused.manifest.registryMembers,2);
  assert.deepEqual(reused.artifactsBySplit.test[0].exported,item.exported);
  await assert.rejects(buildRegionDataset([item],{...options,seed:18}),/frozen split seed/);
  await assert.rejects(buildRegionDataset([item],{...options,families:[]}),/frozen holdouts/);
  await assert.rejects(buildRegionDataset([{...item,family:'renamed'}],options),/relabels/);
  await assert.rejects(buildRegionDataset([item,refused],options),/bound and unbound/);
  const artifact=structuredClone(item.exported);artifact.contexts[0].state.locals.push(['future',['num',9]]);
  assert.throws(()=>verifyRegionDatasetBinding(artifact),/binding|bytes/);
  const target=structuredClone(item.exported);target.public.timeline.at(-1).fields.line+=' ';
  assert.throws(()=>verifyRegionDatasetBinding(target),/binding|bytes/);
  const source=structuredClone(item.exported);source.sidecar.sourceArtifact.sidecar.ancestorIds=['changed'];
  assert.throws(()=>verifyRegionDatasetBinding(source),/source member/);
});

test('native receipt transport retains the validated receipt and isolates consumer mutation (unit fixture only)',async()=>{
  // This exercises the receipt transport contract, not an independent native
  // execution. No resulting artifact or admission claim is written to disk.
  const nativePolicy={schema:'semantic-native-policy/8',consumerRepository:'werg/megatoken',
    consumerRevision:'a'.repeat(40),contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,
    tokenizerIdentity:tokenizer.identity,tokenizerSha256:'b'.repeat(64)};
  let receipt;
  const result=await buildRegionDataset([await qualified()],{...options,allowLocal:false,nativePolicy,
    nativeConsumer:async artifact=>{
      receipt={schema:'semantic-native-admission/8',componentGate:'native-consumer-only',
        traceFormat:'semantic-trace/8',contextFormat:'semantic-context/8',representation:'mixed',admitted:true,
        consumerRevision:nativePolicy.consumerRevision,contractDigest:V8_CONTRACT_DIGEST,fixtureDigest:V8_FIXTURE_DIGEST,interoperabilityDigest:V8_INTEROPERABILITY_DIGEST,
        publicDigest:hashAlgorithmData(artifact.public),contextsDigest:hashAlgorithmData(artifact.contexts),
        sourceArtifactDigest:artifact.sidecar.sourceArtifactDigest,datasetBindingDigest:hashAlgorithmData(artifact.sidecar.datasetBinding),
        sourceVerification:{schema:'semantic-native-source-recheck/1',producerRevision:'d'.repeat(40),producerTreeClean:true,
          artifactSha256:'e'.repeat(64),sourceArtifactDigest:hashAlgorithmData(artifact.sidecar.sourceArtifact),
          publicDigest:hashAlgorithmData(artifact.public),contextDigest:hashAlgorithmData(artifact.contexts),
          sourceValidated:true,projectionValidated:true,replayValidated:true},
        nativeTrainingDigest:'c'.repeat(64),optimizerSteps:0,learningClaim:null,
        tokenizer:{status:'passed',identity:tokenizer.identity,sha256:nativePolicy.tokenizerSha256},
        checks:Object.fromEntries(V8_NATIVE_CHECKS.map(key=>[key,'passed'])),
        counts:{records:artifact.public.timeline.length,contexts:artifact.contexts.length,
          generatedRecords:artifact.contexts.length,generatedTokens:100,observedTokens:1000}};
      artifact.sidecar.consumerMutation='must not escape transport copy';return receipt;
    }});
  assert.equal(result.dispositions[0].status,'exported',result.dispositions[0].reason);
  const artifact=Object.values(result.artifactsBySplit).flat()[0].exported;
  assert.deepEqual(artifact.sidecar.nativeAdmission,receipt);assert.equal(artifact.sidecar.admission,'admitted');
  assert.equal(Object.hasOwn(artifact.sidecar,'consumerMutation'),false);
  assert.equal(verifyRegionDatasetBinding(artifact).valid,true);
});

test('duplicate and entirely refused inventories keep every candidate and do not fabricate admitted rows',async()=>{
  const candidate=await qualified(),duplicates=await buildRegionDataset([candidate,candidate],options);
  assert.equal(duplicates.manifest.inputCandidates,2);assert.equal(duplicates.manifest.duplicateCount,1);
  assert.equal(duplicates.manifest.registryMembers,1);assert.equal(duplicates.dispositions[1].duplicateOf,0);
  const empty=await buildRegionDataset([{status:'invalid-jsonl',reason:'parse failed'},
    {status:'unsupported',family:'unchanged',reason:'missing source'}],options);
  assert.equal(empty.registry,null);assert.equal(empty.manifest.refusalCount,2);
  assert.equal(empty.manifest.admitted,false);assert.equal(empty.dispositions[1].family,'unchanged');
});

test('bare verified source failures retain their hashed original source and lineage in the inventory',async()=>{
  const source='"use strict";function run( {';
  const failure=await verifyRegionTrainingCase({source,entry:'run',family:'syntax-refusal',
    ancestorIds:['malformed-source'],fixture:{calls:[]}});
  assert(failure.failure,'fixture must produce a preserved source failure');
  const dataset=await buildRegionDataset([failure],options);
  assert.equal(dataset.registry.sources[0].source,source);
  assert.equal(dataset.registry.sources[0].family,'syntax-refusal');
  assert.deepEqual(dataset.registry.sources[0].ancestors,['malformed-source']);
  assert.equal(dataset.dispositions[0].status,'source-refused');
  assert.equal(dataset.manifest.registeredCandidates,1);
  await assert.rejects(buildRegionDataset([{...failure,family:'renamed'}],options),/original source failure/);
  const altered=structuredClone(failure);altered.failure.original.source=affine;
  await assert.rejects(buildRegionDataset([altered],options),/failure evidence changed/);
});

test('JSONL export writes complete artifacts, all dispositions and verified file hashes without replacing a directory',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'semantic-v8-dataset-'));
  try{
    const result=await exportRegionDatasetJSONL([await qualified(),refused],
      {...options,outputDirectory:join(parent,'corpus')});
    const manifest=JSON.parse(await readFile(join(result.directory,'manifest.json'),'utf8'));
    assert.equal(manifest.dispositionRows,2);assert.equal(manifest.inputCandidates,2);
    for(const file of Object.values(manifest.files)){
      const bytes=await readFile(join(result.directory,file.file));
      assert.equal(bytes.length,file.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
      assert.equal(bytes.toString().split('\n').filter(Boolean).length,file.rows);
    }
    const split=Object.entries(result.artifactsBySplit).find(([,items])=>items.length)[0];
    const artifact=JSON.parse(await readFile(join(result.directory,split+'-artifacts.jsonl'),'utf8'));
    assert.equal(verifyRegionDatasetBinding(artifact.exported,{expectedSplit:split}).valid,true);
    await assert.rejects(exportRegionDatasetJSONL([await qualified()],{...options,outputDirectory:result.directory}),/EEXIST/);
  }finally{await rm(parent,{recursive:true,force:true});}
});

test('CLI retains malformed JSONL as a refusal beside source-qualified artifacts',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'semantic-v8-cli-'));
  try{
    const input=join(parent,'input.jsonl'),module=join(parent,'tokenizer.mjs'),output=join(parent,'corpus');
    await writeFile(input,JSON.stringify(await qualified())+'\n{invalid-json}\n'+JSON.stringify(refused)+'\n');
    await writeFile(module,'export const tokenizer={identity:"'+tokenizer.identity+'",encode:s=>[...Buffer.from(s)],decode:ids=>Buffer.from(ids)};export const eosTokenId=256;');
    const {stdout}=await promisify(execFile)(process.execPath,['tools/export-semantic-v8.mjs','--input',input,
      '--tokenizer-module',module,'--max-context','1000000','--seed','17','--out',output,'--allow-local'],
      {cwd:new URL('..',import.meta.url),maxBuffer:1000000});
    const report=JSON.parse(stdout);assert.equal(report.inputCandidates,3);assert.equal(report.admitted,false);
    const dispositions=(await readFile(join(output,'dispositions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(dispositions.length,3);assert.equal(dispositions[1].category,'invalid-jsonl');
    assert.equal(dispositions[1].originalLine,'{invalid-json}');
    assert.match(dispositions[1].reason,/Line 2/);assert.equal(dispositions[2].family,'refused-write');
    const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
    assert.equal(manifest.inputEvidence.sha256,createHash('sha256').update(await readFile(input)).digest('hex'));
    assert.equal(manifest.inputEvidence.complete,true);
  }finally{await rm(parent,{recursive:true,force:true});}
});

test('CLI resource exhaustion preserves original inputs and counts without publishing partial training data',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'semantic-v8-budget-'));
  try{
    const input=join(parent,'input.jsonl'),module=join(parent,'tokenizer.mjs'),output=join(parent,'corpus');
    const bytes=JSON.stringify(refused)+'\n{invalid-json}\n';
    await writeFile(input,bytes);
    await writeFile(module,'export const tokenizer={identity:"'+tokenizer.identity+'",encode:s=>[...Buffer.from(s)],decode:ids=>Buffer.from(ids)};export const eosTokenId=256;');
    await assert.rejects(promisify(execFile)(process.execPath,['tools/export-semantic-v8.mjs','--input',input,
      '--tokenizer-module',module,'--max-context','1000000','--seed','17','--out',output,'--allow-local',
      '--clone-max-index-entries','0'],{cwd:new URL('..',import.meta.url),maxBuffer:1000000}),
      error=>error.code!==0&&/Source-clone indexEntries resource budget exhausted/.test(error.stderr));
    const failure=JSON.parse(await readFile(output+'.failure.json','utf8'));
    assert.equal(failure.status,'resource_exhausted');assert.equal(failure.admitted,false);
    assert.equal(failure.complete,false);assert.equal(failure.costs.indexEntries,0);
    assert.equal(failure.budget.maxIndexEntries,0);assert.equal(failure.input.complete,true);
    assert.equal(failure.input.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal(failure.candidates.length,2);assert.deepEqual(failure.candidates[0],refused);
    assert.equal(failure.candidates[1].originalLine,'{invalid-json}');
    await assert.rejects(readFile(join(output,'manifest.json')),error=>error.code==='ENOENT');
  }finally{await rm(parent,{recursive:true,force:true});}
});
