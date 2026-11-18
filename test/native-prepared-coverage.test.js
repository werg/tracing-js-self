import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {balanceCoverageTokens,preparedBudgetGroups,selectPreparedCoverage,
  historicalCoverageAvailability,consumedTargetInventory,executionCoverageFeatures} from '../src/corpus/native-prepared-coverage.mjs';

const covered=(id,component,tokens,features,family=component)=>({id,sourceCluster:component,
  budgetComponent:component,status:'admitted',generatedTokens:tokens,scoredPositions:tokens,
  observedTokens:tokens,family,coverage:{status:'measured',features}});

test('coverage selection retains a rare exception lost by identity-ordered capping',()=>{
  const rows=[covered('a-common','a',5,['operation:compute']),covered('b-common','a',5,['operation:compute']),
    covered('z-rare','a',7,['operation:compute','completion:throw']),
    covered('m-short','a',2,['operation:compute']),covered('other','b',8,['operation:compute'])];
  const policy={maxFamilyTokens:10,maxFamilyShare:1};
  const result=balanceCoverageTokens(rows,policy);
  assert(result.selected.some(row=>row.id==='z-rare'));
  assert(result.selected.some(row=>row.id==='m-short'));
  assert(!result.control.selected.some(row=>row.id==='z-rare'));
  assert.deepEqual(result, balanceCoverageTokens([...rows].reverse(),policy));
  assert.equal(result.generatedTokens,17);
});

test('token/share caps remain hard when they conflict with coverage and can empty the selection',()=>{
  const rows=[covered('large','a',50,['rare']),covered('small','a',10,['common']),
    covered('other','b',20,['common']),covered('third','c',20,['common'])];
  const result=balanceCoverageTokens(rows,{maxFamilyTokens:50,maxFamilyShare:.4,maxTrainingTokens:75});
  assert(result.generatedTokens<=75);
  const totals=new Map();for(const row of result.selected)totals.set(row.sourceCluster,(totals.get(row.sourceCluster)??0)+row.generatedTokens);
  assert([...totals.values()].every(value=>value<=50&&value<=result.generatedTokens*.4+1e-9));
  const empty=balanceCoverageTokens([covered('alone','a',4,['rare'])],{maxFamilyTokens:10,maxFamilyShare:.5});
  assert.deepEqual(empty.selected,[]);
  assert.equal(empty.refused[0].reason,'family-token-share');
  assert.throws(()=>balanceCoverageTokens([{...rows[0],coverage:{status:'unavailable',features:[]}}],
    {maxFamilyTokens:100}),/measured features/);
});

function fixture(){
  const values=[['a-normal','a','train',5,false],['b-normal','a','train',5,false],
    ['z-rare','a','train',7,true],['short','a','train',2,false],['other','b','train',8,false],
    ['validation','v','validation',50,true],['test','t','test',80,true]];
  const rows=values.map(([id,component,split,tokens],index)=>({id,episodeId:'episode:'+id,
    family:'family:'+component,frozenSourceComponent:'source:'+component,nativeResolvedFamily:'native:'+component,
    split,nativeSplit:split,preparedEntryId:index,generatedTokens:tokens,scoredPositions:tokens,
    wholeTranscriptTokens:tokens*2,observedTokens:tokens,identityDigest:'identity:'+id,
    episodeDigest:'public:'+id}));
  const groups=preparedBudgetGroups(rows);for(const row of rows)row.budgetComponent=groups.get(row.id);
  const source={producerRevision:'a'.repeat(40),campaign:{identityDigest:'campaign'},sourceRegistry:{digest:'registry'},
    cases:rows.map((row,index)=>({id:row.id,status:'admitted',family:row.family,split:row.split,
      sourceCluster:row.frozenSourceComponent,identityDigest:row.identityDigest,episodeDigest:row.episodeDigest,
      metrics:{generatedTokens:row.generatedTokens,observedTokens:row.observedTokens},difficulty:{
        schema:'semantic-execution-difficulty/1',activations:1,exceptionOutcomes:values[index][4]?1:0,
        episodes:[{executedOperations:['primitive.binary'],exceptionPath:{outcome:values[index][4]?'throw':'return',throws:values[index][4]?1:0}}]}}))};
  source.cases.push({id:'refused',family:'unsupported',status:'unsupported'});
  const sampler={schema:'semantic-native-prepared-training-sampler/1',producerRevision:source.producerRevision,
    nativePreparedFingerprint:'prepared',sourceCampaignDigest:'campaign',sourceRegistryDigest:'registry',
    policy:{maxFamilyTokens:10,maxFamilyShare:1},before:{episodes:rows.length},acceptedDecisions:rows};
  return {sampler,source};
}

