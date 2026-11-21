#!/usr/bin/env node
// Actual-model recovery across one accepted session and one cancelled sibling.
// A is validated against live producer state before native commit; private
// original-source correspondence is checked only after that rollout. B is
// sampled by the same native service, then closed without semantic ack.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {RegionSelectedModelDriver} from '../src/semantic/selected-execution-v8.js';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const options=new Map(),required=['--megatoken','--python','--served','--source','--request','--out'];
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index],value=process.argv[index+1];
  if(![...required,'--seed','--max-tokens','--max-fragments'].includes(key)||
    options.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Use --megatoken DIR --python EXECUTABLE --served DIR --source ARTIFACT.json --request selection-request.json --out NEW_DIR [--seed N --max-tokens N --max-fragments N]');
  options.set(key,value);
}
for(const key of required)if(!options.has(key))throw new TypeError('Required '+key);

const producerRoot=fileURLToPath(new URL('..',import.meta.url)),
  consumerRoot=resolve(options.get('--megatoken')),output=resolve(options.get('--out')),
  served=resolve(options.get('--served')),sourcePath=resolve(options.get('--source')),
  requestPath=resolve(options.get('--request')),python=options.get('--python'),
  seed=Number(options.get('--seed')??17),maxTokens=Number(options.get('--max-tokens')??18),
  maxFragments=Number(options.get('--max-fragments')??1);
assert(Number.isSafeInteger(seed)&&seed>=0,'Nonnegative integer seed required');
assert(Number.isSafeInteger(maxTokens)&&maxTokens>=1&&maxTokens<=8192,'Token bound required');
assert(Number.isSafeInteger(maxFragments)&&maxFragments>=1&&maxFragments<=64,'Fragment bound required');

const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const cleanIdentity=root=>{
  assert.equal(git(root,'status','--porcelain','--untracked-files=all'),'','Exact clean checkout required: '+root);
  return {revision:git(root,'rev-parse','HEAD'),tree:git(root,'rev-parse','HEAD^{tree}')};
};
const producer=cleanIdentity(producerRoot),consumer=cleanIdentity(consumerRoot);
for(const root of [producerRoot,consumerRoot]){
  const path=relative(root,output);
  assert(path==='..'||path.startsWith('..'+sep)||isAbsolute(path),'Evidence must be outside the frozen checkouts');
}
assert(!existsSync(output),'Evidence directory already exists');

const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),
  bytesSha=bytes=>createHash('sha256').update(bytes).digest('hex'),
  readJSON=path=>JSON.parse(readFileSync(path,'utf8')),
  copy=structuredClone;
const sourceBytes=readFileSync(sourcePath),requestBytes=readFileSync(requestPath),
  source=JSON.parse(sourceBytes),suppliedRequest=JSON.parse(requestBytes),
  manifest=readJSON(join(served,'manifest.json')),
  modelSha=bytesSha(readFileSync(join(served,'model.safetensors'))),
  tokenizerSha=bytesSha(readFileSync(join(served,manifest.codec_file??'tokenizer.json')));
assert.equal(modelSha,manifest.model_sha256,'Model bytes differ from serving manifest');
assert.equal(tokenizerSha,manifest.tokenizer_sha256,'Tokenizer bytes differ from serving manifest');

