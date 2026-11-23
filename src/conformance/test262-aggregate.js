// Combine current campaign observations without promoting a reference run to
// owned/native trace admission. Missing shards remain explicit unrun inputs.
import {CONFORMANCE_STAGES,CONFORMANCE_DISPOSITIONS,conformanceDigest,
  validateTest262Catalog,selectTest262Shard} from './test262-catalog.js';
import {validateOriginalTest262Report} from './test262-campaign.js';

const key=row=>JSON.stringify([row.path,row.mode]);
const stageName={parse:'parseStatic',owned:'ownedExecution',reference:'independentReference'};

export function createTest262CampaignAggregation({baseCatalog,shardCount}={}){
  validateTest262Catalog(baseCatalog);
  if(!Number.isSafeInteger(shardCount)||shardCount<1)
    throw new TypeError('Campaign aggregation requires a positive shard count');
  const population=new Map(baseCatalog.variants.map(row=>[key(row),row]));
  if(population.size!==baseCatalog.variants.length)
    throw new TypeError('Duplicate source variants in the Test262 aggregation catalog');
  const seen=new Set(),parts=new Map();
  const counts=Object.fromEntries(CONFORMANCE_STAGES.map(stage=>[stage,
    Object.fromEntries(CONFORMANCE_DISPOSITIONS.map(status=>[status,status==='not_run'?population.size:0]))]));
  let identity=null,requestedStages=null,attempts=0,finished=false;
  return {
    add(report,{source=null}={}){
      if(finished)throw new TypeError('Campaign aggregation is already finished');
      const {catalog}=validateOriginalTest262Report(report,{baseCatalog});
      const selection=report.runPolicy?.selection,shard=selection?.shard;
      if(!shard||shard.count!==shardCount||shard.strategy!=='source-path-sha256/1'||
         !Number.isSafeInteger(shard.index)||shard.index<0||shard.index>=shardCount||
         selection.paths!==null||selection.cases!==null||selection.limit!==null||selection.all!==true)
        throw new TypeError('Aggregation requires complete source-path shards of one catalog');
      if(parts.has(shard.index))throw new TypeError('Duplicate Test262 campaign shard: '+shard.index);
      const expected=selectTest262Shard(catalog.variants,shard).map(row=>row.id);
      if(conformanceDigest(expected)!==conformanceDigest(report.campaign.selectedIds))
        throw new TypeError('Test262 campaign selection differs from its declared shard');
      if(!Array.isArray(report.runPolicy.stages)||!report.runPolicy.stages.length||
         new Set(report.runPolicy.stages).size!==report.runPolicy.stages.length||
         report.runPolicy.stages.some(stage=>!Object.hasOwn(stageName,stage)))
        throw new TypeError('Unknown Test262 campaign execution stages');
      const implementation=report.campaign.implementation;
      const currentIdentity=conformanceDigest({profile:report.profile,
        implementation:{producerRevision:implementation.producerRevision,codeDigest:implementation.codeDigest,
          runnerDigest:implementation.runnerDigest,node:implementation.node??null,v8:implementation.v8??null,
          environment:implementation.environment??null},
        runPolicy:{...report.runPolicy,selection:{...selection,shard:{...shard,index:0}}}});
      if(identity!==null&&identity!==currentIdentity)
        throw new TypeError('Test262 shards used different implementations, engines or execution policies');
      const rows=report.campaign.rows.filter(row=>row.selected);
      for(const row of rows){
        const rowKey=key(row);
        if(!population.has(rowKey)||seen.has(rowKey))
          throw new TypeError('Duplicate or unknown Test262 source variant across shards');
        if(CONFORMANCE_STAGES.some(stage=>row.stages[stage].status==='not_selected'))
          throw new TypeError('Selected Test262 source variant has an unselected stage');
      }
      // Mutate only after every identity and selected row was checked. A bad
      // part cannot leave a partially applied aggregate that looks complete.
      identity=currentIdentity;requestedStages=report.runPolicy.stages.map(stage=>stageName[stage]);
      for(const row of rows){
        seen.add(key(row));attempts+=row.attempts.length;
        for(const stage of CONFORMANCE_STAGES){counts[stage].not_run--;counts[stage][row.stages[stage].status]++;}
      }
      parts.set(shard.index,{index:shard.index,selected:rows.length,source,
        campaignIdentity:report.campaign.identityDigest,catalogDigest:report.catalogDigest,
        producerRevision:implementation.producerRevision,codeDigest:implementation.codeDigest,
        node:implementation.node??null,v8:implementation.v8??null});
      return {shards:parts.size,observedVariants:seen.size};
    },
    finish(){
      if(finished)throw new TypeError('Campaign aggregation is already finished');
      finished=true;
      const missingShards=Array.from({length:shardCount},(_,index)=>index).filter(index=>!parts.has(index));
      const missingVariants=[...population].filter(([rowKey])=>!seen.has(rowKey)).map(([,row])=>({
        path:row.path,mode:row.mode,sourceDigest:row.sourceDigest}));
      return {schema:'original-test262-campaign-aggregate/1',baseCatalogDigest:baseCatalog.digest,
        suiteRevision:baseCatalog.suiteRevision,catalogVariants:population.size,observedVariants:seen.size,
        shardCount,observedShards:parts.size,allShardsPresent:missingShards.length===0,
        requestedWorkFinished:missingShards.length===0&&requestedStages!==null&&requestedStages.every(stage=>
          counts[stage].not_run===0&&counts[stage].interrupted===0),
        missingShards,missingVariants,attempts,stages:counts,
        parts:[...parts.values()].sort((a,b)=>a.index-b.index),
        claims:{fullLanguageConformance:false,sourceCorrespondence:false,nativeTraceReplay:false,
          datasetAdmission:false,ordinaryTraining:false,serving:false,learnedUsefulness:false}};
    }
  };
}