test('prepared selection preserves exact evaluation IDs and reports stage/coverage losses separately',()=>{
  const {sampler,source}=fixture(),original=JSON.stringify({sampler,source});
  const result=selectPreparedCoverage(sampler,source);
  assert.deepEqual(result.coverage.evaluation.beforeEpisodeIds,['episode:test','episode:validation']);
  assert.deepEqual(result.coverage.evaluation.afterEpisodeIds,result.coverage.evaluation.beforeEpisodeIds);
  assert.equal(result.coverage.inventories.candidates.rows,8);
  assert.equal(result.coverage.inventories.admitted.rows,7);
  assert.equal(result.coverage.inventories.nativePrepared.episodes,7);
  assert.equal(result.coverage.inventories.consumed.status,'unavailable');
  assert(result.sampler.includedCandidateIds.includes('z-rare'));
  assert.equal(result.sampler.schema,sampler.schema,'existing native materializer schema remains usable');
  assert.equal(result.sampler.acceptedDecisions.length,sampler.acceptedDecisions.length);
  assert.equal(JSON.stringify({sampler,source}),original);
  assert.deepEqual(selectPreparedCoverage({...sampler,acceptedDecisions:[...sampler.acceptedDecisions].reverse()},
    {...source,cases:[...source.cases].reverse()}).sampler.includedEpisodeIds,result.sampler.includedEpisodeIds);
});

test('native/source transitive split leaks and invented component labels refuse before selection',()=>{
  const {sampler,source}=fixture();
  const leak=structuredClone(sampler);delete leak.acceptedDecisions.at(-1).budgetComponent;
  leak.acceptedDecisions.at(-1).nativeResolvedFamily=leak.acceptedDecisions[0].nativeResolvedFamily;
  assert.throws(()=>selectPreparedCoverage(leak,source),/budget component|crosses frozen splits/);
  const forged=structuredClone(sampler);forged.acceptedDecisions[0].budgetComponent='independent';
  assert.throws(()=>selectPreparedCoverage(forged,source),/budget component/);
  const changed=structuredClone(source);changed.cases[0].metrics.generatedTokens++;
  assert.throws(()=>selectPreparedCoverage(sampler,changed),/original native admission/);
  const repeated=structuredClone(sampler);repeated.acceptedDecisions.push(repeated.acceptedDecisions[0]);
  assert.throws(()=>selectPreparedCoverage(repeated,source),/Repeated native prepared identity/);
});

test('executed feature inventory distinguishes known absence from missing data',()=>{
  assert.equal(executionCoverageFeatures(null).status,'unavailable');
  const result=executionCoverageFeatures({schema:'semantic-execution-difficulty/1',activations:2,
    awaits:1,mutationEvents:3,maxCallDepth:2,episodes:[{executedOperations:['async.await'],
      exceptionPath:{outcome:'return',throws:1},initialAliasEdges:2,callbacks:1,
      loops:[{}],loopTrips:1,branchOutcomes:{truthy:1,falsy:0}}]});
  for(const feature of ['effect:await','effect:callback','state:input-alias','state:repeated-invocation',
    'branch:truthy','loop-trips:one','exception:thrown'])assert(result.features.includes(feature));
  assert(!result.features.includes('branch:falsy'));
  assert(result.unmeasured.includes('holes versus explicit undefined'));
});

