// Coverage-aware selection over the final native accepted inventory. This
// changes membership only: source identities, bytes, masks and splits stay put.
import {createHash} from 'node:crypto';
import {balanceFamilyTokens} from './source-registry.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted=values=>[...new Set(values)].sort();
const text=value=>typeof value==='string'&&value.length>0;
const require=(condition,message)=>{if(!condition)throw new Error(message);};

/** Features are measured execution signals, not function names/static syntax. */
export function executionCoverageFeatures(difficulty){
  if(difficulty?.schema!=='semantic-execution-difficulty/1'||!Array.isArray(difficulty.episodes))
    return {status:'unavailable',features:[],reason:'Original per-episode executed difficulty is unavailable'};
  const features=new Set();
  for(const episode of difficulty.episodes){
    for(const operation of episode.executedOperations??[])features.add('operation:'+operation);
    for(const outcome of ['truthy','falsy'])if(episode.branchOutcomes?.[outcome]>0)
      features.add('branch:'+outcome);
    if(episode.exceptionPath?.outcome)features.add('completion:'+episode.exceptionPath.outcome);
    if(episode.exceptionPath?.throws>0)features.add('exception:thrown');
    if(episode.callbacks>0)features.add('effect:callback');
    if(episode.initialAliasEdges>0)features.add('state:input-alias');
    if(episode.finalAliasEdges>0)features.add('state:output-alias');
    if(episode.loops?.length&&episode.loopTrips!==null)
      features.add('loop-trips:'+(episode.loopTrips===0?'zero':episode.loopTrips===1?'one':'multiple'));
  }
  for(const [field,tag] of [['mutationEvents','state:mutation'],['awaits','effect:await'],
    ['peakPendingEffects','effect:pending'],['exceptionOutcomes','completion:throw']])
    if(difficulty[field]>0)features.add(tag);
  if(difficulty.activations>1)features.add('state:repeated-invocation');
  if(difficulty.maxCallDepth>1)features.add('call:nested');
  const relationships=[...features].filter(feature=>/^(state|effect|exception|branch):/.test(feature)).sort();
  for(let left=0;left<relationships.length;left++)for(let right=left+1;right<relationships.length;right++)
    features.add('interaction:'+relationships[left]+' & '+relationships[right]);
  return {status:'measured',features:[...features].sort(),
    unmeasured:['getters/proxies versus data-only properties','holes versus explicit undefined',
      'external request types and observation values','exact scored-window feature exposure']};
}

/** Rebuild the existing conservative native/source union; never trust caps labels. */
export function preparedBudgetGroups(rows){
  const parents=new Map();
  function find(value){if(!parents.has(value))parents.set(value,value);
    let root=value;while(parents.get(root)!==root)root=parents.get(root);
    while(parents.get(value)!==value){const next=parents.get(value);parents.set(value,root);value=next;}return root;}
  function union(left,right){const roots=[find(left),find(right)].sort();parents.set(roots[1],roots[0]);}
  const ids=new Set(),episodes=new Set(),entries=new Set(),familySplits=new Map();
  for(const row of rows){
    require(text(row.id)&&text(row.episodeId)&&text(row.family)&&text(row.frozenSourceComponent)&&
      text(row.nativeResolvedFamily)&&['train','validation','test'].includes(row.split)&&
      row.nativeSplit===row.split&&Number.isSafeInteger(row.preparedEntryId)&&row.preparedEntryId>=0&&
      Number.isSafeInteger(row.generatedTokens)&&row.generatedTokens>0&&row.generatedTokens===row.scoredPositions&&
      Number.isSafeInteger(row.wholeTranscriptTokens)&&row.wholeTranscriptTokens>=row.generatedTokens&&
      row.observedTokens===row.wholeTranscriptTokens-row.generatedTokens,
    'Prepared inventory requires exact native identities, frozen splits and measured token/mask counts');
    require(!ids.has(row.id)&&!episodes.has(row.episodeId)&&!entries.has(row.preparedEntryId),
      'Repeated native prepared identity');
    ids.add(row.id);episodes.add(row.episodeId);entries.add(row.preparedEntryId);
    require(!familySplits.has(row.family)||familySplits.get(row.family)===row.split,
      'Declared source family crosses frozen splits');familySplits.set(row.family,row.split);
    union('frozen:'+row.frozenSourceComponent,'native:'+row.nativeResolvedFamily);
  }
  const members=new Map();
  for(const node of [...parents.keys()].sort()){
    const root=find(node),group=members.get(root)??[];group.push(node);members.set(root,group);
  }
  const names=new Map([...members].map(([root,nodes])=>[root,'prepared-budget:'+sha(nodes)]));
  const splits=new Map(),byId=new Map();
  for(const row of rows){
    const group=names.get(find('frozen:'+row.frozenSourceComponent));
    require(!splits.has(group)||splits.get(group)===row.split,
      'Merged source/native component crosses frozen splits');splits.set(group,row.split);
    require(row.budgetComponent===undefined||row.budgetComponent===group,
      'Declared budget component differs from the conservative native/source union');
    byId.set(row.id,group);
  }
  return byId;
}

