// Production candidate sharding reuses the global registry and durable store.
// Shards partition work, never source splits or admission/native-dedup authority.
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
import {CampaignStore,identityHash} from './campaign-store.mjs';
import {canonicalHash,immutableSourceRegistry,frozenSplitIdentity} from './source-registry.mjs';
import {encodeGenerationTask,decodeGenerationTask,persistGenerationCandidate,runGenerationProcess} from './generation-process.mjs';

const ensure=(condition,message)=>{if(!condition)throw new Error(message);};
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(value);
const sorted=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id,'en'));
const assignment=(taskDigest,count)=>Number(BigInt('0x'+taskDigest.slice(0,16))%BigInt(count));
function candidateRows(tasks,registry){
  ensure(Array.isArray(tasks)&&tasks.length>0,'A nonempty candidate inventory is required');
  const ids=new Set(),sourceKeys=new Set(registry.sources.map(row=>row.family+'\0'+row.source));
  return sorted(tasks.map(task=>{
    ensure(['source','session'].includes(task?.kind)&&safeId(task.fixture?.id)&&!ids.has(task.fixture.id),
      'Duplicate, unsafe or invalid generation candidate');
    ids.add(task.fixture.id);
    const fixtures=task.kind==='source'?[task.fixture]:task.fixture.cases;
    ensure(Array.isArray(fixtures)&&fixtures.length>0,'A session must retain its original cases');
    for(const fixture of fixtures)ensure(sourceKeys.has(task.fixture.family+'\0'+fixture.source),
      'Candidate source bytes or family absent from the global registry');
    const split=frozenSplitIdentity(registry,task.fixture.family);
    const encoded=encodeGenerationTask(task);
    return {id:task.fixture.id,kind:task.kind,family:task.fixture.family,
      componentId:split.componentId,split:split.split,taskDigest:identityHash(encoded),task:encoded};
  }));
}

export function buildGenerationShardPlan({tasks,registry,identity,shardCount=1}){
  ensure(Number.isSafeInteger(shardCount)&&shardCount>=1,'Shard count must be a positive safe integer');
  registry=immutableSourceRegistry(registry);
  const registryDigest=canonicalHash(registry);
  ensure(identity?.schema==='semantic-generation-identity/1'&&/^[a-f0-9]{40}$/.test(identity.producerRevision??'')&&
    identity.registryDigest===registryDigest,'Shard plan requires a pinned producer and exact registry identity');
  const candidates=candidateRows(tasks,registry);
  const inventoryDigest=identityHash({identity,registryDigest,candidates});
  const payload={schema:'semantic-generation-shard-plan/1',identity,registry,registryDigest,inventoryDigest,
    shardCount,candidates:candidates.map((candidate,ordinal)=>({...candidate,ordinal,
      shard:assignment(candidate.taskDigest,shardCount)}))};
  return {...payload,digest:identityHash(payload)};
}

export function verifyGenerationShardPlan(plan){
  ensure(plan?.schema==='semantic-generation-shard-plan/1'&&Array.isArray(plan.candidates),'Invalid generation shard plan');
  const rebuilt=buildGenerationShardPlan({tasks:plan.candidates.map(row=>decodeGenerationTask(row.task)),
    registry:plan.registry,identity:plan.identity,shardCount:plan.shardCount});
  ensure(isDeepStrictEqual(plan,rebuilt),'Generation shard plan identity, task, split or assignment changed');
  return {valid:true,digest:plan.digest,inventoryDigest:plan.inventoryDigest};
}

function checkIndex(plan,index){
  ensure(Number.isSafeInteger(index)&&index>=0&&index<plan.shardCount,'Shard index is outside the frozen plan');
}
function campaignIdentity(plan,index){return {...plan.identity,shard:{planDigest:plan.digest,index}};}
function preparedTask(row,registry){
  const task=decodeGenerationTask(row.task),splitIdentity=frozenSplitIdentity(registry,row.family);
  task.fixture={...task.fixture,splitIdentity,seed:registry.seed};
  if(task.kind==='session')task.fixture.cases=task.fixture.cases.map(fixture=>({...fixture,splitIdentity,seed:registry.seed}));
  return task;
}

function semanticResult(result,exported){
  return {status:result.status,category:result.category??null,
    publicDigest:exported?canonicalHash(exported.public):null,
    evidenceDigest:exported?canonicalHash({reference:exported.sidecar.reference??null,
      referenceStatus:exported.sidecar.referenceStatus,admission:exported.sidecar.admission,
      identityDigest:exported.sidecar.identityDigest??null}):null};
}