test('real reduced D receipt reports 541 prepared, 211 selected and unavailable semantic/consumed coverage',()=>{
  const sampler=JSON.parse(readFileSync(new URL('../docs/evidence/semantic-v5/real-source-prepared-sampler-D-2026-11-18.json',import.meta.url)));
  const report=historicalCoverageAvailability(sampler);
  assert.equal(report.status,'partial_inventory');
  assert.equal(report.inventories.candidates.rows,1171);
  assert.equal(report.inventories.admitted.rows,987);
  assert.equal(report.inventories.nativePrepared.rows,541);
  assert.equal(report.inventories.plannedSelection.rows,211);
  assert.equal(report.inventories.plannedSelection.splits.train.generatedTokens,139145);
  assert.equal(report.training.lostFamilyCount,27);
  assert.equal(report.semanticCoverage.status,'unavailable');
  assert.equal(report.inventories.consumed.scoredTargets,null);
  assert.equal(report.selection,null);
  assert.throws(()=>selectPreparedCoverage(sampler,{cases:[]}),/Complete acceptedDecisions/);
});

test('consumed windows retain repeated scored exposure without equating it to whole-row coverage',()=>{
  const {sampler}=fixture();
  const windows=[0,1].map(index=>({sourceId:'source-id',family:'family:a',episodeId:'episode:a-normal',
    recordIds:['record:'+index],scoredTokens:3}));
  const schedule={schema:'optimization-native-window-plan/1',requestedWindows:2,expectedScoredTokens:6,
    expectedSourceWindows:{'source-id':2},windows};
  const report={status:'completed',preparedFingerprint:'prepared',nativeWindowPlanMatched:true,
    checkpointVerification:{reloadExact:true},trainingExposure:{completeHistory:true,sampledWindows:2,
      sourceWindowCounts:{'source-id':2}},lossMaskCounts:{observedScoredTokens:0},optimizerSteps:2,supervisedLexicalTokens:6};
  const inventory=consumedTargetInventory(sampler,report,schedule);
  assert.equal(inventory.episodes,1);assert.equal(inventory.scoredTargets,6);assert.equal(inventory.featureCoverage,null);
  assert.deepEqual(inventory.rows[0].recordIds,['record:0','record:1']);
  assert.throws(()=>consumedTargetInventory(sampler,{...report,supervisedLexicalTokens:5},schedule),/totals differ/);
  const leaked=structuredClone(schedule);leaked.windows[0].episodeId='episode:test';
  assert.throws(()=>consumedTargetInventory(sampler,report,leaked),/foreign\/evaluation/);
});

test('CLI authenticates original manifest bytes before producing a materializable sampler',t=>{
  const dir=mkdtempSync(join(tmpdir(),'prepared-coverage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {sampler,source}=fixture(),sourceBytes=JSON.stringify(source);
  sampler.sourceManifestSha256=createHash('sha256').update(sourceBytes).digest('hex');
  const sourcePath=join(dir,'source.json'),samplerPath=join(dir,'parent.json'),out=join(dir,'selection');
  writeFileSync(sourcePath,sourceBytes);writeFileSync(samplerPath,JSON.stringify(sampler));
  const cli=new URL('../tools/select-native-prepared-coverage.mjs',import.meta.url).pathname;
  const run=spawnSync(process.execPath,[cli,'--sampler',samplerPath,'--source-manifest',sourcePath,'--out',out],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(readFileSync(join(out,'sampler.json'))).schema,'semantic-native-prepared-training-sampler/1');
  writeFileSync(sourcePath,sourceBytes+'\n');
  const bad=spawnSync(process.execPath,[cli,'--sampler',samplerPath,'--source-manifest',sourcePath,'--out',join(dir,'bad')],{encoding:'utf8'});
  assert.notEqual(bad.status,0);assert.match(bad.stderr,/manifest bytes changed/);
});