function featureInventory(rows){
  const features=new Map();
  for(const row of rows)for(const feature of row.coverage?.features??[]){
    const detail=features.get(feature)??{feature,rows:0,components:new Set(),generatedTokens:0};
    detail.rows++;detail.components.add(row.budgetComponent);detail.generatedTokens+=row.generatedTokens;
    features.set(feature,detail);
  }
  return [...features.values()].map(row=>({...row,components:row.components.size})).sort((a,b)=>a.feature.localeCompare(b.feature));
}
export function preparedCoverageInventory(rows){
  const tokens=rows.reduce((sum,row)=>sum+row.generatedTokens,0),components=new Map();
  for(const row of rows)components.set(row.budgetComponent,(components.get(row.budgetComponent)??0)+row.generatedTokens);
  return {episodes:rows.length,declaredFamilies:new Set(rows.map(row=>row.family)).size,
    frozenSourceComponents:new Set(rows.map(row=>row.frozenSourceComponent)).size,
    nativeResolvedFamilies:new Set(rows.map(row=>row.nativeResolvedFamily)).size,
    budgetComponents:components.size,nativeGeneratedTokens:tokens,scoredPositions:tokens,
    nativeObservedTokens:rows.reduce((sum,row)=>sum+row.observedTokens,0),
    maximumComponentShare:tokens?Math.max(0,...components.values())/tokens:0,
    measuredFeatureRows:rows.filter(row=>row.coverage?.status==='measured').length,
    unavailableFeatureRows:rows.filter(row=>row.coverage?.status!=='measured').length,
    families:sorted(rows.map(row=>row.family)),features:featureInventory(rows)};
}

function campaignCoverageInventory(rows){
  const measured=rows.filter(row=>Number.isSafeInteger(row.metrics?.generatedTokens));
  const profiles=rows.map(row=>({budgetComponent:row.sourceCluster??row.family??row.id,
    generatedTokens:row.metrics?.generatedTokens??0,coverage:executionCoverageFeatures(row.difficulty)}));
  return {status:'measured',rows:rows.length,declaredFamilies:new Set(rows.map(row=>row.family).filter(text)).size,
    sourceComponents:new Set(rows.map(row=>row.sourceCluster).filter(text)).size,
    measuredTokenRows:measured.length,generatedTokens:measured.reduce((sum,row)=>sum+row.metrics.generatedTokens,0),
    measuredFeatureRows:profiles.filter(row=>row.coverage.status==='measured').length,
    unavailableFeatureRows:profiles.filter(row=>row.coverage.status!=='measured').length,
    features:featureInventory(profiles)};
}

/** Deterministic weighted novelty, followed by strict token/share enforcement.
 * Features supported by fewer independent components get more weight. Family
 * and component representation also count; equal utility prefers shorter rows.
 * This bounded greedy policy is a heuristic, not an optimal set-cover claim.
 */
