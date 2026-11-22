#!/usr/bin/env node
// Actual-model explicit-cut recovery. Only the initial public prefix and causal
// context reach serving; original-source correspondence is checked after rollout.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {RegionSelectedModelDriver} from '../src/semantic/selected-execution-v8.js';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';

const options=new Map(),required=['--megatoken','--python','--served','--source','--out'];
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index],value=process.argv[index+1];
  if(![...required,'--seed','--max-tokens','--max-fragments','--history-mode'].includes(key)||
    options.has(key)||!value||value.startsWith('--'))
    throw new TypeError('Use --megatoken DIR --python EXECUTABLE --served DIR --source ARTIFACT.json --out NEW_DIR [--seed N --max-tokens N --max-fragments N --history-mode explicit|automatic]');
  options.set(key,value);
}
for(const key of required)if(!options.has(key))throw new TypeError('Required '+key);
const producerRoot=fileURLToPath(new URL('..',import.meta.url)),consumerRoot=resolve(options.get('--megatoken')),
  output=resolve(options.get('--out')),served=resolve(options.get('--served')),sourcePath=resolve(options.get('--source')),
  python=options.get('--python'),seed=Number(options.get('--seed')??17),
  maxTokens=Number(options.get('--max-tokens')??128),maxFragments=Number(options.get('--max-fragments')??1),
  historyMode=options.get('--history-mode')??'explicit';
assert(['explicit','automatic'].includes(historyMode),'History mode must be explicit or automatic');
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
mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),
  bytesSha=bytes=>createHash('sha256').update(bytes).digest('hex'),
  readJSON=path=>JSON.parse(readFileSync(path,'utf8'));
const sourceBytes=readFileSync(sourcePath),source=JSON.parse(sourceBytes),manifest=readJSON(join(served,'manifest.json')),
  modelSha=bytesSha(readFileSync(join(served,'model.safetensors'))),
  tokenizerSha=bytesSha(readFileSync(join(served,manifest.codec_file??'tokenizer.json')));
