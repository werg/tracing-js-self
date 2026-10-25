#!/usr/bin/env node
// Generate shared fixtures from the single executable JS declaration. Python
// imports the fixture bytes but retains its independent semantic validator.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {EXECUTION_VERSION,WITNESS_VERSION,CONTEXT_VERSION,CONTINUATION_VERSION,HARNESS_PROFILE,
  WITNESS_SCHEMA,WITNESS_REQUIRED,HARNESS_RECORD_SCHEMAS,HARNESS_COMMON_FIELDS,
  COMPLETION_POLICIES,SELECTED_STATE_FIELDS,MODEL_CONTEXT_INTERVAL,
  encodeWitness as w,decodeWitness,validateHarnessRecord} from '../src/training/format.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition={schema:'semantic-harness-contract/4',execution:EXECUTION_VERSION,trace:WITNESS_VERSION,
  context:CONTEXT_VERSION,continuation:CONTINUATION_VERSION,profile:HARNESS_PROFILE,
  completionPolicies:COMPLETION_POLICIES,commonFields:HARNESS_COMMON_FIELDS,
  witness:{allowed:WITNESS_SCHEMA,required:WITNESS_REQUIRED},envelope:HARNESS_RECORD_SCHEMAS,
  identity:{routing:'^[a-z][a-z0-9:_-]*$',owned:'^[a-z][a-z0-9]*$'},
  modelContext:{stateSchema:CONTINUATION_VERSION,stateFields:SELECTED_STATE_FIELDS,
    selectedRecordInterval:MODEL_CONTEXT_INTERVAL,prefixDigest:'sha256-json-stringify-realm-prefix',
    visibleThrough:'receipt.sequence-1',sourceRead:'immediately-preceding-checked-source-read',observationLoss:0},
  limits:{expressionOperators:8,expressionNodes:32,argumentRoots:32,inputGraphObjects:256,
    arrayLength:4096,generatedRecordBytes:65536},
  authority:{generated:['semantic'],observed:Object.keys(HARNESS_RECORD_SCHEMAS).filter(kind=>kind!=='semantic'),
    observationLoss:0,transportCreatesGuestBoundary:false,requestsPerCommittedSelection:1}};
const validWitness=[
  w('input',{graph:{roots:[['ref','retained']],objects:[]},retained:['retained']}),
  w('promise',{action:'create',promise:'result'}),
  w('promise',{action:'react',promise:'source',reaction:'then',closure:'fulfilled',rejectionClosure:'rejected',target:'result',job:'reaction'}),
  w('request',{effect:'effect',operation:'demo.readAsync',invocation:'outside:1',site:{start:22,end:41},
    arguments:[['str','key']],payload:'["key"]',promise:'read'}),
  w('await',{promise:'read',continuation:'continuation',invocation:'outside:1',returnPromise:'result'}),
  w('resume',{continuation:'continuation',invocation:'outside:1',status:'fulfilled',result:['num','NaN']}),
  w('job',{action:'enqueue',job:'microtask',owner:'outside:1',closure:'handler'}),
  w('observe',{effect:'effect',status:'fulfilled',result:['ref','o0'],graph:{roots:[['ref','o0']],
    objects:[{id:'o0',kind:'object',properties:[{key:'self',value:['ref','o0']}]}]}})
];
const invalidWitness=[
  'request {"effect":"effect","operation":"demo.readAsync","arguments":[],"invocation":"i1","payload":"[]"}',
  'promise {"action":"react","promise":"p","reaction":"catch","job":"j","rejectionClosure":"f"}',
  'resume {"continuation":"c","invocation":"i","status":"pending","result":["undefined"]}',
  'return {"value":["num",1],"teacherFuture":true}',
  'input {"graph":{"roots":[["ref","missing"]],"objects":[]}}',
  'job {"action":"dispatch","job":"j","owner":"i","closure":"f"}'
];
for(const line of validWitness)decodeWitness(line);
for(const line of invalidWitness){let rejected=false;try{decodeWitness(line);}catch{rejected=true;}
  if(!rejected)throw new Error('Invalid declared fixture was accepted');}
const h=new SelectedExecutionHarness({sessionId:'contract'});
h.publishProgram({programId:'identity',source:'function run(value){return value;}',entry:'run'});
h.admitInvocation({programId:'identity',invocationId:'outside:1',trackId:'worker:9',realmId:'realm',
  triggerId:'caller',args:[7],completionPolicy:'call-return'});
h.selected('outside:1',w('return',{value:['num',7]}));h.selected('outside:1',w('end',{kind:'return'}));
const validEnvelope=h.exportEpisode();
const invalidEnvelope=[structuredClone(validEnvelope),structuredClone(validEnvelope),structuredClone(validEnvelope)];
invalidEnvelope[0].public.traceFormat='semantic-trace/3';
invalidEnvelope[1].public.timeline[1].mode='generated';
delete invalidEnvelope[2].public.timeline[1].receiver;
const contextual=new SelectedExecutionHarness({sessionId:'contextcontract'});
contextual.publishProgram({programId:'identity',source:'function run(value){return value;}',entry:'run'});
contextual.admitInvocation({programId:'identity',invocationId:'outside:1',trackId:'worker:9',realmId:'realm',
  triggerId:'caller',args:[7],completionPolicy:'call-return'});
contextual.restoreSource('worker:9','identity');
contextual.recordModelContext('outside:1',[],{includeState:true});
contextual.selected('outside:1',w('return',{value:['num',7]}));
contextual.selected('outside:1',w('end',{kind:'return'}));
const validContext=contextual.exportEpisode();
const forgedState=structuredClone(validContext),futureState=structuredClone(validContext),foreignPrefix=structuredClone(validContext);
forgedState.public.timeline[3].selectedState.locals[0][1]=['num',8];
futureState.public.timeline[3].visibleThrough++;
foreignPrefix.public.timeline[3].realmPrefixDigest='0'.repeat(64);
invalidEnvelope.push(forgedState,futureState,foreignPrefix);
for(const document of [validEnvelope,validContext]){
  for(const record of document.public.timeline)validateHarnessRecord(record);
  SelectedExecutionHarness.replay(document);
}
for(const document of invalidEnvelope){let rejected=false;try{SelectedExecutionHarness.replay(document);}catch{rejected=true;}
  if(!rejected)throw new Error('Invalid envelope fixture was accepted');}
const fixtures={witness:{valid:validWitness,invalid:invalidWitness},
  envelope:{valid:[validEnvelope,validContext],invalid:invalidEnvelope}};
const artifact={definition,digest:digest(definition),fixtureDigest:digest(fixtures),fixtures};
const bytes=JSON.stringify(artifact,null,2)+'\n';
const destination=new URL('../contracts/semantic-harness-v4.json',import.meta.url);
if(process.argv.includes('--check')){
  if(await readFile(destination,'utf8')!==bytes)throw new Error('Shared semantic contract needs regeneration');
}else await writeFile(destination,bytes);
process.stdout.write(JSON.stringify({schema:definition.schema,digest:artifact.digest,fixtureDigest:artifact.fixtureDigest})+'\n');