const env={...process.env,PYTHONPATH:join(consumerRoot,'src'),OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'},
  pythonRuntime=JSON.parse(execFileSync(python,['-c',
    'import json,pathlib,sys,torch,tokenizers,numpy,safetensors,megatoken; print(json.dumps({"python":sys.version,"torch":torch.__version__,"tokenizers":tokenizers.__version__,"numpy":numpy.__version__,"safetensors":safetensors.__version__,"module":str(pathlib.Path(megatoken.__file__).resolve())}))'],
    {cwd:consumerRoot,env,encoding:'utf8'}));
assert.equal(pythonRuntime.module,join(consumerRoot,'src/megatoken/__init__.py'),'Python imported another checkout');

const firstGenerated=source.public?.timeline?.findIndex(row=>row.mode==='generated');
assert(Number.isSafeInteger(firstGenerated)&&firstGenerated>0,
  'Original source needs a nonempty observed prefix and a selected record');
const initialPublic={...source.public,timeline:source.public.timeline.slice(0,firstGenerated)},
  invocationId=source.public.timeline[firstGenerated].fields.invocationId,
  initial=RegionExecutionHarness.replay(initialPublic,{requireTerminal:false}),
  requestA={session:initial.inner.sessionId,public:initial.exportEpisode(),contexts:[],
    context:initial.modelContext(invocationId)};
assert.deepEqual(requestA,suppliedRequest,
  'The supplied request is not the producer-derived first request for this source prefix');
mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
const input={schema:'semantic-model-closed-session-run/1',producer,consumer,
  command:[process.execPath,...process.argv.slice(1)],node:process.version,pythonRuntime,
  sourceArtifactSha256:bytesSha(sourceBytes),selectionRequestSha256:bytesSha(requestBytes),
  modelSha256:modelSha,tokenizerSha256:tokenizerSha,
  manifestSha256:bytesSha(readFileSync(join(served,'manifest.json'))),
  trainingIdentity:manifest.semantic_v8_lineage_digest??null,seed,maxTokens,maxFragments,
  maximumSessions:2,optimizationPerformed:false,
  scope:'One producer-accepted actual model record for session A; one actual sibling candidate for B is closed without acknowledgement; exact native restore and next A output parity. No full-program or generalization claim.'};
save('run-input.json',input);save('original-source.json',source);
save('selection-request.json',suppliedRequest);save('serving-manifest.json',manifest);

const services=[],serviceCommands=[],live={
  sourceArtifactSha256:input.sourceArtifactSha256,
  selectionRequestSha256:input.selectionRequestSha256,
  invocationId,sessionA:requestA.session,
};
const volatileSelectionFields=['generationSeconds','preparationSeconds','totalSeconds'],
  exactSelection=selection=>selection&&Object.fromEntries(Object.entries(selection)
    .filter(([key])=>!volatileSelectionFields.includes(key)));
function probeRepresentation(probe){
  if(probe.disposition==='selected')return {...probe,output:{...probe.output,
    selection:exactSelection(probe.output.selection)}};
  const evidence=probe.evidence??{};
  return {disposition:probe.disposition,category:probe.category??null,
    message:probe.message??null,provenanceValidated:probe.provenanceValidated===true,
    record:evidence.record??null,rawPayloadHex:evidence.rawPayloadHex??null,
    selection:exactSelection(evidence.selection)};
}
function provenanceBoundRefusal(error,request){
  const evidence=error?.evidence,selection=evidence?.selection;
  const recordedPayload=typeof evidence?.record==='string'?
    Buffer.from(evidence.record,'utf8').toString('hex'):evidence?.rawPayloadHex;
  return evidence?.provenanceValidated===true&&selection?.modelSelected===true&&
    selection.origin==='actual-model-selected'&&selection.session===request.session&&
    selection.invocationId===request.context.invocationId&&
    selection.checkpointIdentity===modelSha&&selection.tokenizerIdentity===manifest.codec_fingerprint&&
    (selection.trainingIdentity??null)===(manifest.semantic_v8_lineage_digest??null)&&
    selection.prefixDigest===request.context.prefixDigest&&
    selection.contextDigest===hashAlgorithmData(request.context)&&
    typeof selection.payloadHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(selection.payloadHex)&&
    (recordedPayload===undefined||recordedPayload===null||recordedPayload===selection.payloadHex)&&
    Array.isArray(selection.fragments)&&selection.fragments.every(row=>
      typeof row.payloadHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(row.payloadHex))&&
    selection.fragments.map(row=>row.payloadHex).join('')===selection.payloadHex;
}
async function probeNext(select,request,name){
  try{
    const output=await select(request),probe={disposition:'selected',output,provenanceValidated:true};
    save(name,probe);return {probe,provenanceValidated:true};
  }catch(error){
    const validated=provenanceBoundRefusal(error,request),probe={disposition:'refused',
      category:error.category??null,message:String(error.message),evidence:error.evidence??null,
      provenanceValidated:validated};
    save(name,probe);return {probe,provenanceValidated:validated};
  }
}
function withoutSession(value){
  const result=copy(value);
  for(const row of result.timeline)row.fields.session='session-placeholder';
  return result;
}

let original,restored,driver;
try{
  const profileDir=join(output,'profiles');mkdirSync(profileDir);
  const open=(name)=>{
    const args=['scripts/serve_semantic_v8.py','--served',served,'--device','cpu','--threads','1',
      '--effort','1','--max-tokens',String(maxTokens),'--max-fragments',String(maxFragments),
      '--max-sessions','2','--profile-output',join(profileDir,name+'-profile.json')];
    serviceCommands.push({name,command:[python,...args],cwd:consumerRoot});
    const transport=createNativeV8ProcessSelector({command:python,args,cwd:consumerRoot,env,
      maxMessageBytes:64*1024*1024,timeoutMs:300000});
    services.push(transport);return transport;
  };
  original=open('original-service');
  const initialization={checkpointIdentity:modelSha,tokenizerIdentity:manifest.codec_fingerprint,
    trainingIdentity:manifest.semantic_v8_lineage_digest??null,seed};
  save('initialize-request.json',initialization);
  const nativeIdentity=await original.initialize(initialization);save('initialize-response.json',nativeIdentity);
  const policy={checkpointIdentity:modelSha,tokenizerIdentity:manifest.codec_fingerprint,nativeIdentity,
    hostLimits:{maxGenerated:initial.inner.maxGenerated,maxOutstanding:initial.inner.maxOutstanding},
    automaticDelivery:initial.inner.automaticDelivery,
    maxSelections:8,maxOutstanding:4,maxStaleRetries:1};
  save('execution-policy.json',policy);
  driver=new RegionSelectedModelDriver({select:original,harness:initial,...policy});

  const accepted=await driver.select(requestA);
  live.actualSelectionA=copy(accepted);save('actual-selection-A.json',accepted);
  const selectedResult=driver.harness.selected(invocationId,accepted.record);
  await driver.onCommitted({invocationId,record:accepted.record,
    selection:accepted.selection,result:selectedResult});
  assert.equal(driver.attempts.length,1);assert.equal(driver.attempts[0].status,'accepted');
  assert.equal(driver.attempts[0].provenanceValidated,true);
  assert.equal(original.metrics().attempts[0].status,'accepted');
  live.acceptedA={record:accepted.record,selection:copy(accepted.selection),
    producerAttempt:copy(driver.attempts[0]),nativeAttempt:copy(original.metrics().attempts[0])};
  save('accepted-A.json',live.acceptedA);

  const hostCut=driver.bridge.checkpoint(),acceptedPublic=driver.bridge.exportEpisode(),
    contextsAfterA=copy(driver.contexts),
    nextRequestA=driver.prefix(invocationId);
  live.hostCut=hostCut;live.acceptedPublic=acceptedPublic;
  live.contextsAfterA=contextsAfterA;live.nextRequestA=nextRequestA;
  save('host-cut-after-A.json',hostCut);save('next-selection-request-A.json',nextRequestA);
  assert.deepEqual(contextsAfterA,source.contexts.slice(0,1),
    'Accepted A context differs from the source artifact context');

  // Derive B from the same observed public rows. Only the session authority
  // changes; producer replay recomputes B's own context and prefix digest.
  const sessionB='closed-sibling-b-v8';
  assert.notEqual(sessionB,requestA.session);
  const publicB=copy(initialPublic);
  for(const row of publicB.timeline){
    assert.equal(row.fields.session,requestA.session,'Source prefix has mixed session ownership');
    row.fields.session=sessionB;
  }
  assert.deepEqual(withoutSession(publicB),withoutSession(initialPublic),
    'Sibling B changed source input other than its session identity');
  const harnessB=RegionExecutionHarness.replay(publicB,{requireTerminal:false}),
    requestB={session:sessionB,public:harnessB.exportEpisode(),contexts:[],
      context:harnessB.modelContext(invocationId)};
  live.sessionB=sessionB;live.requestB=requestB;
  save('sibling-request-B.json',requestB);
  save('sibling-derivation.json',{derivedBy:'RegionExecutionHarness.replay',
    sourcePrefixDigest:requestA.context.prefixDigest,
    sessionA:requestA.session,sessionB,sameObservedSourceRowsExceptSession:true,
    contextAndPrefixDigestDerivedFromReplayedPublic:true});

  let bSelectionError=null,bOutput=null;
  try{
    bOutput=await original(requestB);
    live.siblingB={disposition:'candidate-returned-without-semantic-acknowledgement',
      output:copy(bOutput)};
  }catch(error){
    bSelectionError=error;
    live.siblingB={disposition:'refused',category:error.category??null,
      message:String(error.message),evidence:copy(error.evidence??null),
      provenanceValidated:provenanceBoundRefusal(error,requestB)};
  }
  save('sibling-B-output.json',live.siblingB);
  live.cancelB=await original.cancel({session:sessionB,reason:'cancel sibling B after one native candidate'});
  save('cancel-B-response.json',live.cancelB);
  assert.equal(live.cancelB.closed,true);
  const bRefusalBound=!bSelectionError||provenanceBoundRefusal(bSelectionError,requestB);
  const checkpoint=await original.checkpoint(),native=checkpoint.native;
  live.checkpoint=checkpoint;save('native-checkpoint-before-restart.json',checkpoint);
  assert.deepEqual(Object.keys(native.sessions),[requestA.session],
    'Checkpoint must retain only A as active');
  assert.deepEqual(Object.keys(native.closedSessions),[sessionB],
    'Checkpoint must retain B as a closed session');
  assert.equal(native.closedSessions[sessionB]?.unacknowledgedSelection,null);
  assert.equal(native.closedSessions[sessionB]?.public,null);
  assert.deepEqual(native.closedSessions[sessionB]?.contexts,[]);
  assert.deepEqual(native.closedSessions[sessionB]?.replay,[]);
  assert.deepEqual(native.sessions[requestA.session].public,driver.bridge.exportEpisode());
  assert.deepEqual(native.sessions[requestA.session].contexts,contextsAfterA);
  assert.deepEqual(native.sessions[requestA.session].replay.length,1);
  assert.equal(native.sessions[requestA.session].unacknowledgedSelection,null);
  assert.deepEqual(native.attempts.map(row=>row.session),[requestA.session,sessionB]);
  assert.equal(native.attempts[0].status,'committed');
  assert(['cancelled','rejected'].includes(native.attempts[1].status),
    'B must retain its original candidate or refusal outcome');
  const siblingAttempt=native.attempts[1],siblingNativeCandidateGenerated=
    siblingAttempt.modelSelected===true&&Array.isArray(siblingAttempt.fragments)&&
    siblingAttempt.fragments.length>0&&typeof siblingAttempt.payloadHex==='string'&&
    siblingAttempt.fragments.map(row=>row.payloadHex).join('')===siblingAttempt.payloadHex;
  assert(siblingNativeCandidateGenerated,
    'B must retain its actual model candidate bytes before cancellation');
  const siblingReportedSelection=bOutput?.selection??bSelectionError?.evidence?.selection;
  assert.equal(siblingReportedSelection?.selectionId,siblingAttempt.selectionId);
  assert.equal(siblingReportedSelection?.payloadHex,siblingAttempt.payloadHex,
    'B transport evidence differs from the original native candidate bytes');
  if(bSelectionError)assert(bRefusalBound,
    'A refused B candidate must retain its provenance-bound original bytes');
  assert.deepEqual(native.openings.map(row=>row.session),[requestA.session,sessionB]);
  if(!bRefusalBound)
    throw bSelectionError;

  const originalNext=await probeNext(original,nextRequestA,'original-next-A.json');
  live.originalNext=originalNext.probe;
  if(!originalNext.provenanceValidated)
    throw new Error('Original next-output probe lacks bound actual-model evidence');
  const originalMetrics=original.metrics();live.originalMetrics=originalMetrics;
  save('original-transport-metrics.json',originalMetrics);
  save('original-shutdown.json',await original.shutdown());
  driver.close();driver=null;

  restored=open('restored-service');
  const restoreResponse=await restored.restore({checkpoint});
  live.restoreResponse=restoreResponse;save('native-restore-response.json',restoreResponse);
  assert.equal(restoreResponse.restored,true);
  assert.equal(restoreResponse.restoredSessions,1);
  assert.equal(restoreResponse.consumedAttempts,native.attempts.length);
  assert.equal(restoreResponse.hostDispatches,0);
  const afterRestore=await restored.checkpoint();live.restoredCheckpoint=afterRestore;
  save('native-checkpoint-after-restore.json',afterRestore);
  for(const key of ['native','attempts'])
    assert.deepEqual(afterRestore[key],checkpoint[key],'Restored native '+key+' changed');
  for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
    assert(afterRestore.runtimeMetrics[key]>=checkpoint.runtimeMetrics[key],
      'Native restore cost rolled back: '+key);
  for(const key of ['sessions','closedSessions','attempts','openings','randomState','settings'])
    assert.deepEqual(afterRestore.native[key],checkpoint.native[key],
      'Restored native '+key+' evidence changed');

  let closedRefusal,closedOutput;
  try{
    closedOutput=await restored(requestB);
  }catch(error){
    closedRefusal={category:error.category??null,message:String(error.message),
      evidence:error.evidence??null,modelOutputSampled:false};
    live.closedSessionRefusal=closedRefusal;
    save('closed-B-no-revival.json',closedRefusal);
    assert.match(closedRefusal.message,/closed v8 session/i);
  }
  if(closedOutput!==undefined){
    live.closedSessionUnexpectedOutput=copy(closedOutput);
    save('closed-B-no-revival.json',{disposition:'unexpected-output',output:closedOutput});
    assert.fail('Closed B unexpectedly selected another model output');
  }
  const afterClosedRefusal=await restored.checkpoint();live.afterClosedRefusal=afterClosedRefusal;
  assert.deepEqual(afterClosedRefusal.native,native,
    'Refusing closed B changed native sessions, attempts, costs or random state');
  assert.deepEqual(afterClosedRefusal.native.sessions[requestA.session],
    checkpoint.native.sessions[requestA.session]);
  assert.deepEqual(afterClosedRefusal.native.closedSessions[sessionB],
    checkpoint.native.closedSessions[sessionB]);

  const restoredNext=await probeNext(restored,nextRequestA,'restored-next-A.json');
  live.restoredNext=restoredNext.probe;
  if(!restoredNext.provenanceValidated)
    throw new Error('Restored next-output probe lacks bound actual-model evidence');
  assert.deepEqual(probeRepresentation(restoredNext.probe),probeRepresentation(originalNext.probe),
    'Next real A output/refusal or original model selection evidence changed');

  const hostAfterRestore=RegionExecutionHarness.restore(hostCut),
    restoredHostPublic=hostAfterRestore.exportEpisode(),
    restoredHostContext=hostAfterRestore.modelContext(invocationId);
  assert.deepEqual(restoredHostPublic,acceptedPublic,
    'Standalone acknowledged host cut did not restore exactly');
  assert.deepEqual(restoredHostContext,nextRequestA.context,
    'Restored host context differs from the next native request');
  live.restoredHost={public:restoredHostPublic,context:restoredHostContext};
  save('restored-host-cut.json',live.restoredHost);
  const checked=await recheckRegionEvidence(source,{requireNative:false});
  for(const key of ['valid','sourceValidated','projectionValidated','replayValidated'])
    assert.equal(checked[key],true,key);
  assert.deepEqual(acceptedPublic,{...source.public,
    timeline:source.public.timeline.slice(0,acceptedPublic.timeline.length)});
  assert.deepEqual(contextsAfterA,source.contexts.slice(0,1));
  assert.equal(accepted.record,live.acceptedA.record);
  assert.equal(accepted.selection.payloadHex,Buffer.from(accepted.record).toString('hex'));
  assert.equal(accepted.selection.fragments.map(row=>row.payloadHex).join(''),
    accepted.selection.payloadHex);
  const hostDispatches=acceptedPublic.timeline.filter(row=>row.kind==='dispatch').length;
  assert.equal(hostDispatches,0,'This bounded diagnostic must not dispatch a host effect');

  const restoredMetrics=restored.metrics();live.restoredMetrics=restoredMetrics;
  save('restored-transport-metrics.json',restoredMetrics);
  save('restored-shutdown.json',await restored.shutdown());
  restored=null;
  save('service-commands.json',serviceCommands);
  const nativeAttemptCosts=native.attempts.map(row=>({selectionId:row.selectionId,
    session:row.session,status:row.status,generatedTokens:row.generatedTokens,
    observedTokens:row.observedTokens,contextTokens:row.contextTokens,
    observedBytes:row.observedBytes,contextBytes:row.contextBytes,
    instructionTokens:row.instructionTokens,instructionBytes:row.instructionBytes}));
  const report={...input,status:'passed',acceptedModelRecords:1,
    siblingNativeCandidateGenerated:true,
    siblingRecordReturnedByTransport:bOutput!==null,
    siblingOutputDisposition:bSelectionError?'provenance-bound-refusal':'returned-unacknowledged',
    siblingRefusals:bSelectionError?1:0,siblingAcknowledgedRecords:0,
    activeSessionsExact:true,closedSessionsExact:true,attemptCostsExact:true,
    openingReceiptsExact:true,randomStateExact:true,completeNativeCheckpointExact:true,
    hostCutExact:true,closedSiblingCannotReopen:true,closedRefusalSampledNoOutput:true,
    nextAOutputExact:true,nextAOutputDisposition:restoredNext.probe.disposition,
    nextASelectionAcknowledged:false,sourceValidated:true,projectionValidated:true,
    replayValidated:true,originalSourcePrefixExact:true,originalModelPayloadExact:true,
    hostDispatches,completeSourceExecution:false,heldoutTested:false,
    generalizationEstablished:false,modelTrainingForThisRun:false,
    activeSession:requestA.session,closedSession:sessionB,
    nativeAttemptCosts,nativeOpenings:native.openings,
    activeCut:native.sessions[requestA.session],closedCut:native.closedSessions[sessionB],
    originalNext:originalNext.probe,restoredNext:restoredNext.probe,
    originalTransportMetrics:originalMetrics,restoredTransportMetrics:restoredMetrics,
    costScope:'Actual A acknowledgement, B candidate/refusal and cancellation, native checkpoint, fresh-process replay, closed-ID refusal and one unacknowledged next-A output probe in each service. Excludes model training.',
    volatileSelectionFields,serviceCommands};
  save('report.json',report);
  console.log(JSON.stringify({status:report.status,producer:producer.revision,
    consumer:consumer.revision,acceptedModelRecords:1,siblingNativeCandidateGenerated:true,
    siblingOutputDisposition:report.siblingOutputDisposition,activeSessionsExact:true,
    closedSessionsExact:true,nextAOutputExact:true,
    nextAOutputDisposition:restoredNext.probe.disposition,hostDispatches,output}));
}catch(error){
  const failure={...input,status:'failed',message:String(error.message),stack:error.stack,
    evidence:error.evidence??null,live,serviceCommands,
    producerAttempts:driver?.attempts??null,
    services:services.map(service=>({status:service.status(),metrics:service.metrics()})),shutdowns:[]};
  for(const service of services){
    if(service.status().closed||service.status().pending){
      failure.shutdowns.push({graceful:false,status:service.status()});continue;
    }
    try{failure.shutdowns.push(await service.shutdown());}
    catch(shutdownError){failure.shutdowns.push({graceful:false,error:String(shutdownError.message)});}
  }
  try{save('failed-attempt.json',failure);}
  catch(saveError){
    writeFileSync(join(output,'failed-attempt-save-error.txt'),
      String(saveError.message)+'\n'+JSON.stringify(failure,null,2)+'\n',{flag:'wx'});
  }
  throw error;
}finally{
  driver?.close();
  for(const service of services)if(!service.status().closed)service.close();
}
