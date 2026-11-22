#!/usr/bin/env node
// Actual-model terminal-history authority. The selected output is validated
// and acknowledged before source correspondence is checked offline.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {RegionSelectedModelDriver} from '../src/semantic/selected-execution-v8.js';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const copy=structuredClone,bytesSha=bytes=>createHash('sha256').update(bytes).digest('hex'),
  readJSON=path=>JSON.parse(readFileSync(path,'utf8')),
  saveJSON=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});

async function restoreTerminalChild(){
  const [packetPath,headPath,historyDirectory,streamId,policyPath,expectedPhase,resultPath]=process.argv.slice(3);
  assert(packetPath&&headPath&&historyDirectory&&streamId&&policyPath&&expectedPhase&&resultPath,
    'Invalid terminal restore child arguments');
  const oldCut=readJSON(packetPath),packet=oldCut.checkpoint,oldReceipt=oldCut.receipt,
    head=readJSON(headPath),policy=readJSON(policyPath),
    counters={initialize:0,restore:0,checkpoint:0,select:0,commit:0,cancel:0,
      reject:0,complete:0,close:0,serviceLookup:0};
  assert.equal(packet?.schema,'semantic-selected-driver-checkpoint/8');
  assert.equal(oldReceipt?.schema,'semantic-selected-history-receipt/8');
  assert.equal(oldReceipt.position,1,'Fresh recovery must start from the older initial cut');
  const trip=name=>async()=>{counters[name]++;throw new Error('Terminal disposition must not invoke '+name);};
  const select=async()=>{counters.select++;throw new Error('Terminal disposition must not sample a model');};
  Object.assign(select,{initialize:trip('initialize'),restore:trip('restore'),checkpoint:trip('checkpoint'),
    commit:trip('commit'),cancel:trip('cancel'),reject:trip('reject'),complete:trip('complete'),
    close:trip('close'),metrics:trip('checkpoint')});
  const services=new Proxy(Object.create(null),{get(_target,key){
    counters.serviceLookup++;throw new Error('Terminal disposition attempted host service '+String(key));
  }});
  const disposition=await RegionSelectedModelDriver.restoreLatest(packet,{select,policy,
    historyJournal:new DurableSelectedHistoryJournal({directory:historyDirectory,streamId}),
    historyReceipt:head,harnessOptions:{services}});
  assert.equal(disposition.schema,'semantic-selected-terminal-disposition/1');
  assert.equal(disposition.phase,expectedPhase);
  assert.deepEqual(disposition.historyReceipt,head);
  assert.deepEqual(counters,{initialize:0,restore:0,checkpoint:0,select:0,commit:0,cancel:0,
    reject:0,complete:0,close:0,serviceLookup:0});
  const publicDispatches=packet.bridge.public.timeline.filter(row=>row.kind==='dispatch').length;
  assert.equal(publicDispatches,0);
  const result={status:'passed',disposition,counters,olderPacketPosition:oldReceipt.position,
    nativeProcessStarts:0,
    nativeRestoreCalls:0,nativeSamplingCalls:0,hostServiceLookups:0,publicDispatches};
  saveJSON(resultPath,result);process.stdout.write(JSON.stringify(result)+'\n');
}

