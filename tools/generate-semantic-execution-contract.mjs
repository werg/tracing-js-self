#!/usr/bin/env node
// One independently consumed v7 contract for normalized and detailed execution.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSemanticAlgorithmContract} from './generate-semantic-algorithm-contract.mjs';
import {WITNESS_SCHEMA,WITNESS_REQUIRED,HARNESS_RECORD_SCHEMAS,HARNESS_COMMON_FIELDS,
  COMPLETION_POLICIES,SELECTED_STATE_FIELDS,decodeWitness} from '../src/training/format.js';
import {encodeDetailedRecord,decodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const fragments=new Set(['value-open','value-part','value-close']);
const filterKinds=value=>Object.fromEntries(Object.entries(value).filter(([kind])=>!fragments.has(kind)));
export async function buildSemanticExecutionContract(){
  const algorithm=buildSemanticAlgorithmContract();
  const detailed={schema:'semantic-detailed-contract/7',execution:'semantic-execution/7',
    trace:'semantic-trace/7',context:'semantic-context/7',continuation:'semantic-continuation/7',
    profile:'selected-detailed/1',representation:'detailed',
    publicFields:['schema','profile','traceFormat','contextFormat','representation','timeline'],
    completionPolicies:COMPLETION_POLICIES,commonFields:HARNESS_COMMON_FIELDS,
    witness:{allowed:filterKinds(WITNESS_SCHEMA),required:filterKinds(WITNESS_REQUIRED),
      wrapperFields:['kind','fields'],prefix:'detail ',canonicality:'stableAlgorithmJSON with exact parse/re-encode equality',
      generated:Object.keys(WITNESS_SCHEMA).filter(kind=>!fragments.has(kind)&&!['code','input','observe'].includes(kind)),
      observed:['observe'],logicalFragments:'forbidden; only native physical fragmentation is supported'},
    envelope:HARNESS_RECORD_SCHEMAS,identity:{routing:'^[a-z][a-z0-9:_-]*$',owned:'^[a-z][a-z0-9]*$'},
    modelContext:{stateSchema:'semantic-continuation/7',stateFields:SELECTED_STATE_FIELDS,
      prefixDigest:'sha256-stableAlgorithmJSON-realm-prefix',visibleThrough:'receipt.sequence-1',
      sourceRead:'immediately-preceding-checked-source-read',observationLoss:0},
    contextEnvelope:{fields:['schema','representation','prefix','visibleThrough','prefixDigest'],
      prefixSchema:'selected-inference-prefix/3',
      prefixFields:['schema','representation','traceFormat','programId','entry','source','sourceDigest',
        'invocationId','trackId','realmId','committed','realmCommitted','completionPolicy','maxOutstanding',
        'taskRevision','parentInvocationId','receiver','closureId','activation','selectedState'],
      prefixDigest:'sha256-stableAlgorithmJSON-prefix',publication:'Full exact current public prefix at every generated record'},
    limits:{expressionOperators:8,expressionNodes:32,argumentRoots:32,inputGraphObjects:256,
      arrayLength:4096,generatedRecordBytes:65536},
    authority:{generated:['semantic'],observed:Object.keys(HARNESS_RECORD_SCHEMAS).filter(kind=>kind!=='semantic'),
      observationLoss:0,transportCreatesGuestBoundary:false,requestsPerCommittedSelection:1}};
  const golden=JSON.parse(await readFile(new URL('../test/fixtures/semantic-trace-v6.json',import.meta.url),'utf8'));
  const canonical=[];
  for(const previous of golden.canonical){
    const record=decodeWitness(previous.line);
    if(fragments.has(record.kind))continue;
    const role=record.kind==='observe'?'observed':['code','input'].includes(record.kind)?'any':'generated';
    const line=encodeDetailedRecord(record,{role});
    if(hashAlgorithmData(decodeDetailedRecord(line,{role}))!==hashAlgorithmData(record))
      throw new Error('Detailed fixture does not round-trip');
    canonical.push({record,line,role});
  }
  const invalid=['return 9','end return','compute (1 + 2) => 3',
    'detail {"kind":"return","fields":{"value":["num",9]}}',
    'detail {"fields":{"value":["num",9]},"kind":"return","future":true}',
    'detail {"fields":{"value":["num",9]},"kind":"return","kind":"return"}',
    'detail {"fields":{"value":["num",-0]},"kind":"return"}',
    'detail {"fields":{"id":"r1","data":"return 9"},"kind":"value-part"}',
    'detail {"fields":{"value":["num",9],"privateFuture":true},"kind":"return"}',
    'detail {"fields":{"value":["num",9]},"kind":"return"}\n'];
  for(const line of invalid){let refused=false;try{decodeDetailedRecord(line);}catch{refused=true;}
    if(!refused)throw new Error('Invalid detailed fixture was accepted: '+line);}
  const definition={schema:'semantic-execution-contract/7',status:'candidate',
    execution:'semantic-execution/7',trace:'semantic-trace/7',context:'semantic-context/7',
    representations:['algorithm','detailed'],profiles:{algorithm:algorithm.definition,detailed},
    identity:{canonicalJSON:'stableAlgorithmJSON',digest:'sha256-utf8',
      public:'hash(public)',contexts:'hash(contexts)',source:'separate fresh source/reference/journal replay receipt'},
    nativeAdmission:{schema:'semantic-native-admission/7',componentGate:'native-consumer-only',
      fields:['schema','componentGate','traceFormat','representation','episodeDigest','contextsDigest',
        'consumerRevision','schemaDigest','fixtureDigest','contractDigest','tokenizerIdentity','tokenizerSha256',
        'generatedTokens','observedTokens','physicalRecords','actions','lossMaskValidated','visibilityValidated',
        'fragmentationValidated','contextValidated','continuationValidated','admitted','optimizerSteps'],
      sourceAuthority:'Never inferred from this native-only receipt'},
    sourceAdmission:{schema:'semantic-source-admission/7',
      fields:['schema','producerRevision','episodeDigest','contextsDigest','sourceValidated',
        'journalValidated','replayValidated','referenceStatus','optimizerSteps']},
    datasets:{familyRegistry:'semantic-family-registry/1',splitIdentity:'semantic-split-identity/2',
      rule:'Declared semantic relatives, identical normalized cores and exact source aliases share one split',
      legacyArtifacts:'Rejected. Regenerate public records, native receipts, prepared data and model-bound indexes.'}};
  const fixtures={algorithm:algorithm.fixtures,detailed:{canonical,invalid,
    invalidGenerated:[canonical.find(row=>row.record.kind==='observe')?.line].filter(Boolean),
    invalidObserved:[canonical.find(row=>row.record.kind==='return')?.line].filter(Boolean)}};
  return {definition,digest:hashAlgorithmData(definition),fixtureDigest:hashAlgorithmData(fixtures),fixtures};
}

export async function generateSemanticExecutionContract({check=false,
  destination=new URL('../contracts/semantic-execution-v7.json',import.meta.url)}={}){
  const artifact=await buildSemanticExecutionContract(),text=JSON.stringify(artifact,null,2)+'\n';
  if(check){if(await readFile(destination,'utf8')!==text)throw new Error('V7 execution contract needs regeneration');}
  else await writeFile(destination,text);
  return {schema:artifact.definition.schema,digest:artifact.digest,fixtureDigest:artifact.fixtureDigest};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).some(arg=>arg!=='--check')||process.argv.filter(arg=>arg==='--check').length>1)
    throw new Error('Usage: node tools/generate-semantic-execution-contract.mjs [--check]');
  process.stdout.write(JSON.stringify(await generateSemanticExecutionContract({check:process.argv.includes('--check')}))+'\n');
}