export function balanceCoverageTokens(rows,{maxFamilyTokens,maxFamilyShare=1,
    maxTrainingTokens=Number.MAX_SAFE_INTEGER}={}){
  // Reuse the existing admission/count/policy validator and keep its result as
  // the unchanged control arm for coverage comparisons.
  const control=balanceFamilyTokens(rows,{maxFamilyTokens,maxFamilyShare});
  require(Number.isSafeInteger(maxTrainingTokens)&&maxTrainingTokens>0,'Invalid total training token budget');
  require(new Set(rows.map(row=>row.id)).size===rows.length,'Repeated coverage-selection row');
  const candidates=[...rows].sort((a,b)=>a.id.localeCompare(b.id)),markers=new Map(),support=new Map();
  for(const row of candidates){
    require(text(row.family)&&row.coverage?.status==='measured'&&Array.isArray(row.coverage.features)&&
      row.coverage.features.every(text),'Coverage selection requires measured features for every final prepared row');
    const keys=sorted(['family:'+row.family,'component:'+row.sourceCluster,...row.coverage.features]);
    markers.set(row.id,keys);
    for(const key of keys){const components=support.get(key)??new Set();components.add(row.sourceCluster);support.set(key,components);}
  }
  const weight=key=>1/support.get(key).size;
  const selected=[],totals=new Map(),counts=new Map(),remaining=new Map(candidates.map(row=>[row.id,row]));
  const scores=new Map(),postings=new Map();
  for(const row of candidates){
    scores.set(row.id,markers.get(row.id).reduce((value,key)=>value+weight(key),0));
    for(const key of markers.get(row.id)){const ids=postings.get(key)??[];ids.push(row.id);postings.set(key,ids);}
  }
  let total=0;
  while(remaining.size){
    let row=null;
    for(const candidate of remaining.values()){
      if(total+candidate.generatedTokens>maxTrainingTokens||
        (totals.get(candidate.sourceCluster)??0)+candidate.generatedTokens>maxFamilyTokens)continue;
      if(!row||scores.get(candidate.id)>scores.get(row.id)||
        scores.get(candidate.id)===scores.get(row.id)&&(candidate.generatedTokens<row.generatedTokens||
          candidate.generatedTokens===row.generatedTokens&&candidate.id.localeCompare(row.id)<0))row=candidate;
    }
    if(!row)break;
    selected.push(row);remaining.delete(row.id);total+=row.generatedTokens;
    totals.set(row.sourceCluster,(totals.get(row.sourceCluster)??0)+row.generatedTokens);
    for(const key of markers.get(row.id)){
      if(!counts.has(key))for(const id of postings.get(key))scores.set(id,Math.max(0,scores.get(id)-weight(key)));
      counts.set(key,(counts.get(key)??0)+1);
    }
  }
  const excluded=new Map([...remaining].map(([id,row])=>[id,
    row.generatedTokens>maxFamilyTokens||(totals.get(row.sourceCluster)??0)+row.generatedTokens>maxFamilyTokens?
      'family-token-budget':'total-training-token-budget']));
  for(;;){
    const over=[...totals].filter(([,tokens])=>tokens>0&&tokens/total>maxFamilyShare+Number.EPSILON)
      .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    if(!over.length)break;
    const loss=row=>markers.get(row.id).reduce((value,key)=>value+(counts.get(key)===1?weight(key):0),0);
    const row=selected.filter(row=>row.sourceCluster===over[0][0])
      .sort((a,b)=>loss(a)/a.generatedTokens-loss(b)/b.generatedTokens||b.generatedTokens-a.generatedTokens||a.id.localeCompare(b.id))[0];
    selected.splice(selected.indexOf(row),1);total-=row.generatedTokens;
    totals.set(row.sourceCluster,totals.get(row.sourceCluster)-row.generatedTokens);
    for(const key of markers.get(row.id)){const count=counts.get(key)-1;if(count)counts.set(key,count);else counts.delete(key);}
    excluded.set(row.id,'family-token-share');
  }
  return {selected:selected.sort((a,b)=>a.id.localeCompare(b.id)),
    refused:[...excluded].sort(([a],[b])=>a.localeCompare(b)).map(([id,reason])=>({id,reason})),
    generatedTokens:total,independentComponents:[...totals.values()].filter(value=>value>0).length,
    control,policy:{strategy:'rare-component-feature-greedy/1',maxFamilyTokens,maxFamilyShare,maxTrainingTokens,
      ranking:'uncovered inverse-component-support feature/family/component weight; shorter row; candidate ID',
      sharePruning:'least lost unique feature weight per removed token',optimal:false}};
}

