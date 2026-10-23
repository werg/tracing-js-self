// Coverage-directed novelty selection for *already* independently checked,
// non-admitted owned episodes. Never turn V8 observations into owned evidence.
import {createHash} from 'node:crypto';
import {normalizeJournal} from '../semantic/normalize.js';
import {recheckIndependentTrainingEvidence} from '../training/admit.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe=x=>typeof x==='string'&&x.length>0&&x.length<600;
export function profileOwnedEpisode(row){
 if(row?.schema!=='owned-exercism-local-episode/1'||row.admitted!==false||
   !safe(row.id)||!safe(row.slug)||!safe(row.split)||
   !row.exported?.sidecar?.archive||
   row.exported.sidecar.branchAudit?.status!=='agreed'||
   row.exported.sidecar.operationAudit?.status!=='agreed')
  throw new TypeError('Not an independently audited owned episode');
 const recheck=recheckIndependentTrainingEvidence(row.exported);
 if(recheck.valid!==true||recheck.admitted!==false)
  throw new Error('Owned evidence failed independent replay/reference recheck');
 const archive=row.exported.sidecar.archive;
 if(!Array.isArray(archive.events)||archive.events.length>50000)
  throw new Error('Oversized or malformed owned journal');
 const normalized=normalizeJournal(archive).events;
 const rawById=new Map(archive.events.map(x=>[x.eventId,x]));
 const operations=[],branches=[],mutationOperations=new Set();
 for(const e of normalized){
  const operation=rawById.get(e.journalEvent)?.operation;
  if(typeof operation!=='string'||operation.length>120)continue;
  operations.push(operation);
  if(/(?:\.set|\.delete|\.define|\.push|\.splice|\.write|\.mutate)/i.test(operation))
   mutationOperations.add(operation);
  if(operation==='control.branch'){
   const site=e.source&&Number.isSafeInteger(e.source.start)&&
    Number.isSafeInteger(e.source.end)&&e.source.end>e.source.start?
    e.source.start+':'+e.source.end:null;
   if(site===null||e.result?.[0]!=='bool'||typeof e.result[1]!=='boolean')
    throw new Error('Unmapped owned branch cannot certify path novelty');
   branches.push([site,e.result[1]]);
  }
 }
 if(operations.length===0)throw new Error('Empty audited owned operations');
 const provenance=row.originalSource;
 if(!provenance||!safe(provenance.repository)||!safe(provenance.path)||
    !safe(provenance.revision))
  throw new TypeError('Missing real source provenance');
 const family=[provenance.repository,provenance.revision,provenance.path].join('@');
 const uniqueOps=[...new Set(operations)].sort();
 const transitions=[...new Set(operations.slice(1).map((op,i)=>operations[i]+' -> '+op))].sort();
 // Only actual executed source-site branch decisions contribute to the path key.
 // Static hardness tags or random input seeds do not count as dynamic novelty.
 const pathHash=digest([family,branches]);
 return {id:row.id,caseId:row.caseId??null,slug:row.slug,
  family,split:row.split,origin:row.inputOrigin??'unknown',
  pathHash,branchCount:branches.length,
  operations:uniqueOps,transitions,mutations:[...mutationOperations].sort(),
  eventCount:operations.length,
  authority:'owned-locally-verified-non-admitted',admitted:false};
}
export function selectNovelEpisodes(profiles,{limit=128}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>5000)
  throw new TypeError('Invalid novelty selection limit');
 if(!Array.isArray(profiles)||profiles.length>10000)
  throw new TypeError('Excessive novelty inventory');
 const ids=new Set(),familySplits=new Map(),unique=[];
 for(const row of profiles){
  if(!row||!safe(row.id)||!safe(row.family)||!safe(row.split)||
   !safe(row.pathHash)||!Array.isArray(row.operations)||
   !Array.isArray(row.transitions)||!Array.isArray(row.mutations)||
   row.admitted!==false||row.authority!=='owned-locally-verified-non-admitted')
   throw new TypeError('Invalid owned novelty profile');
  if(ids.has(row.id))throw new Error('Duplicate owned episode identity');
  ids.add(row.id);
  if(familySplits.has(row.family)&&familySplits.get(row.family)!==row.split)
   throw new Error('Potential source-family train/evaluation leakage');
  familySplits.set(row.family,row.split);
  unique.push(row);
 }
 unique.sort((a,b)=>a.id.localeCompare(b.id));
 const seen=new Set(),selected=[],picked=new Set();
 const markers=x=>[
  ['family:'+x.family,24],
  ['path:'+x.family+':'+x.pathHash,16],
  ...x.operations.map(op=>['operation:'+op,5]),
  ...x.transitions.map(op=>['transition:'+op,2]),
  ...x.mutations.map(op=>['mutation:'+op,5])
 ];
 const novelty=x=>markers(x).reduce((n,[key,weight])=>n+(seen.has(key)?0:weight),0);
 while(selected.length<limit){
  let best=null,score=0;
  for(const candidate of unique){
   if(picked.has(candidate.id))continue;
   const n=novelty(candidate);
   if(n>score||(n===score&&best&&candidate.origin==='upstream-canonical'&&
     best.origin!=='upstream-canonical')){
    best=candidate;score=n;
   }
  }
  if(!best||score===0)break;
  selected.push({...best,noveltyScore:score});
  picked.add(best.id);
  for(const [key] of markers(best))seen.add(key);
 }
 return {schema:'owned-corpus-novelty-selection/1',
  authority:'post-verification-selection-only',admitted:0,
  candidateCount:profiles.length,selectedCount:selected.length,
  distinctFamilies:new Set(unique.map(x=>x.family)).size,
  distinctPaths:new Set(unique.map(x=>x.family+':'+x.pathHash)).size,
  selected,refusedAsRedundant:profiles.length-selected.length,
  warnings:[
   'Selection retains existing independent owned evidence; it cannot verify or admit new executions.',
   'Executed branch sites and decisions provide path signatures; operation transitions are novelty proxies, not full call-graph equivalence.',
   'Source family is identified by exact repository, revision and path. External near-duplicate clustering across forks remains future work.'
  ]};
}