assert.equal(modelSha,manifest.model_sha256,'Model bytes differ from serving manifest');
assert.equal(tokenizerSha,manifest.tokenizer_sha256,'Tokenizer bytes differ from serving manifest');
const env={...process.env,PYTHONPATH:join(consumerRoot,'src'),OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'},
  pythonRuntime=JSON.parse(execFileSync(python,['-c',
    'import json, pathlib, sys, torch, megatoken; print(json.dumps({"python":sys.version,"torch":torch.__version__,"module":str(pathlib.Path(megatoken.__file__).resolve())}))'],
    {cwd:consumerRoot,env,encoding:'utf8'}));
assert.equal(pythonRuntime.module,join(consumerRoot,'src/megatoken/__init__.py'),'Python imported another checkout');
const firstGenerated=source.public?.timeline?.findIndex(row=>row.mode==='generated');
assert(Number.isSafeInteger(firstGenerated)&&firstGenerated>0,'Original source needs a nonempty observed prefix and selected record');
const initialPublic={...source.public,timeline:source.public.timeline.slice(0,firstGenerated)},
  invocationId=source.public.timeline[firstGenerated].fields.invocationId,
  initial=RegionExecutionHarness.replay(initialPublic,{requireTerminal:false});
assert.equal(initial.exportEpisode().timeline.filter(row=>row.mode==='generated').length,0);
const input={schema:'semantic-model-checkpoint-history-run/1',producer,consumer,
  command:[process.execPath,...process.argv.slice(1)],node:process.version,pythonRuntime,
  sourceArtifactSha256:bytesSha(sourceBytes),modelSha256:modelSha,tokenizerSha256:tokenizerSha,
  manifestSha256:bytesSha(readFileSync(join(served,'manifest.json'))),
  trainingIdentity:manifest.semantic_v8_lineage_digest??null,seed,maxTokens,maxFragments,historyMode,
  optimizationPerformed:false,scope:'One actual model selection; checkpoint-cut recovery and next-output equality. No complete-program or generalization claim.'};
save('run-input.json',input);save('original-source.json',source);save('serving-manifest.json',manifest);
const services=[],serviceCommands=[];
const volatileSelectionFields=['generationSeconds','preparationSeconds','totalSeconds'],
  exactSelection=selection=>Object.fromEntries(Object.entries(selection).filter(([key])=>!volatileSelectionFields.includes(key)));
async function probeNext(select,request,name){
  try{
    const output=await select(request),probe={disposition:'selected',output};
    save(name,probe);return probe;
  }catch(error){
    // A malformed actual model continuation is still original evidence. Only a
    // provenance-checked model output can qualify this comparison; timeouts or
    // unbound infrastructure failures remain failures of the diagnostic.
    if(error.evidence?.provenanceValidated!==true||error.evidence.selection?.modelSelected!==true)throw error;
    const probe={disposition:'refused',category:error.category??null,message:String(error.message),
      evidence:error.evidence};
    save(name,probe);return probe;
  }
}
function deterministicProbe(probe){
  if(probe.disposition==='selected')return {...probe,output:{...probe.output,selection:exactSelection(probe.output.selection)}};
  return {...probe,evidence:{...probe.evidence,selection:exactSelection(probe.evidence.selection)}};
}
const openService=name=>{
  const args=['scripts/serve_semantic_v8.py','--served',served,'--device','cpu','--threads','1',
    '--effort','1','--max-tokens',String(maxTokens),'--max-fragments',String(maxFragments),
    '--profile-output',join(output,name+'-profile.json')];
  serviceCommands.push({name,command:[python,...args],cwd:consumerRoot});
  const transport=createNativeV8ProcessSelector({command:python,args,cwd:consumerRoot,env,
    maxMessageBytes:64*1024*1024,timeoutMs:300000});
  services.push(transport);return transport;
};
let originalDriver,restoredDriver;
try{
  const original=openService('original-service'),initialization={checkpointIdentity:modelSha,
    tokenizerIdentity:manifest.codec_fingerprint,trainingIdentity:manifest.semantic_v8_lineage_digest??null,seed};
  save('initialize-request.json',initialization);
  const nativeIdentity=await original.initialize(initialization);save('initialize-response.json',nativeIdentity);
  const policy={checkpointIdentity:modelSha,tokenizerIdentity:manifest.codec_fingerprint,nativeIdentity,
    hostLimits:{maxGenerated:initial.inner.maxGenerated,maxOutstanding:initial.inner.maxOutstanding},
    automaticDelivery:initial.inner.automaticDelivery,maxSelections:8,maxOutstanding:4,maxStaleRetries:1};
  save('execution-policy.json',policy);
  originalDriver=new RegionSelectedModelDriver({select:original,harness:initial,...policy});
  const historyDirectory=join(output,'history'),journal=new DurableSelectedHistoryJournal({
    directory:historyDirectory,streamId:'actual-model-cuts'});
  const headPath=join(output,'independently-retained-head.json');
  const acknowledge=async({receipt,previous})=>{
    // The diagnostic exclusively owns this new directory. This file is a
    // separate application head, not a scan for the newest journal entry.
    const current=existsSync(headPath)?readJSON(headPath):null;
    assert.deepEqual(current,previous,'Application durable head changed');
    const temporary=headPath+'.next',file=openSync(temporary,'wx',0o600);
    try{writeFileSync(file,JSON.stringify(receipt)+'\n');fsyncSync(file);}finally{closeSync(file);}
    renameSync(temporary,headPath);const directory=openSync(output,'r');
    try{fsyncSync(directory);}finally{closeSync(directory);}
    return readJSON(headPath);
  };
  const earlier=historyMode==='automatic'?await originalDriver.enableDurableHistory({journal,acknowledge}):
    await originalDriver.checkpointDurableHistory({journal});
  save('earlier-cut.json',earlier);
  const request=originalDriver.prefix(invocationId);save('selection-request.json',request);
  const selected=await originalDriver.select(request);save('actual-selection.json',selected);
  // Use the same selection, public commitment and native acknowledgement methods
  // as the ordinary driver, stopping at one explicit cut without cancelling it.
  const result=originalDriver.harness.selected(invocationId,selected.record);
  await originalDriver.onCommitted({invocationId,record:selected.record,selection:selected.selection,result});
  const later=historyMode==='automatic'?{
    checkpoint:(await journal.readAll(readJSON(headPath))).at(-1).checkpoint,receipt:readJSON(headPath)
  }:await originalDriver.checkpointDurableHistory({journal,previous:earlier.receipt});
  if(historyMode==='automatic')assert.deepEqual(later.receipt,originalDriver.historyReceipt);
  save('later-cut.json',later);
  assert.equal(earlier.checkpoint.attempts.length,0);assert.equal(later.checkpoint.attempts.length,1);
  assert.equal(later.checkpoint.attempts[0].status,'accepted');assert.equal(later.checkpoint.contexts.length,1);
  const nextRequest=originalDriver.prefix(invocationId);save('next-selection-request.json',nextRequest);
  const originalNext=await probeNext(original,nextRequest,'original-next-selection.json');
  const originalTransportMetrics=original.metrics();save('original-transport-metrics.json',originalTransportMetrics);
  save('original-shutdown.json',await original.shutdown());originalDriver.close();

  const fresh=openService('restored-service'),nativeRestore=fresh.restore;
  fresh.restore=async request=>{
    save('native-restore-request.json',request);
    const result=await nativeRestore(request);save('native-restore-response.json',result);return result;
  };
  restoredDriver=await RegionSelectedModelDriver.restoreLatest(earlier.checkpoint,{select:fresh,policy,
    historyJournal:new DurableSelectedHistoryJournal({directory:historyDirectory,streamId:'actual-model-cuts'}),
    historyReceipt:later.receipt});
  const restored=await restoredDriver.checkpoint();save('restored-checkpoint.json',restored);
  for(const key of ['policy','bridge','contexts','attempts','staleRetries'])
    assert.deepEqual(restored[key],later.checkpoint[key],'Restored '+key+' changed');
  assert.deepEqual(restored.native.native,later.checkpoint.native.native,'Complete native checkpoint changed');
  assert.deepEqual(restored.native.attempts,later.checkpoint.native.attempts,'Transport attempts changed');
  for(const key of ['rpcCalls','computeSeconds','peakMemoryBytes'])
    assert(restored.native.runtimeMetrics[key]>=later.checkpoint.native.runtimeMetrics[key],'Retained cost rolled back: '+key);
  assert.deepEqual(restoredDriver.prefix(invocationId),nextRequest,'Restored prediction context changed');
  const restoredNext=await probeNext(fresh,restoredDriver.prefix(invocationId),'restored-next-selection.json');
  assert.deepEqual(deterministicProbe(restoredNext),deterministicProbe(originalNext),
    'Next original output, refusal or complete deterministic selection evidence changed');
  const restoredTransportMetrics=fresh.metrics();save('restored-transport-metrics.json',restoredTransportMetrics);
  save('restored-shutdown.json',await fresh.shutdown());restoredDriver.close();

  // Only after the actual selections are complete, independently recheck the
  // original source and compare its certified prefix with the emitted bytes.
  const checked=await recheckRegionEvidence(source,{requireNative:false});
  for(const key of ['valid','sourceValidated','projectionValidated','replayValidated'])assert.equal(checked[key],true,key);
  const actualPublic=later.checkpoint.bridge.public;
  assert.deepEqual(actualPublic,{...source.public,timeline:source.public.timeline.slice(0,actualPublic.timeline.length)});
  assert.deepEqual(later.checkpoint.contexts,source.contexts.slice(0,1));
  assert.equal(selected.selection.payloadHex,Buffer.from(selected.record).toString('hex'));
  assert.equal(selected.selection.fragments.map(row=>row.payloadHex).join(''),selected.selection.payloadHex);
  const dispatches=actualPublic.timeline.filter(row=>row.kind==='dispatch').length;
  assert.equal(dispatches,0,'This bounded diagnostic must not dispatch a host effect');
  assert.deepEqual(cleanIdentity(producerRoot),producer);assert.deepEqual(cleanIdentity(consumerRoot),consumer);
  save('service-commands.json',serviceCommands);
  const priorCosts=later.checkpoint.native.runtimeMetrics,
    newRestoreProcessCosts={rpcCalls:restoredTransportMetrics.runtime.rpcCalls-priorCosts.rpcCalls,
      computeSeconds:restoredTransportMetrics.runtime.computeSeconds-priorCosts.computeSeconds,
      peakMemoryBytes:restoredTransportMetrics.runtime.peakMemoryBytes};
  assert(newRestoreProcessCosts.rpcCalls>=0&&newRestoreProcessCosts.computeSeconds>=0);
  const report={...input,status:'passed',explicitCuts:2,restoredFromPosition:earlier.receipt.position,
    independentlyRetainedHead:later.receipt,acknowledgedModelRecords:1,
    completeHostCheckpointExact:true,completeNativeCheckpointExact:true,allConsumedAttemptsExact:true,
    runtimeCostsMonotonic:true,nextOutputExact:true,nextOutputDisposition:restoredNext.disposition,
    nextSelectionExact:restoredNext.disposition==='selected',nextSelectionAcknowledged:false,
    sourceValidated:true,projectionValidated:true,replayValidated:true,exactOriginalSourcePrefix:true,
    originalModelPayloadExact:true,hostDispatches:dispatches,completeSourceExecution:false,
    heldoutTested:false,generalizationEstablished:false,automaticTransitionDurability:false,
    automaticAcknowledgedBoundaryDurability:historyMode==='automatic',
    modelTrainingForThisRun:false,retainedDriverMetrics:restoredDriver.metrics(),
    originalTransportMetrics,restoredTransportMetrics,newRestoreProcessCosts,
    totalDiagnosticCosts:{rpcCalls:originalTransportMetrics.runtime.rpcCalls+newRestoreProcessCosts.rpcCalls,
      computeSeconds:originalTransportMetrics.runtime.computeSeconds+newRestoreProcessCosts.computeSeconds,
      peakMemoryBytes:Math.max(originalTransportMetrics.runtime.peakMemoryBytes,newRestoreProcessCosts.peakMemoryBytes)},
    costScope:'Both service lifetimes, including two unacknowledged next-output probes and actual native reconstruction; copied historical costs subtracted before adding new restore-process cost. Excludes earlier model training.',
    volatileSelectionFields,serviceCommands};
  save('report.json',report);
  console.log(JSON.stringify({status:report.status,producer:producer.revision,consumer:consumer.revision,
    acknowledgedModelRecords:1,explicitCuts:2,completeNativeCheckpointExact:true,nextOutputExact:true,
    nextOutputDisposition:restoredNext.disposition,
    hostDispatches:0,completeSourceExecution:false,output}));
}catch(error){
  const failure={...input,status:'failed',message:String(error.message),stack:error.stack,
    evidence:error.evidence??null,serviceCommands,services:services.map(service=>({status:service.status(),metrics:service.metrics()})),
    shutdowns:[]};
  for(const service of services){
    if(service.status().closed||service.status().pending){failure.shutdowns.push({graceful:false,status:service.status()});continue;}
    try{failure.shutdowns.push(await service.shutdown());}
    catch(shutdownError){failure.shutdowns.push({graceful:false,error:String(shutdownError.message)});}
  }
  save('failed-attempt.json',failure);
  throw error;
}finally{
  originalDriver?.close();restoredDriver?.close();
  for(const service of services)if(!service.status().closed)service.close();
}
