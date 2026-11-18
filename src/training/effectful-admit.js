// Production teacher/corpus gate. Each authority has a separate receipt:
// private journal/replay, selected public replay, independent native source
// execution and production native tokenizer/consumer. No optimizer runs here.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {executeWithNativeServices} from '../host/native-driver.js';
import {hostOperationContract} from '../host/operations.js';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {decodeHostPayload} from '../host/materialize.js';
import {hostOperation} from '../host/operations.js';
import {realizeGraph} from './graph.js';
import {createFixtureBroker,canonicalFixturePlan} from './fixture-broker.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from './effectful-compiler.js';
import {normalizeJournal} from '../semantic/normalize.js';
import {decodeWitness} from './format.js';
import {recheckEffectfulSession} from './effectful-session.js';
import {effectfulFamilySplit,defaultSplitIdentity,validateSplitIdentity,cloneSplitIdentity,normalizeSeeds,
  admissionEnvironment,bindAdmissionIdentity,verifyAdmissionIdentity,identityDigest} from './admission-identity.js';
export {effectfulFamilySplit} from './admission-identity.js';
import {AdmissionFailure,createFailureRecord} from './failure-record.js';
import {referenceCommand,referenceIsolationMode} from '../corpus/reference-isolation.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const referenceWorker=fileURLToPath(new URL('../../tools/effectful-reference-worker.mjs',import.meta.url));
export function independentEffectfulReference(input,{timeoutMs=5000,maxOutputBytes=4194304,
    isolation=referenceIsolationMode()}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1)
    throw new TypeError('Reference deadline and output bound must be positive safe integers');
  return new Promise((resolve,reject)=>{
    let command;
    try{command=referenceCommand(referenceWorker,{timeoutMs,isolation});}
    catch(error){reject(new AdmissionFailure('reference_isolation_failure',error.message));return;}
    const child=spawn(command.command,command.args,{stdio:['pipe','pipe','pipe'],shell:false,
      env:command.env});
    const chunks=[];let outputBytes=0,stderr='',done=false;
    const fail=(category,message,details=null)=>new AdmissionFailure(category,message,details);
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);
      if(error){
        // Keep the generation worker's process group so campaign cancellation
        // reaches the complete tree. unshare --kill-child also reaps the isolated
        // PID-namespace init when this direct child is killed on a deadline.
        child.kill('SIGKILL');
        command.cleanup();reject(error);
      }else{command.cleanup();resolve(value);}};
    const timer=setTimeout(()=>finish(fail('reference_timeout','Independent source-reference deadline exceeded',
      {timeoutMs,mode:input.mode??'original'})),timeoutMs);
    child.once('error',error=>finish(fail('reference_process_failure','Independent source process failed to start',
      {code:error.code??null,message:error.message})));
    child.stdout.on('data',bytes=>{outputBytes+=bytes.length;
      if(outputBytes>maxOutputBytes)finish(fail('reference_output_limit','Independent reference output bound exceeded',
        {maxOutputBytes,mode:input.mode??'original'}));
      else chunks.push(bytes);});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4096);});
    child.once('close',code=>{
      if(done)return;
      const stdout=Buffer.concat(chunks).toString('utf8');
      try{
        const result=JSON.parse(stdout);
        if(code!==0||result.error){
          const category=result.failure?.category??'reference_process_failure';
          finish(fail(category,String(result.error??stderr??'Independent reference failed'),
            {code,stderr,mode:input.mode??'original',failure:result.failure??null}));return;
        }
        if(result.schema!=='effectful-reference/4'||!['return','throw'].includes(result.outcome?.kind)||
          !Array.isArray(result.effects)||!Array.isArray(result.callbackFailures))
          throw new Error('Incomplete independent reference response');
        finish(null,result);
      }catch(error){
        const setupFailed=isolation==='linux-namespace'&&(code===126||/^(?:unshare:|mount:|Reference isolation setup failed)/m.test(stderr));
        const resourceFailed=isolation==='linux-namespace'&&([137,152].includes(code)||/out of memory|heap limit/i.test(stderr));
        finish(fail(setupFailed?'reference_isolation_failure':resourceFailed?'reference_resource_limit':'reference_process_failure',
        'Independent source process '+code+': '+error.message,
        {code,stderr,stdout:stdout.slice(0,8192),mode:input.mode??'original'}));}
    });
    child.stdin.on('error',error=>finish(fail('reference_process_failure','Independent reference input failed',
      {code:error.code??null,message:error.message})));
    child.stdin.end(JSON.stringify({...input,timeoutMs}));
  });
}
function staticSites(source){
  const operation=new Set(),branch=new Set();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child);return;}
    if(['BinaryExpression','UnaryExpression','UpdateExpression','TemplateLiteral'].includes(node.type)||
      node.type==='AssignmentExpression'&&node.operator!=='=')operation.add(node.start+':'+node.end);
    if(['IfStatement','WhileStatement','DoWhileStatement','ForStatement','ConditionalExpression'].includes(node.type)&&node.test)
      branch.add(node.test.start+':'+node.test.end);
    if(node.type==='LogicalExpression')branch.add(node.start+':'+node.end);
    for(const [key,value] of Object.entries(node))if(!['start','end','loc'].includes(key))visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));return {operation,branch};
}
function independentSemanticChecks(bundle,source,operations,decisions){
  const sites=staticSites(source),semantic=normalizeJournal(bundle);
  const events=new Map(bundle.events.map(event=>[event.eventId,event]));
  const types=new Set(['primitive.binary','primitive.unary','template.substitute',
    'spec.operation.complete','binding.update','property.update']);
  const expectedOperations=[],expectedBranches=[];
  for(const row of semantic.events){
    const event=events.get(row.journalEvent),site=row.source?row.source.start+':'+row.source.end:null;
    if(types.has(event.operation)&&sites.operation.has(site)&&event.completion?.type!=='throw')
      expectedOperations.push({site,value:row.result});
    if(event.operation==='control.branch'&&sites.branch.has(site)&&event.completion?.type!=='throw')
      expectedBranches.push({site,decision:row.result});
  }
  if(!isDeepStrictEqual(expectedOperations,operations))
    throw new AdmissionFailure('reference_operation_mismatch','Independent executed computation receipts disagree',
      {expectedOperations,operations});
  if(!isDeepStrictEqual(expectedBranches,decisions))
    throw new AdmissionFailure('reference_branch_mismatch','Independent executed branch receipts disagree',
      {expectedBranches,decisions});
  return {schema:'effectful-source-checks/4',status:'agreed',
    computations:operations.length,branches:decisions.length};
}
export function validateNativePolicy(policy){
  if(!policy||!/^[0-9a-f]{40}$/.test(policy.consumerRevision??'')||
    typeof policy.tokenizerIdentity!=='string'||!policy.tokenizerIdentity||
    !/^[0-9a-f]{64}$/.test(policy.tokenizerSha256??''))
    throw new TypeError('Native admission policy is incompatible or incomplete: exact consumer revision, tokenizer identity and SHA-256 are required');
  return {consumerRevision:policy.consumerRevision,tokenizerIdentity:policy.tokenizerIdentity,
    tokenizerSha256:policy.tokenizerSha256};
}
export function validateNativeProducer(producerRevision){
  if(!/^[0-9a-f]{40}$/.test(producerRevision??''))
    throw new TypeError('Native admission requires an exact pinned producer revision');
  return producerRevision;
}
export function requireNativeAdmission(exported,receipt,policy=null){
  const expected=validateNativePolicy(policy??exported?.sidecar?.nativePolicy);
  validateNativeProducer(exported?.sidecar?.producerRevision);
  if(!isDeepStrictEqual(expected,exported?.sidecar?.nativePolicy))
    throw new Error('Native admission policy differs from the immutable candidate identity');
  verifyAdmissionIdentity(exported);
  const catalog=JSON.stringify(hostOperationContract(),null,2)+'\n';
  const contract=JSON.parse(readFileSync(new URL('../../contracts/semantic-harness-v5.json',import.meta.url),'utf8'));
  if(receipt?.schema!=='semantic-native-admission/4'||receipt.componentGate!=='native-consumer-only'||
    receipt.admitted!==true||receipt.episodeDigest!==hash(exported.public)||
    receipt.contractDigest!==hash(catalog)||!receipt.lossMaskValidated||!receipt.visibilityValidated||
    receipt.schemaDigest!==contract.digest||receipt.fixtureDigest!==contract.fixtureDigest||
    !receipt.fragmentationValidated||receipt.optimizerSteps!==0||
    !/^[0-9a-f]{40}$/.test(receipt.consumerRevision??'')||
    !/^[0-9a-f]{64}$/.test(receipt.tokenizerSha256??'')||
    typeof receipt.tokenizerIdentity!=='string'||!receipt.tokenizerIdentity||
    !Number.isSafeInteger(receipt.generatedTokens)||receipt.generatedTokens<1||
    !Number.isSafeInteger(receipt.observedTokens)||receipt.observedTokens<1||
    receipt.consumerRevision!==expected.consumerRevision||
    receipt.tokenizerIdentity!==expected.tokenizerIdentity||receipt.tokenizerSha256!==expected.tokenizerSha256)
    throw new Error('Native admission receipt is incompatible, stale or incomplete');
  return true;
}
export function bindNativeAdmission(exported,receipt,policy=null){
  requireNativeAdmission(exported,receipt,policy);
  exported.sidecar.nativeAdmission=structuredClone(receipt);
  exported.sidecar.nativeBinding={schema:'semantic-native-receipt-binding/1',
    episodeDigest:hash(exported.public),identityDigest:exported.sidecar.identityDigest,
    receiptDigest:identityDigest(receipt),policyDigest:identityDigest(exported.sidecar.nativePolicy)};
  exported.sidecar.selectionOrigin='certified_teacher';
  exported.sidecar.admission='admitted';
  return exported.sidecar.nativeBinding;
}
export function verifyNativeBinding(exported,policy=null){
  const side=exported.sidecar;
  requireNativeAdmission(exported,side.nativeAdmission,policy);
  if(!isDeepStrictEqual(side.nativeBinding,{schema:'semantic-native-receipt-binding/1',
    episodeDigest:hash(exported.public),identityDigest:side.identityDigest,
    receiptDigest:identityDigest(side.nativeAdmission),policyDigest:identityDigest(side.nativePolicy)}))
    throw new Error('Native receipt does not bind the immutable candidate identity');
  return true;
}
export async function verifyEffectfulTrainingCase({source,entry,args=[],fixture,
    family,license='repository-fixture',trustTier='repository-fixture',maxSteps=100000,
    timeoutMs=10000,nativeConsumer=null,seed=17,projectionOptions={},producerRevision=null,
    ancestorIds=[],taskId=null,fixtureFamily=null,provenance={},seeds={},splitIdentity=null,nativePolicy=null,randomSeed=seeds.guestRng??null}={}){
  if(typeof source!=='string'||typeof entry!=='string'||!entry||
    typeof family!=='string'||!family||typeof license!=='string'||!license||
    !['repository-fixture','trusted-owned-source'].includes(trustTier))
    throw new TypeError('Effectful admission requires source family, license and declared trusted source tier');
  if(randomSeed!==null&&(!Number.isInteger(randomSeed)||randomSeed<0||randomSeed>0xffffffff))
    throw new TypeError('The guest RNG fixture seed must be a uint32 or null');
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)
    throw new TypeError('Teacher step and deadline limits must be positive safe integers');
  normalizeSeeds(seeds,seed,randomSeed);
  if(nativeConsumer||nativePolicy!==null)nativePolicy=validateNativePolicy(nativePolicy);
  if(nativeConsumer)validateNativeProducer(producerRevision);
  splitIdentity=cloneSplitIdentity(splitIdentity??defaultSplitIdentity(family,{seed}));
  validateSplitIdentity(splitIdentity,{family,seed});
  fixture=canonicalFixturePlan(fixture);
  const broker=createFixtureBroker(fixture),abort=new AbortController();
  const timer=setTimeout(()=>{const error=new Error('Owned teacher deadline exceeded');
    broker.abort(error);abort.abort(error);},timeoutMs);
  let phase='teacher',bundle;const observations={};
  const candidate={source,entry,args,fixture,family,license,trustTier,maxSteps,timeoutMs,seed,
    projectionOptions,producerRevision,ancestorIds,taskId,fixtureFamily,provenance,seeds,splitIdentity,nativePolicy,randomSeed};
  try{
    const run=await executeWithNativeServices({entry:{text:source,functionName:entry,args},
      services:broker.services,maxSteps,randomSeed,signal:abort.signal});bundle=run.bundle;
    const effects=broker.finish();phase='projection';
    const compiled=compileEffectfulWitness(bundle,{sourceLineage:family,...projectionOptions});
    observations.owned={outcome:compiled.outcome,effects};
    phase='reference';
    const input={source,entry,inputGraph:encodeNativeGraph(args),fixture,randomSeed};
    const reference=observations.original=await independentEffectfulReference(input,{timeoutMs});
    const operationReference=observations.operations=await independentEffectfulReference({...input,mode:'operations'},{timeoutMs});
    const branchReference=observations.branches=await independentEffectfulReference({...input,mode:'branches'},{timeoutMs});
    for(const result of [reference,operationReference,branchReference]){
      if(result.callbackFailures.length)throw new AdmissionFailure('reference_callback_failure',
        'Callback failures are outside the qualified observable completion profile',result.callbackFailures);
      if(result.unhandledRejections?.length)throw new AdmissionFailure('reference_unhandled_rejection',
        'Unhandled rejections are outside the qualified observable completion profile',result.unhandledRejections);
      if(!isDeepStrictEqual(result.outcome,compiled.outcome)||!isDeepStrictEqual(result.effects,effects))
        throw new AdmissionFailure('reference_outcome_mismatch',
          'Independent Node source outcome, mutations, callback order or effects disagree',
          {expected:observations.owned,actual:{outcome:result.outcome,effects:result.effects}});
    }
    const sourceChecks=independentSemanticChecks(bundle,source,operationReference.operations,
      branchReference.decisions);
    const exported=compiled.exported;
    Object.assign(exported.sidecar,{admission:'locally_verified',referenceStatus:'agreed',
      split:splitIdentity.split,splitIdentity,sourceLineage:family,
      sourceFamily:family,fixtureFamily:fixtureFamily??family,ancestorIds:[...new Set([family,...ancestorIds])],
      taskId:taskId??family,producerRevision,license,trustTier,nativePolicy,
      capabilityProfile:compiled.exported.sidecar.compiler.capabilities,
      sourceProvenance:{family,license,trustTier,sourceDigest:hash(source),fixtureDigest:hash(fixture),seed,
        upstream:structuredClone(provenance)},
      executionLimits:{maxSteps,timeoutMs,maxGenerated:projectionOptions.maxGenerated??16384,
        maxOperators:projectionOptions.maxOperators??8},
      seeds:normalizeSeeds(seeds,seed,bundle.initialState.control.a0.randomSeed??null),
      environment:admissionEnvironment(),
      archive:bundle,projectionOptions:{sourceLineage:family,...projectionOptions},
      referenceInput:input,
      reference:{...reference,sourceChecks},effects,
      replay:verifyEffectfulProjection(bundle,exported,{sourceLineage:family,...projectionOptions}),
      catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
      evidenceKind:'deterministic-engineering',optimizerSteps:0});
    bindAdmissionIdentity(exported);
    if(nativeConsumer){
      phase='native-consumer';
      const receipt=await nativeConsumer(exported);bindNativeAdmission(exported,receipt,nativePolicy);
    }
    return {status:exported.sidecar.admission,exported};
  }catch(error){
    const failure=createFailureRecord({candidate,error,phase,archive:bundle??null,observations});
    return {status:failure.original.status,category:failure.original.category,
      phase,reason:failure.original.reason,family,archiveDigest:failure.original.archiveDigest,failure};
  }finally{clearTimeout(timer);broker.abort();}
}