export function generationShardReceipt(plan,index,store){
  verifyGenerationShardPlan(plan);checkIndex(plan,index);
  ensure(store.identityDigest===identityHash(campaignIdentity(plan,index)),'Shard campaign identity differs from plan');
  const expected=plan.candidates.filter(row=>row.shard===index),expectedIds=new Set(expected.map(row=>row.id));
  ensure([...store.latest.keys()].every(id=>expectedIds.has(id)),'Shard contains an unplanned candidate');
  const registry=immutableSourceRegistry(plan.registry),rows=[],unrun=[];
  for(const candidate of expected){
    const entry=store.latest.get(candidate.id);
    if(!entry){unrun.push({id:candidate.id,taskDigest:candidate.taskDigest,
      componentId:candidate.componentId,split:candidate.split,status:'unrun'});continue;}
    const saved=store.readObject(entry.candidate),task=preparedTask(candidate,registry),encoded=encodeGenerationTask(task);
    ensure(saved.kind===task.kind&&saved.id===task.fixture.id&&saved.family===task.fixture.family&&
      identityHash(saved.fixture)===identityHash(encoded.fixture),'Stored candidate differs from frozen source/input/split');
    const result=store.readObject(entry.result),exported=store.exported(entry);
    rows.push({id:candidate.id,taskDigest:candidate.taskDigest,componentId:candidate.componentId,
      split:candidate.split,...semanticResult(result,exported),
      attempts:store.entries.filter(row=>row.id===candidate.id).map(row=>({attempt:row.attempt,
        status:row.status,entryDigest:row.entryDigest,candidateDigest:row.candidateDigest,
        result:row.result,public:row.public,private:row.private,
        durationMs:row.durationMs,peakRssBytes:row.peakRssBytes}))});
  }
  const payload={schema:'semantic-generation-shard-receipt/1',planDigest:plan.digest,
    inventoryDigest:plan.inventoryDigest,registryDigest:plan.registryDigest,
    index,shardCount:plan.shardCount,expected:expected.length,
    complete:rows.length===expected.length&&rows.every(row=>row.status!=='cancelled'),
    attempted:rows.length,unrun,rows};
  return {...payload,digest:identityHash(payload)};
}

export async function runGenerationShard({plan,index,directory,currentIdentity,
    resume=false,retryFailures=false,signal,onRecord=()=>{},bounds=plan?.identity?.bounds??{},
    execute=runGenerationProcess,native=null}){
  verifyGenerationShardPlan(plan);checkIndex(plan,index);
  ensure(isDeepStrictEqual(currentIdentity,plan.identity),'Current producer/runtime identity differs from frozen shard plan');
  ensure(isDeepStrictEqual(bounds,plan.identity.bounds),'Worker resource bounds differ from frozen shard plan');
  const maxCandidates=bounds.maxCandidates??Number.MAX_SAFE_INTEGER;
  ensure(Number.isSafeInteger(maxCandidates)&&maxCandidates>=0,'Invalid per-invocation candidate budget');
  ensure(!plan.identity.nativePolicy||native,'Pinned native policy requires its actual consumer configuration');
  if(native)ensure(isDeepStrictEqual(native.policy,plan.identity.nativePolicy),'Native policy differs from shard plan');
  const store=new CampaignStore(directory,campaignIdentity(plan,index),{resume,maxObjectBytes:bounds.maxOutputBytes??268435456});
  const registry=immutableSourceRegistry(plan.registry);
  try{
    let attempted=0;
    for(const row of plan.candidates.filter(row=>row.shard===index)){
      if(signal?.aborted)break;
      const task=preparedTask(row,registry),candidate=persistGenerationCandidate(store,task);
      let entry=store.cached(row.id,candidate,{retryFailures});
      if(!entry){
        if(attempted>=maxCandidates)break;
        attempted++;
        const run=await execute({...task,native,producerRevision:plan.identity.producerRevision},
          {...bounds,outputDirectory:join(directory,'.workers'),signal});
        entry=store.record(row.id,candidate,run.result,run);
      }
      await onRecord({id:row.id,status:entry.status,attempt:entry.attempt});
    }
    return generationShardReceipt(plan,index,store);
  }finally{store.close();}
}