export function selectPreparedCoverage(sampler,sourceManifest,{policy=sampler.policy}={}){
  require(sampler?.schema==='semantic-native-prepared-training-sampler/1'&&Array.isArray(sampler.acceptedDecisions),
    'Complete acceptedDecisions required; a reduced historical receipt cannot authorize a new selection');
  require(sourceManifest.producerRevision===sampler.producerRevision&&
    sourceManifest.campaign?.identityDigest===sampler.sourceCampaignDigest&&
    sourceManifest.sourceRegistry?.digest===sampler.sourceRegistryDigest,
    'Original campaign identity differs from the native sampler');
  const originals=new Map(sourceManifest.cases.map(row=>[row.id,row]));
  require(originals.size===sourceManifest.cases.length,'Repeated original candidate identity');
  const groups=preparedBudgetGroups(sampler.acceptedDecisions);
  require(sampler.acceptedDecisions.length===sampler.before.episodes,'Incomplete final prepared population');
  const rows=sampler.acceptedDecisions.map(row=>{
    const original=originals.get(row.id);
    require(original?.status==='admitted'&&original.family===row.family&&original.split===row.split&&
      original.sourceCluster===row.frozenSourceComponent&&original.identityDigest===row.identityDigest&&
      original.episodeDigest===row.episodeDigest&&original.metrics?.generatedTokens===row.generatedTokens&&
      original.metrics?.observedTokens===row.observedTokens,
      'Prepared row differs from its original native admission: '+row.id);
    return {...row,budgetComponent:groups.get(row.id),coverage:executionCoverageFeatures(original.difficulty)};
  });
  const training=rows.filter(row=>row.split==='train'),evaluation=rows.filter(row=>row.split!=='train');
  const balanced=balanceCoverageTokens(training.map(row=>({...row,status:'admitted',sourceCluster:row.budgetComponent})),policy);
  const kept=new Set([...balanced.selected,...evaluation].map(row=>row.id)),reasons=new Map(balanced.refused.map(row=>[row.id,row.reason]));
  const included=rows.filter(row=>kept.has(row.id));
  const before=preparedCoverageInventory(training),after=preparedCoverageInventory(included.filter(row=>row.split==='train'));
  const retained=new Set(after.features.map(row=>row.feature)),families=new Set(after.families);
  const coverage={schema:'semantic-native-prepared-coverage-report/1',status:'measured',
    policy:balanced.policy,nativePreparedFingerprint:sampler.nativePreparedFingerprint,
    originalPolicy:sampler.policy,originalProducerRevision:sampler.producerRevision,
    inventories:{candidates:{...campaignCoverageInventory(sourceManifest.cases),
      dispositions:Object.fromEntries(sorted(sourceManifest.cases.map(row=>row.status)).map(status=>
        [status,sourceManifest.cases.filter(row=>row.status===status).length]))},
      admitted:campaignCoverageInventory(sourceManifest.cases.filter(row=>row.status==='admitted')),
      nativePrepared:preparedCoverageInventory(rows),plannedSelection:preparedCoverageInventory(included),
      consumed:{status:'unavailable',scoredTargets:null,reason:'No authenticated optimizer exposure supplied'}},
    training:{before,after,identityOrderedControl:preparedCoverageInventory(balanced.control.selected),
      lostFeatures:before.features.filter(row=>!retained.has(row.feature)),
      lostFamilies:before.families.filter(family=>!families.has(family))},
    evaluation:{policy:'retain-all-native-accepted-validation-and-test',
      beforeEpisodeIds:sorted(evaluation.map(row=>row.episodeId)),afterEpisodeIds:sorted(included.filter(row=>row.split!=='train').map(row=>row.episodeId)),
      unchanged:true},optimizerSteps:0,learnedSuccess:null,
    limitations:['Coverage is a deterministic selection heuristic; conflicting budgets may lose rare features.',
      'Feature counts are measured from original admitted execution difficulty, not all JavaScript semantics.',
      'Prepared membership is not actual optimizer exposure. Historical receipts retain their original pins.']};
  const census=population=>({...preparedCoverageInventory(population),
    splits:Object.fromEntries(['train','validation','test'].map(split=>[split,preparedCoverageInventory(population.filter(row=>row.split===split))]))});
  const selectedSampler={...sampler,policy:{...sampler.policy,...balanced.policy},
    scope:'Coverage-aware membership over unchanged final native accepted episodes; no new admission or optimization.',
    before:census(rows),after:census(included),
    includedCandidateIds:sorted(included.map(row=>row.id)),includedEpisodeIds:sorted(included.map(row=>row.episodeId)),
    includedPreparedEntryIds:included.map(row=>row.preparedEntryId).sort((a,b)=>a-b),
    excludedAcceptedCandidateIds:sorted(reasons.keys()),
    acceptedDecisions:rows.map(({coverage,...row})=>({...row,decision:kept.has(row.id)?'included':'excluded',
      reason:row.split!=='train'?'evaluation-retained':reasons.get(row.id)??'within-coverage-training-budgets'})),
    coverageSelection:{schema:coverage.schema,policy:balanced.policy},optimizerSteps:0,learnedSuccess:null};
  return {sampler:selectedSampler,coverage};
}