export async function recheckEffectfulAdmission(exported,{requireAdmitted=true,timeoutMs=10000,expectedIdentityDigest=null,nativePolicy=null}={}){
  const side=exported?.sidecar;
  if(side?.collection?.schema==='semantic-teacher-session/4')
    return recheckEffectfulSession(exported,{requireAdmitted,timeoutMs,expectedIdentityDigest,nativePolicy});
  if(!side?.archive||!side.referenceInput||side.referenceStatus!=='agreed'||
    requireAdmitted&&(side.admission!=='admitted'||side.selectionOrigin!=='certified_teacher'))
    throw new Error('Missing complete independent effectful admission evidence');
  const projection=verifyEffectfulProjection(side.archive,exported,side.projectionOptions);
  const {sourceId,functionName,arguments:args}=side.archive.entrySpec;
  const source=side.archive.sources.find(s=>s.sourceId===sourceId)?.text;
  const inputGraph=encodeNativeGraph(realizeGraph(side.archive.initialState.heap,args));
  const input={source,entry:functionName,inputGraph,fixture:side.referenceInput.fixture,
    randomSeed:side.archive.initialState.control.a0.randomSeed??null};
  if(!isDeepStrictEqual(input,side.referenceInput)||hash(source)!==side.sourceProvenance?.sourceDigest||
    hash(input.fixture)!==side.sourceProvenance?.fixtureDigest)
    throw new Error('Source/reference inputs differ from the owned initial context');
  verifyAdmissionIdentity(exported,{expectedIdentityDigest});
  const references=[];
  for(const mode of [null,'operations','branches'])references.push(await independentEffectfulReference(
    mode?{...input,mode}:input,{timeoutMs}));
  for(const result of references){
    if(result.callbackFailures.length)throw new AdmissionFailure('reference_callback_failure',
      'Callback failures are outside the qualified observable completion profile',result.callbackFailures);
    if(result.unhandledRejections?.length)throw new AdmissionFailure('reference_unhandled_rejection',
      'Unhandled rejections are outside the qualified observable completion profile',result.unhandledRejections);
    if(!isDeepStrictEqual(result.outcome,side.reference.outcome)||
      !isDeepStrictEqual(result.effects,side.effects)||
      !isDeepStrictEqual(result.callbackFailures,side.reference.callbackFailures)||
      !isDeepStrictEqual(result.unhandledRejections??[],side.reference.unhandledRejections??[]))
      throw new Error('Independent effectful source evidence changed');
  }
  const sourceChecks=independentSemanticChecks(side.archive,source,references[1].operations,references[2].decisions);
  if(!isDeepStrictEqual(sourceChecks,side.reference.sourceChecks))throw new Error('Source computation evidence changed');
  const dispatches=side.archive.events.filter(event=>event.operation==='effect.dispatch');
  const recorded=side.effects.filter(receipt=>receipt.kind==='dispatch');
  if(dispatches.length!==recorded.length)throw new Error('Native effect count differs from owned dispatch journal');
  for(const [index,event] of dispatches.entries()){
    const id=event.causes.find(cause=>cause.kind==='effect')?.effectId;
    const effect=side.archive.finalState.effects[id],spec=hostOperation(effect.operation);
    const actual=decodeHostPayload(effect.request.payload,spec.codec,spec).map((arg,slot)=>
      spec.callbackIndices.includes(slot)?{callback:true}:arg);
    if(effect.operation!==recorded[index].operation||!isDeepStrictEqual(encodeNativeGraph(actual),recorded[index].arguments))
      throw new Error('Native evaluated argument receipt differs from owned request');
    const input=side.archive.finalState.inputs[effect.inputIds[0]];
    const outcome=side.effects.find(receipt=>receipt.kind==='settlement'&&receipt.call===index);
    if(!input||!outcome||outcome.status!==(input.abrupt?'rejected':'fulfilled')||
      !isDeepStrictEqual(input.graph??encodeNativeGraph(realizeGraph(side.archive.finalState.heap,[input.value])),outcome.result))
      throw new Error('Native settlement receipt differs from owned delivery');
  }
  if(requireAdmitted)verifyNativeBinding(exported,nativePolicy);
  return {schema:'semantic-source-admission/4',episodeDigest:projection.publicDigest,
    identityDigest:side.identityDigest,identityValidated:true,
    producerRevision:side.producerRevision,catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
    referenceStatus:'agreed',journalValidated:true,replayValidated:true,sourceValidated:true,
    effectsValidated:true,optimizerSteps:0};
}