if(process.argv[2]==='--terminal-restore-child'){
  await restoreTerminalChild();
}else{
  const optionNames=['--megatoken','--python','--served','--source','--request','--out',
    '--seed','--max-tokens','--max-fragments'];
  const required=['--megatoken','--python','--served','--source','--request','--out'];
  const options=new Map();
  for(let index=2;index<process.argv.length;index+=2){
    const key=process.argv[index],value=process.argv[index+1];
    if(!optionNames.includes(key)||options.has(key)||!value||value.startsWith('--'))
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
    assert.equal(git(root,'status','--porcelain','--untracked-files=all'),'',
      'Exact clean checkout required: '+root);
    return {revision:git(root,'rev-parse','HEAD'),tree:git(root,'rev-parse','HEAD^{tree}')};
  };
  const producer=cleanIdentity(producerRoot),consumer=cleanIdentity(consumerRoot);
  for(const root of [producerRoot,consumerRoot]){
    const path=relative(root,output);
    assert(path==='..'||path.startsWith('..'+sep)||isAbsolute(path),
      'Evidence must be outside the frozen checkouts');
  }
  assert(!existsSync(output),'Evidence directory already exists');

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
  assert.equal(pythonRuntime.module,join(consumerRoot,'src/megatoken/__init__.py'),
    'Python imported another checkout');
  const firstGenerated=source.public?.timeline?.findIndex(row=>row.mode==='generated');
  assert(Number.isSafeInteger(firstGenerated)&&firstGenerated>0,
    'Original source needs a nonempty observed prefix and selected record');
  const initialPublic={...source.public,timeline:source.public.timeline.slice(0,firstGenerated)},
    invocationId=source.public.timeline[firstGenerated].fields.invocationId,
    initial=RegionExecutionHarness.replay(initialPublic,{requireTerminal:false}),
    producerRequest={session:initial.inner.sessionId,public:initial.exportEpisode(),contexts:[],
      context:initial.modelContext(invocationId)};
  assert.deepEqual(producerRequest,suppliedRequest,
    'The supplied request is not the producer-derived first request for this source prefix');

  mkdirSync(dirname(output),{recursive:true});mkdirSync(output);
  const topInput={schema:'semantic-model-terminal-history-run/1',producer,consumer,
    command:[process.execPath,...process.argv.slice(1)],node:process.version,pythonRuntime,
    sourceArtifactSha256:bytesSha(sourceBytes),selectionRequestSha256:bytesSha(requestBytes),
    modelSha256:modelSha,tokenizerSha256:tokenizerSha,
    manifestSha256:bytesSha(readFileSync(join(served,'manifest.json'))),
    trainingIdentity:manifest.semantic_v8_lineage_digest??null,seed,maxTokens,maxFragments,
    maximumNativeSessions:1,optimizationPerformed:false,
    scenarios:['closed-after-accepted','requested-head-ack-lost','cancel-rpc-transport-died'],
    scope:'Three bounded dedicated-session actual-model cases. Each accepts one original model record, then records terminal cancellation authority. A fresh process presents the initial older packet and independently retained newest head; terminal recovery must return before native calls or host dispatch. No complete-program or model-quality claim.'};
  saveJSON(join(output,'run-input.json'),topInput);
  saveJSON(join(output,'original-source.json'),source);
  saveJSON(join(output,'selection-request.json'),suppliedRequest);
  saveJSON(join(output,'serving-manifest.json'),manifest);

  function atomicHeadWrite(path,value){
    const temporary=path+'.next',file=openSync(temporary,'wx',0o600);
    try{writeFileSync(file,JSON.stringify(value)+'\n');fsyncSync(file);}finally{closeSync(file);}
    renameSync(temporary,path);const directory=openSync(dirname(path),'r');
    try{fsyncSync(directory);}finally{closeSync(directory);}
  }
  async function runScenario(name,{loseRequestedAck=false,killDuringCancel=false}={}){
    const directory=join(output,name);mkdirSync(directory);
    const save=(file,value)=>saveJSON(join(directory,file),value);
    const historyDirectory=join(directory,'history'),streamId='actual-terminal',
      journal=new DurableSelectedHistoryJournal({directory:historyDirectory,streamId}),
      headPath=join(directory,'independently-retained-head.json'),
      profilePath=join(directory,'native-service-profile.json'),
      serviceCommands=[],acknowledgementEvents=[],cancelEvents=[];
    let selector=null,driver=null,terminalCallError=null,terminalResult=null,
      selection=null,initialCut=null,acceptedCut=null,chain=[],head=null,beforeCancelMetrics=null;
    const context={schema:'semantic-model-terminal-scenario/1',name,producer,consumer,
      lostRequestedHeadAck:false,transportKilledDuringNativeCancel:false,
      positiveNativeCloseReceipt:false,modelRecordAcknowledged:false};
    save('scenario-input.json',{...context,loseRequestedAck,killDuringCancel,
      initialSelectionRequestSha256:bytesSha(requestBytes)});
    try{
      const harness=RegionExecutionHarness.replay(initialPublic,{requireTerminal:false});
      const args=['scripts/serve_semantic_v8.py','--served',served,'--device','cpu','--threads','1',
        '--effort','1','--max-tokens',String(maxTokens),'--max-fragments',String(maxFragments),
        '--max-sessions','1','--profile-output',profilePath];
      serviceCommands.push({name,command:[python,...args],cwd:consumerRoot});
      selector=createNativeV8ProcessSelector({command:python,args,cwd:consumerRoot,env,
        maxMessageBytes:64*1024*1024,timeoutMs:300000});
      const initialization={checkpointIdentity:modelSha,tokenizerIdentity:manifest.codec_fingerprint,
        trainingIdentity:manifest.semantic_v8_lineage_digest??null,seed};
      save('initialize-request.json',initialization);
      const nativeIdentity=await selector.initialize(initialization);save('initialize-response.json',nativeIdentity);
      const policy={checkpointIdentity:modelSha,tokenizerIdentity:manifest.codec_fingerprint,nativeIdentity,
        hostLimits:{maxGenerated:harness.inner.maxGenerated,maxOutstanding:harness.inner.maxOutstanding},
        automaticDelivery:harness.inner.automaticDelivery,maxSelections:8,maxOutstanding:4,maxStaleRetries:1};
      save('execution-policy.json',policy);
      const nativeCancel=selector.cancel;
      selector.cancel=async request=>{
        const event={session:request.session,reason:request.reason,requestDigest:hashAlgorithmData(request),
          rpcStarted:true};
        cancelEvents.push(event);
        if(killDuringCancel){
          const pending=nativeCancel.call(selector,request);
          event.transportPendingBeforeKill=selector.status().pending;
          selector.close();
          event.transportClosedBeforeReply=selector.status().closed;
          try{const response=await pending;event.response=copy(response);return response;}
          catch(error){event.failure=String(error.message);throw error;}
        }
        try{const response=await nativeCancel.call(selector,request);
          event.response=copy(response);return response;}
        catch(error){event.failure=String(error.message);throw error;}
      };
      driver=new RegionSelectedModelDriver({select:selector,harness,...policy});
      const acknowledge=async({receipt,previous})=>{
        const current=existsSync(headPath)?readJSON(headPath):null;
        assert.deepEqual(current,previous,'Independently retained application head changed');
        atomicHeadWrite(headPath,receipt);
        const event={position:receipt.position,previous:copy(previous),receipt:copy(receipt),
          durableHeadWritten:true,callbackAcknowledged:true};
        acknowledgementEvents.push(event);
        if(loseRequestedAck&&receipt.position===3){
          event.callbackAcknowledged=false;
          event.failure='Lost callback acknowledgement after durable requested marker';
          throw new Error(event.failure);
        }
        return readJSON(headPath);
      };
      initialCut=await driver.enableDurableHistory({journal,acknowledge});
      save('older-initial-cut.json',initialCut);
      assert.equal(initialCut.receipt.position,1);
      assert.deepEqual(driver.prefix(invocationId),suppliedRequest,
        'Live driver prefix differs from the producer-derived request');
      try{
        selection=await driver.select({...suppliedRequest});
        save('actual-model-selection.json',selection);
      }catch(error){
        const refusal={category:error.category??null,message:String(error.message),stack:error.stack,
          evidence:error.evidence??null,provenanceValidated:error.evidence?.provenanceValidated===true};
        save('actual-model-selection-refusal.json',refusal);
        throw error;
      }
      assert.equal(selection.selection?.modelSelected,true,'Original actual-model-selected provenance required');
      assert.equal(selection.selection?.origin,'actual-model-selected');
      assert.equal(selection.selection?.payloadHex,Buffer.from(selection.record,'utf8').toString('hex'));
      assert.equal(selection.selection?.fragments?.map(row=>row.payloadHex).join(''),selection.selection.payloadHex);
      const selectedResult=driver.harness.selected(invocationId,selection.record);
      await driver.onCommitted({invocationId,record:selection.record,
        selection:selection.selection,result:selectedResult});
      context.modelRecordAcknowledged=true;
      assert.equal(driver.attempts.length,1);
      assert.equal(driver.attempts[0].status,'accepted');
      assert.equal(driver.attempts[0].provenanceValidated,true);
      assert.equal(driver.attempts[0].commitReceipt?.committed,true);
      assert.equal(selector.metrics().attempts[0].status,'accepted');
      const acknowledgedEntries=await journal.readAll(readJSON(headPath));
      acceptedCut={checkpoint:acknowledgedEntries.at(-1).checkpoint,receipt:readJSON(headPath)};
      assert.equal(acceptedCut.receipt.position,2);
      assert.equal(acceptedCut.checkpoint.attempts[0].status,'accepted');
      assert.equal(acceptedCut.checkpoint.contexts.length,1);
      save('accepted-model-cut.json',acceptedCut);
      save('accepted-native-transport-metrics.json',selector.metrics());
      const reason='qualification terminal cancellation: '+name;
      beforeCancelMetrics=selector.metrics();
      save('transport-metrics-before-cancellation.json',beforeCancelMetrics);
      try{
        terminalResult=await driver.select.cancel({...driver.prefix(invocationId),reason});
      }catch(error){
        terminalCallError=error;
        save('terminal-cancellation-error.json',{message:String(error.message),stack:error.stack,
          evidence:error.evidence??null,terminalPersistenceError:error.terminalPersistenceError??null});
      }
      head=readJSON(headPath);chain=await journal.readAll(head);
      save('independently-retained-head-at-terminal.json',head);
      save('complete-acknowledged-history-chain.json',chain);
      save('terminal-cancel-rpc-events.json',cancelEvents);
      save('head-acknowledgement-events.json',acknowledgementEvents);
      const last=chain.at(-1),terminal=last.terminal;
      assert(terminal,'The independently trusted head must contain terminal authority');
      context.terminalPhase=terminal.phase;
      context.lostRequestedHeadAck=loseRequestedAck;
      context.transportKilledDuringNativeCancel=killDuringCancel;
      context.positiveNativeCloseReceipt=terminal.phase==='closed'&&terminal.closeReceipt?.closed===true;
      context.terminalId=terminal.terminalId;
      context.terminalHeadPosition=head.position;
      context.writerHeadPosition=driver.historyReceipt?.position??null;
      context.nativeCancelCalls=cancelEvents.length;
      context.terminalRuntimeMetrics=copy(terminal.snapshot.nativeMetrics);
      if(loseRequestedAck){
        assert.equal(chain.at(-2).terminal,undefined);
        assert.equal(chain.at(-2).checkpoint.attempts[0].status,'accepted');
        assert.equal(chain.at(-1).terminal.phase,'requested');
      }else{
        assert.equal(chain.at(-2)?.terminal?.phase,'requested');
        assert.equal(chain.at(-1)?.terminal?.phase,killDuringCancel?'unknown':'closed');
      }
    }catch(error){
      const failure={...context,status:'failed',message:String(error.message),stack:error.stack,
        evidence:error.evidence??null,terminalPersistenceError:error.terminalPersistenceError??null,
        head:existsSync(headPath)?readJSON(headPath):null,
        history:head?await journal.readAll(head).catch(readError=>({error:String(readError.message)})):null,
        selection,terminalResult,terminalCallError:terminalCallError&&String(terminalCallError.message),
        beforeCancelMetrics,
        attempts:driver?.attempts??null,metrics:selector?.metrics?.()??null,
        selectorStatus:selector?.status?.()??null,serviceCommands,acknowledgementEvents,cancelEvents};
      save('failed-attempt.json',failure);
      throw error;
    }finally{
      driver?.close();
      if(selector&&!selector.status().closed){
        try{save('native-service-shutdown.json',await selector.shutdown());}
        catch(error){save('native-service-shutdown-error.json',{message:String(error.message)});selector.close();}
      }
    }

    assert.equal(head.schema,'semantic-selected-history-receipt/8');
    const expectedPhase=loseRequestedAck?'requested':killDuringCancel?'unknown':'closed';
    assert.equal(chain.at(-1).terminal.phase,expectedPhase);
    if(loseRequestedAck){
      assert(terminalCallError,'A lost terminal head callback acknowledgement must reject locally');
      assert.equal(head.position,3);
      assert.equal(driver.historyReceipt.position,2,'The writer must keep its previous trusted head');
      assert.equal(cancelEvents.length,0,'Native cancel must not run after its authority callback is lost');
      assert.equal(chain.at(-1).terminal.snapshot.attempts[0].status,'accepted');
    }else if(killDuringCancel){
      assert.equal(cancelEvents.length,1);
      assert.equal(cancelEvents[0].transportPendingBeforeKill,1,
        'The actual cancel request must be pending when the process transport is terminated');
      assert.equal(cancelEvents[0].transportClosedBeforeReply,true);
      assert.equal(Object.hasOwn(chain.at(-1).terminal,'closeReceipt'),false);
      assert.equal(chain.at(-1).terminal.snapshot.attempts[0].status,'accepted');
    }else{
      assert.equal(terminalResult?.phase,'closed');
      assert.equal(chain.at(-1).terminal.closeReceipt?.closed,true);
      assert.equal(cancelEvents.length,1);
      assert.equal(driver.historyReceipt.position,head.position);
    }
    assert.equal(head.position,expectedPhase==='requested'?3:4);
    assert.equal(acceptedCut.checkpoint.attempts[0].status,'accepted');
    assert.equal(chain.at(-1).terminal.snapshot.attempts[0].status,'accepted',
      'The already acknowledged model outcome must remain accepted');
    assert.deepEqual(chain.at(-1).terminal.snapshot.contexts,acceptedCut.checkpoint.contexts);
    assert.deepEqual(chain.at(-1).terminal.snapshot.public,acceptedCut.checkpoint.bridge.public);
    assert.deepEqual(chain.at(-1).terminal.snapshot.nativeMetrics.attempts,
      acceptedCut.checkpoint.native.attempts,'Original native attempt evidence changed at cancellation');
    assert.deepEqual(chain.at(-1).terminal.snapshot.rejections,[]);
    const costAtAck=acceptedCut.checkpoint.native.runtimeMetrics,
      terminalCosts=chain.at(-1).terminal.snapshot.nativeMetrics.runtime,
      terminalCostDelta={rpcCalls:terminalCosts.rpcCalls-costAtAck.rpcCalls,
        computeSeconds:terminalCosts.computeSeconds-costAtAck.computeSeconds,
        peakMemoryBytes:terminalCosts.peakMemoryBytes};
    assert(terminalCostDelta.rpcCalls>=0&&terminalCostDelta.computeSeconds>=0);
    save('terminal-runtime-cost-delta.json',{costAtAcceptedCut:costAtAck,
      cumulativeTerminalSnapshot:terminalCosts,deltaFromAcceptedCut:terminalCostDelta,
      accounting:'Snapshot metrics are cumulative. Delta subtracts the accepted-cut cumulative RPC and compute costs; peak memory is a maximum, not additive.'});
    save('service-commands.json',serviceCommands);

    const freshHead=readJSON(headPath);
    assert.deepEqual(freshHead,head,'Fresh-process input must be the independently retained current head');
    const restoreResultPath=join(directory,'fresh-process-terminal-disposition.json'),
      child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--terminal-restore-child',
        join(directory,'older-initial-cut.json'),headPath,historyDirectory,streamId,
        join(directory,'execution-policy.json'),expectedPhase,restoreResultPath],
        {cwd:producerRoot,encoding:'utf8',timeout:300000,maxBuffer:4*1024*1024});
    save('fresh-process-terminal-gate-process.json',{status:child.status,signal:child.signal??null,
      error:child.error?String(child.error.message):null,stdout:child.stdout,stderr:child.stderr,
      command:[process.execPath,fileURLToPath(import.meta.url),'--terminal-restore-child',
        join(directory,'older-initial-cut.json'),headPath,historyDirectory,streamId,
        join(directory,'execution-policy.json'),expectedPhase,restoreResultPath]});
    assert.equal(child.status,0,child.stderr||child.stdout);
    const freshResult=readJSON(restoreResultPath);
    assert.equal(freshResult.disposition.phase,expectedPhase);
    assert.equal(freshResult.nativeRestoreCalls,0);
    assert.equal(freshResult.nativeSamplingCalls,0);
    assert.equal(freshResult.hostServiceLookups,0);

    // The private source oracle runs only after the actual public/native rollout.
    const checked=await recheckRegionEvidence(source,{requireNative:false});
    for(const key of ['valid','sourceValidated','projectionValidated','replayValidated'])
      assert.equal(checked[key],true,key);
    const expectedPublic={...source.public,timeline:source.public.timeline.slice(0,firstGenerated+1)};
    assert.deepEqual(acceptedCut.checkpoint.bridge.public,expectedPublic,
      'Actual accepted public prefix differs from the original source execution');
    assert.deepEqual(acceptedCut.checkpoint.contexts,source.contexts.slice(0,1));
    assert.equal(selection.record,source.public.timeline[firstGenerated].fields.line);
    assert.equal(acceptedCut.checkpoint.bridge.public.timeline.filter(row=>row.kind==='dispatch').length,0);
    save('post-rollout-source-recheck.json',{valid:checked.valid,sourceValidated:checked.sourceValidated,
      projectionValidated:checked.projectionValidated,replayValidated:checked.replayValidated,
      actualPublicMatchesSourcePrefix:true,actualContextMatchesSource:true,
      actualRecordMatchesOriginalSourceAfterRollout:true,hostDispatches:0});
    const profile=existsSync(profilePath)?readJSON(profilePath):null;
    if(profile!==null)save('native-service-profile-copy.json',profile);
    const afterMetrics=selector.metrics();
    save('transport-metrics-after-terminal.json',afterMetrics);
    const summary={...context,status:'passed',expectedPhase,headPosition:head.position,
      oldPacketPosition:initialCut.receipt.position,acceptedCutPosition:acceptedCut.receipt.position,
      freshProcessUsedOlderPacket:true,independentHeadRead:true,typedDispositionBeforeNative:true,
      nativeRestoreCalls:0,nativeSamplingCalls:0,hostServiceLookups:0,hostDispatches:0,
      oneActualModelRecordAccepted:true,actualRecordBytes:selection.record,
      actualRecordUtf8Hex:Buffer.from(selection.record,'utf8').toString('hex'),
      actualSelection:selection,acceptedAttempt:acceptedCut.checkpoint.attempts[0],
      acceptedNativeAttempt:acceptedCut.checkpoint.native.attempts[0],
      terminalSnapshot:chain.at(-1).terminal.snapshot,
      terminalEvent:chain.at(-1).terminal,terminalRuntimeCostDelta:terminalCostDelta,
      transportMetricsBeforeCancellation:beforeCancelMetrics,transportMetricsAfterTerminal:afterMetrics,
      serviceProfileAvailable:profile!==null,serviceProfilePath:profile!==null?'native-service-profile-copy.json':null,
      sourceValidated:true,projectionValidated:true,replayValidated:true,
      heldoutTested:false,generalizationEstablished:false,completeSourceExecution:false,
      modelTrainingForThisRun:false,
      costScope:'This scenario has one native service lifetime, one actual accepted selection, one acknowledged terminal event, and a fresh process with zero native calls. Metric snapshots are cumulative; only the saved accepted-cut-to-terminal delta represents later cost. This report does not add the cumulative snapshots together.'};
    save('scenario-report.json',summary);
    return {name,phase:expectedPhase,report:summary};
  }

  async function retainScenarioFailure(name,error){
    const directory=join(output,name),path=join(directory,'qualification-postcondition-failure.json');
    if(existsSync(directory)&&!existsSync(path)){
      saveJSON(path,{status:'failed',name,message:String(error.message),stack:error.stack,
        evidence:error.evidence??null,terminalPersistenceError:error.terminalPersistenceError??null,
        producer,consumer,command:[process.execPath,...process.argv.slice(1)]});
    }
  }
  const scenarios=[];
  for(const [name,settings]of [['closed-after-accepted',{}],
    ['requested-head-ack-lost',{loseRequestedAck:true}],
    ['cancel-rpc-transport-died',{killDuringCancel:true}]]){
    try{scenarios.push(await runScenario(name,settings));}
    catch(error){await retainScenarioFailure(name,error);throw error;}
  }
  const report={...topInput,status:'passed',scenarioCount:scenarios.length,
    actualAcceptedRecords:scenarios.filter(row=>row.report.oneActualModelRecordAccepted).length,
    phases:Object.fromEntries(scenarios.map(row=>[row.name,row.phase])),
    oldPacketTerminalGatePassed:scenarios.every(row=>row.report.freshProcessUsedOlderPacket&&
      row.report.nativeRestoreCalls===0&&row.report.nativeSamplingCalls===0&&row.report.hostDispatches===0),
    lostRequestedAckDidNotCancel:scenarios[1].report.nativeCancelCalls===0&&
      scenarios[1].report.writerHeadPosition===2,
    transportDeathHasUnknownDisposition:scenarios[2].phase==='unknown'&&
      scenarios[2].report.terminalEvent.closeReceipt===undefined,
    sourceValidated:true,projectionValidated:true,replayValidated:true,
    heldoutTested:false,generalizationEstablished:false,completeSourceExecution:false,
    modelTrainingForThisRun:false,scenarios:scenarios.map(row=>row.report)};
  saveJSON(join(output,'report.json'),report);
  assert.deepEqual(report.phases,{'closed-after-accepted':'closed',
    'requested-head-ack-lost':'requested','cancel-rpc-transport-died':'unknown'});
  assert.equal(report.lostRequestedAckDidNotCancel,true);
  assert.equal(report.transportDeathHasUnknownDisposition,true);
  process.stdout.write(JSON.stringify({status:report.status,producer:producer.revision,
    consumer:consumer.revision,scenarios:report.phases,oldPacketTerminalGatePassed:true,
    nativeRestoreCalls:0,nativeSamplingCalls:0,hostDispatches:0,output})+'\n');
}