/** Attach real native window exposure separately from prepared membership.
 * The CLI additionally authenticates the schedule's exact file digest against
 * the existing optimization runner's receipt. This does not rerun that model.
 */
export function consumedTargetInventory(sampler,report,schedule){
  require(report?.status==='completed'&&report.preparedFingerprint===sampler.nativePreparedFingerprint&&
    report.nativeWindowPlanMatched===true&&report.checkpointVerification?.reloadExact===true&&
    report.trainingExposure?.completeHistory===true&&report.lossMaskCounts?.observedScoredTokens===0,
    'Consumed targets require an exact completed checkpoint/window/mask receipt for this prepared population');
  require(schedule?.schema==='optimization-native-window-plan/1'&&Array.isArray(schedule.windows)&&
    schedule.windows.length===report.optimizerSteps&&report.optimizerSteps===schedule.requestedWindows,
    'Actual optimizer updates differ from the frozen native schedule');
  const rows=new Map(sampler.acceptedDecisions.map(row=>[row.episodeId,row]));
  const counts={},byEpisode=new Map();let scoredTargets=0;
  for(const window of schedule.windows){
    const row=rows.get(window.episodeId);
    require(row?.split==='train'&&row.family===window.family&&text(window.sourceId)&&
      Array.isArray(window.recordIds)&&window.recordIds.every(text)&&
      Number.isSafeInteger(window.scoredTokens)&&window.scoredTokens>0,
      'Consumed schedule contains a foreign/evaluation episode or invalid target count');
    counts[window.sourceId]=(counts[window.sourceId]??0)+1;scoredTargets+=window.scoredTokens;
    const exposure=byEpisode.get(row.episodeId)??{id:row.id,episodeId:row.episodeId,family:row.family,
      budgetComponent:row.budgetComponent,windows:0,scoredTargets:0,recordIds:new Set()};
    exposure.windows++;exposure.scoredTargets+=window.scoredTokens;
    window.recordIds.forEach(id=>exposure.recordIds.add(id));byEpisode.set(row.episodeId,exposure);
  }
  const normalize=value=>JSON.stringify(Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b)));
  require(normalize(counts)===normalize(report.trainingExposure.sourceWindowCounts)&&
    normalize(counts)===normalize(schedule.expectedSourceWindows)&&
    scoredTargets===report.supervisedLexicalTokens&&scoredTargets===schedule.expectedScoredTokens&&
    report.trainingExposure.sampledWindows===schedule.windows.length,
    'Reported consumed source/target totals differ from exact scheduled windows');
  return {status:'reported-actual-exposure',scope:'Separate optimizer run over the exact prepared parent',
    preparedFingerprint:report.preparedFingerprint,optimizerSteps:report.optimizerSteps,
    episodes:byEpisode.size,windows:schedule.windows.length,scoredTargets,
    featureCoverage:null,featureCoverageReason:'Window record IDs do not establish which whole-episode features were scored',
    rows:[...byEpisode.values()].map(row=>({...row,recordIds:[...row.recordIds].sort()}))
      .sort((a,b)=>a.id.localeCompare(b.id))};
}