/** Counterfactual schedules share exactly the bytes visible before the first
+ * changed external observation. No fixture future can shape an earlier prefix. */
export function checkCounterfactualPrefixes(left,right){
  const a=left.public.timeline,b=right.public.timeline;
  let index=0;
  while(index<Math.min(a.length,b.length)&&isDeepStrictEqual(a[index],b[index]))index++;
  if(index===Math.min(a.length,b.length))throw new Error('Counterfactuals must differ in an observed outcome');
  if(a[index].mode!=='observed'||b[index].mode!=='observed'||
    !['result','event'].includes(a[index].kind)||a[index].kind!==b[index].kind)
    throw new Error('Counterfactual future leaked into an earlier source/action prefix');
  return {valid:true,identicalRecords:index,firstChangedObservation:index+1};
}
export function effectfulMetrics(exported){
  const timeline=exported.public.timeline;
  let generatedBytes=0,observedBytes=0,transportBytes=0,actions=0;
  for(const item of timeline){
    const bytes=Buffer.byteLength(JSON.stringify(item)),semantic=item.line?Buffer.byteLength(item.line):0;
    if(item.mode==='generated'){generatedBytes+=semantic;if(decodeWitness(item.line).kind==='request')actions++;}
    else observedBytes+=bytes;
    if(item.mode==='generated')transportBytes+=bytes-semantic;
  }
  return {generatedBytes,observedBytes,transportBytes,actions,
    generatedTokens:exported.sidecar.nativeAdmission?.generatedTokens??null,
    observedTokens:exported.sidecar.nativeAdmission?.observedTokens??null,
    learnedSuccess:null,optimizerSteps:0};
}