export function readGenerationShardReceipt({plan,index,directory}){
  verifyGenerationShardPlan(plan);checkIndex(plan,index);
  const store=new CampaignStore(directory,campaignIdentity(plan,index),{readOnly:true,
    maxObjectBytes:plan.identity.bounds?.maxOutputBytes??268435456});
  try{return generationShardReceipt(plan,index,store);}finally{store.close();}
}

export function mergeGenerationShardReceipts(plan,receipts){
  verifyGenerationShardPlan(plan);
  ensure(Array.isArray(receipts)&&receipts.length===plan.shardCount,'All planned shard receipts are required');
  const indexes=new Set(),ids=new Set(),rows=[];
  for(const receipt of receipts){
    const {digest,...payload}=receipt;
    ensure(receipt.schema==='semantic-generation-shard-receipt/1'&&identityHash(payload)===digest,
      'Shard receipt digest changed');
    checkIndex(plan,receipt.index);
    ensure(!indexes.has(receipt.index),'Duplicate shard receipt');indexes.add(receipt.index);
    ensure(receipt.planDigest===plan.digest&&receipt.inventoryDigest===plan.inventoryDigest&&
      receipt.registryDigest===plan.registryDigest&&receipt.shardCount===plan.shardCount,
      'Shard producer, registry or candidate inventory differs');
    const expected=plan.candidates.filter(row=>row.shard===receipt.index);
    ensure(receipt.complete===true&&receipt.expected===expected.length&&receipt.rows.length===expected.length&&
      receipt.rows.every(row=>row.status!=='cancelled'),
      'Shard is incomplete or cancelled; resume durable candidates before merging');
    ensure(receipt.attempted===receipt.rows.length&&Array.isArray(receipt.unrun)&&receipt.unrun.length===0,
      'Complete shard receipt has inconsistent attempted/unrun accounting');
    for(const row of receipt.rows){
      const candidate=expected.find(item=>item.id===row.id);
      ensure(candidate&&!ids.has(row.id)&&row.taskDigest===candidate.taskDigest&&
        row.componentId===candidate.componentId&&row.split===candidate.split,
        'Shard duplicate, source identity or frozen split differs');
      ensure(Array.isArray(row.attempts)&&row.attempts.length>0&&
        row.attempts.every((attempt,index)=>attempt.attempt===index+1)&&
        row.status===row.attempts.at(-1).status,'Shard attempt history is missing or reordered');
      ids.add(row.id);rows.push(row);
    }
  }
  ensure(ids.size===plan.candidates.length,'Merged shard candidate coverage is incomplete');
  const ordered=sorted(rows),semanticRows=ordered.map(({attempts,...row})=>row);
  const counts={};for(const row of ordered)counts[row.status]=(counts[row.status]??0)+1;
  return {schema:'semantic-generation-shard-merge/1',inventoryDigest:plan.inventoryDigest,
    registryDigest:plan.registryDigest,shardCount:plan.shardCount,candidates:ordered.length,counts,
    attempts:ordered.reduce((n,row)=>n+row.attempts.length,0),rows:ordered,
    semanticDigest:identityHash(semanticRows),
    distinctPublicEpisodes:new Set(ordered.flatMap(row=>row.publicDigest?[row.publicDigest]:[])).size,
    nativeDeduplication:'required-after-merge',
    scope:'Complete planned candidate accounting and public/certification identity; native preparation and release admission remain separate.'};
}

export function compareGenerationShardEquivalence(single,sharded){
  ensure(single?.schema==='semantic-generation-shard-merge/1'&&sharded?.schema===single.schema&&single.shardCount===1,
    'Equivalence requires a complete single-shard control and merged sharded run');
  ensure(single.inventoryDigest===sharded.inventoryDigest&&single.registryDigest===sharded.registryDigest,
    'Equivalence requires the same frozen source/input/producer inventory');
  const clean=report=>report.rows.map(({attempts,...row})=>row);
  const expected=clean(single),actual=clean(sharded);
  const first=expected.findIndex((row,index)=>!isDeepStrictEqual(row,actual[index]));
  return {schema:'semantic-generation-shard-equivalence/1',status:first===-1&&expected.length===actual.length?'agreed':'mismatch',
    candidates:expected.length,firstDifference:first===-1&&expected.length!==actual.length?Math.min(expected.length,actual.length):first<0?null:first,
    compared:'Final dispositions, public target digests, independent-certification identities, component and split.',
    excluded:'Worker timing/RSS, storage log order and retry history; all original attempts remain in merged receipts.',
    nativeDeduplication:'not-implied'};
}