/** Reduced committed receipts keep measured denominators but cannot select. */
export function historicalCoverageAvailability(sampler){
  require(sampler?.schema==='semantic-native-prepared-training-sampler-receipt/1'&&
    Array.isArray(sampler.includedMapping)&&sampler.includedMapping.length===sampler.after?.episodes,
    'Unsupported or incomplete reduced native sampler receipt');
  require(new Set(sampler.includedMapping.map(row=>row.id)).size===sampler.includedMapping.length&&
    sha(sorted(sampler.includedMapping.map(row=>row.id)))===sha(sorted(sampler.includedCandidateIds)),
    'Reduced sampler membership differs from its supplied index');
  const stages=sampler.upstreamDispositions;
  const splits=Object.fromEntries(['train','validation','test'].map(split=>{
    const rows=sampler.includedMapping.filter(row=>row.split===split);
    return [split,{episodes:rows.length,declaredFamilies:new Set(rows.map(row=>row.family)).size,
      budgetComponents:new Set(rows.map(row=>row.budgetComponent)).size,
      generatedTokens:rows.reduce((sum,row)=>sum+row.generatedTokens,0)}];
  }));
  for(const split of Object.keys(splits))require(splits[split].episodes===sampler.after.splits[split].episodes&&
    splits[split].generatedTokens===sampler.after.splits[split].nativeGeneratedTokens,
    'Reduced sampler rows differ from reported split/token totals');
  return {schema:'semantic-native-prepared-coverage-report/1',status:'partial_inventory',selection:null,
    producerRevision:sampler.producerRevision,nativePolicy:sampler.nativePolicy,
    nativePreparedFingerprint:sampler.nativePreparedFingerprint,
    inventories:{candidates:{status:'historical-summary-only',rows:stages.originalAttempted},
      admitted:{status:'historical-summary-only',rows:stages.originalNativeAdmitted},
      nativePrepared:{status:'historical-summary-only',rows:stages.nativePreparedAccepted},
      plannedSelection:{status:'supplied-membership-enumerated',rows:sampler.includedMapping.length,splits},
      consumed:{status:'unavailable',scoredTargets:null,reason:'No optimizer exposure is contained in a selection receipt'}},
    training:{before:sampler.before.splits.train,after:sampler.after.splits.train,
      lostFamilyCount:sampler.before.splits.train.declaredFamilies-sampler.after.splits.train.declaredFamilies,
      lostFamilies:null,lostFeatures:null},
    semanticCoverage:{status:'unavailable',reason:'Reduced receipt contains no per-row executed difficulty or full acceptedDecisions'},
    evaluation:{validationRetained:sampler.before.splits.validation.episodes===sampler.after.splits.validation.episodes,
      testRetained:sampler.before.splits.test.episodes===sampler.after.splits.test.episodes,
      scope:'Reported counts and supplied selected IDs; complete accepted inventory unavailable'},
    requiredInputs:['Complete original campaign manifest with per-row execution difficulty',
      'Complete native sampler with acceptedDecisions and authenticated prepared identities',
      'Actual optimizer report and native schedule for consumed-target accounting'],
    historicalArtifactsModified:false,optimizerSteps:0,learnedSuccess:null};
}
