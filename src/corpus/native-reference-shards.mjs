// Evidence-preserving Test262 native-reference sharding. Nothing in this
// module executes JS or confers owned semantic verification/admission.
import {createHash} from 'node:crypto';

const hex64=/^[a-f0-9]{64}$/;
const uint=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
export const nativeReferenceDigest=()=>createHash('sha256');
export function addNativeCatalogIdentity(digest,row,ordinal){
 digest.update(JSON.stringify([ordinal,row.id,row.provenance.sha256])+'\n');
}
export function validateAcquiredTest262(row,revision){
 if(row?.schema!=='external-corpus-fixture/1'||
  row.authority!=='acquired-fixture-only'||row.admitted!==false||
  row.verified!==false||row.provenance?.repository!=='tc39/test262'||
  row.provenance.revision!==revision||
  !hex64.test(row.id??'')||!hex64.test(row.provenance.sha256??'')||
  row.program?.kind!=='test262-program'||
  !['strict','sloppy','module','raw'].includes(row.program.mode)||
  !['requires-harness','metadata-review'].includes(row.status)||
  !Array.isArray(row.program.flags)||!Array.isArray(row.program.harness)||
  !Array.isArray(row.program.features)||
  !/^test\/[A-Za-z0-9_./-]+\.js$/.test(row.provenance.path)||
  row.provenance.path.split('/').includes('..')||
  row.program.sourceFile!==row.provenance.path)
  throw new Error('Malformed, non-Test262, unpinned or falsely verified acquisition row');
 return row;
}
export function shardForOrdinal(ordinal,count){
 if(!uint(ordinal,100000000)||!uint(count,64)||count<1)
  throw new TypeError('Invalid native-reference shard arguments');
 return ordinal%count;
}
const statusNames=['passed','failed','unsupported'];
export function aggregateNativeReferenceShards(shards,{expectedTotal=null}={}){
 if(!Array.isArray(shards)||shards.length<1||shards.length>64||
  expectedTotal!==null&&(!uint(expectedTotal,100000000)||expectedTotal<1))
  throw new TypeError('Invalid shard inventory');
 let shardCount=null,enumerated=null,catalogFingerprint=null,revision=null;
 const selected=new Set(),ordinals=new Set(),ids=new Set(),statuses={passed:0,failed:0,unsupported:0};
 let attempted=0,eligible=0;
 for(const {report,rows,rowsContent} of shards){
  if(report?.schema!=='test262-native-reference-report/1'||
   report.authority!=='native-v8-diagnostic-only'||
   report.verifiedOwned!==0||report.admitted!==0||
   !uint(report.shard?.index,63)||!uint(report.shard?.count,64)||
   report.shard.count<1||report.shard.index>=report.shard.count||
   !uint(report.shard.eligible,100000000)||report.shard.truncated!==false||
   !uint(report.enumerated,100000000)||
   !hex64.test(report.catalogFingerprint??'')||
   !hex64.test(report.rowsSha256??'')||
   typeof report.revision!=='string'||!/^[a-f0-9]{40}$/.test(report.revision)||
   !Array.isArray(rows)||typeof rowsContent!=='string'||
   !uint(report.attempted,100000000))
   throw new Error('Invalid native-reference shard report');
  const i=report.shard.index;
  if(shardCount===null){
   shardCount=report.shard.count;enumerated=report.enumerated;
   catalogFingerprint=report.catalogFingerprint;revision=report.revision;
  }else if(shardCount!==report.shard.count||
   enumerated!==report.enumerated||
   catalogFingerprint!==report.catalogFingerprint||
   revision!==report.revision)
   throw new Error('Native-reference shard inventory or source mismatch');
  if(selected.has(i))throw new Error('Duplicate native-reference shard index');
  selected.add(i);
  if(createHash('sha256').update(rowsContent).digest('hex')!==report.rowsSha256)
   throw new Error('Native-reference rows content digest mismatch');
  const expectedEligible=Math.floor(enumerated/shardCount)+
   (i<enumerated%shardCount?1:0);
  if(report.shard.eligible!==expectedEligible||
   rows.length!==report.attempted||rows.length!==expectedEligible)
   throw new Error('Native-reference shard rows missing or truncated');
  const counts={passed:0,failed:0,unsupported:0};
  for(const row of rows){
   if(!uint(row?.ordinal,100000000)||row.ordinal>=enumerated||
    shardForOrdinal(row.ordinal,shardCount)!==i||
    !hex64.test(row.id??'')||!hex64.test(row.sourceSha256??'')||
    row.authority!=='native-v8-diagnostic-only'||
    row.verifiedOwned!==false||row.admitted!==false||
    !statusNames.includes(row.status)||
    typeof row.path!=='string'||!row.path.startsWith('test/'))
    throw new Error('Invalid or non-diagnostic Test262 native-reference row');
   if(ordinals.has(row.ordinal))throw new Error('Duplicate native-reference ordinal');
   ordinals.add(row.ordinal);
   if(ids.has(row.id))throw new Error('Duplicate native-reference test identity');
   ids.add(row.id);counts[row.status]++;
  }
  for(const key of statusNames){
   if((report.counts?.[key]??0)!==counts[key])
    throw new Error('Native-reference shard status-count mismatch');
   statuses[key]+=counts[key];
  }
  if(Object.keys(report.counts??{}).some(k=>!statusNames.includes(k)))
   throw new Error('Unexpected native-reference status');
  attempted+=rows.length;eligible+=expectedEligible;
 }
 if(shards.length!==shardCount||selected.size!==shardCount||
   attempted!==enumerated||eligible!==enumerated||ordinals.size!==enumerated||
   expectedTotal!==null&&enumerated!==expectedTotal)
  throw new Error('Incomplete native-reference shard coverage');
 return {schema:'test262-native-reference-aggregate/1',
  authority:'native-v8-diagnostic-only',verifiedOwned:0,admitted:0,
  revision,catalogFingerprint,enumerated,attempted,shardCount,
  counts:statuses,distinctTestIdentities:ids.size,
  coverage:'complete-acquired-inventory-native-diagnostic-attempts',
  warnings:[
   'Native VM observations do not prove full Test262 conformance or any owned semantic-execution training examples.',
   'Passed means the native adapter completed its supported checks, not that assertions were necessarily present.',
   'Unsupported rows include phase, host and runtime features the adapter cannot execute.',
   'A complete shard ledger proves accounting only; it is not an independent cross-engine or intermediate-operation oracle.'
  ]};
}
