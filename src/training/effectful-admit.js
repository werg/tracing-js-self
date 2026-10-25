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

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const referenceWorker=fileURLToPath(new URL('../../tools/effectful-reference-worker.mjs',import.meta.url));
export function effectfulFamilySplit(family,{seed=17}={}){
  if(typeof family!=='string'||!family)throw new TypeError('A stable source/task family is required before expansion');
  const bucket=Number.parseInt(hash(seed+':'+family).slice(0,8),16)%100;
  return bucket<80?'train':bucket<90?'validation':'test';
}
export function independentEffectfulReference(input,{timeoutMs=5000,maxOutputBytes=4194304}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[referenceWorker],{stdio:['pipe','pipe','pipe'],shell:false});
    let stdout='',stderr='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);
      if(error){child.kill();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Independent source-reference deadline exceeded')),timeoutMs);
    child.once('error',finish);
    child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(Buffer.byteLength(stdout)>maxOutputBytes)
      finish(new RangeError('Independent reference output bound exceeded'));});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4096);});
    child.once('close',code=>{
      try{
        const result=JSON.parse(stdout);
        if(code!==0||result.error)throw new Error(result.error??stderr??'Independent reference failed');
        finish(null,result);
      }catch(error){finish(new Error('Independent source process '+code+': '+error.message+
        (stderr?' ('+stderr+')':'')));}
    });
    child.stdin.on('error',finish);
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
    if(types.has(event.operation)&&sites.operation.has(site))
      expectedOperations.push({site,value:row.result});
    if(event.operation==='control.branch'&&sites.branch.has(site))
      expectedBranches.push({site,decision:row.result});
  }
  if(!isDeepStrictEqual(expectedOperations,operations))
    throw new Error('Independent executed computation receipts disagree: '+JSON.stringify({expectedOperations,operations}));
  if(!isDeepStrictEqual(expectedBranches,decisions))
    throw new Error('Independent executed branch receipts disagree: '+JSON.stringify({expectedBranches,decisions}));
  return {schema:'effectful-source-checks/4',status:'agreed',
    computations:operations.length,branches:decisions.length};
}
export function requireNativeAdmission(exported,receipt,{consumerRevision=null,tokenizerIdentity=null}={}){
  const catalog=JSON.stringify(hostOperationContract(),null,2)+'\n';
  const contract=JSON.parse(readFileSync(new URL('../../contracts/semantic-harness-v4.json',import.meta.url),'utf8'));
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
    consumerRevision!==null&&receipt.consumerRevision!==consumerRevision||
    tokenizerIdentity!==null&&receipt.tokenizerIdentity!==tokenizerIdentity)
    throw new Error('Native admission receipt is incompatible, stale or incomplete');
  return true;
}
export async function verifyEffectfulTrainingCase({source,entry,args=[],fixture,
    family,license='repository-fixture',trustTier='repository-fixture',maxSteps=100000,
    timeoutMs=10000,nativeConsumer=null,seed=17,projectionOptions={},producerRevision=null,
    ancestorIds=[],taskId=null,fixtureFamily=null}={}){
  if(typeof family!=='string'||!family||typeof license!=='string'||!license||
    !['repository-fixture','trusted-owned-source'].includes(trustTier))
    throw new TypeError('Effectful admission requires source family, license and declared trusted source tier');
  fixture=canonicalFixturePlan(fixture);
  const broker=createFixtureBroker(fixture),abort=new AbortController();
  const timer=setTimeout(()=>{const error=new Error('Owned teacher deadline exceeded');
    broker.abort(error);abort.abort(error);},timeoutMs);
  let phase='teacher',bundle;
  try{
    const run=await executeWithNativeServices({entry:{text:source,functionName:entry,args},
      services:broker.services,maxSteps,signal:abort.signal});bundle=run.bundle;
    const effects=broker.finish();phase='projection';
    const compiled=compileEffectfulWitness(bundle,{sourceLineage:family,...projectionOptions});
    phase='reference';
    const input={source,entry,inputGraph:encodeNativeGraph(args),fixture};
    const reference=await independentEffectfulReference(input,{timeoutMs});
    const operationReference=await independentEffectfulReference({...input,mode:'operations'},{timeoutMs});
    const branchReference=await independentEffectfulReference({...input,mode:'branches'},{timeoutMs});
    for(const result of [reference,operationReference,branchReference]){
      if(!isDeepStrictEqual(result.outcome,compiled.outcome)||!isDeepStrictEqual(result.effects,effects))
        throw new Error('Independent Node source outcome, mutations, callback order or effects disagree');
    }
    const sourceChecks=independentSemanticChecks(bundle,source,operationReference.operations,
      branchReference.decisions);
    const exported=compiled.exported;
    Object.assign(exported.sidecar,{admission:'locally_verified',referenceStatus:'agreed',
      split:effectfulFamilySplit(family,{seed}),sourceLineage:family,
      sourceFamily:family,fixtureFamily:fixtureFamily??family,ancestorIds:[...new Set([family,...ancestorIds])],
      taskId:taskId??family,producerRevision,license,trustTier,
      capabilityProfile:compiled.exported.sidecar.compiler.capabilities,
      sourceProvenance:{family,license,trustTier,sourceDigest:hash(source),fixtureDigest:hash(fixture),seed},
      archive:bundle,projectionOptions:{sourceLineage:family,...projectionOptions},
      referenceInput:input,
      reference:{...reference,sourceChecks},effects,
      replay:verifyEffectfulProjection(bundle,exported,{sourceLineage:family,...projectionOptions}),
      catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
      evidenceKind:'deterministic-engineering',optimizerSteps:0});
    if(nativeConsumer){
      phase='native-consumer';
      const receipt=await nativeConsumer(exported);requireNativeAdmission(exported,receipt);
      exported.sidecar.nativeAdmission=receipt;
      exported.sidecar.selectionOrigin='certified_teacher';
      exported.sidecar.admission='admitted';
    }
    return {status:exported.sidecar.admission,exported};
  }catch(error){
    return {status:phase==='reference'?'reference_mismatch':phase==='native-consumer'?'native_rejected':
      error instanceof RangeError?'profile_limit':phase==='projection'?'projection_refused':'unsupported',
      phase,reason:String(error.message??error),family,archiveDigest:bundle?hash(bundle):null};
  }finally{clearTimeout(timer);broker.abort();}
}

export async function recheckEffectfulAdmission(exported,{requireAdmitted=true,timeoutMs=10000}={}){
  const side=exported?.sidecar;
  if(side?.collection?.schema==='semantic-teacher-session/4')
    return recheckEffectfulSession(exported,{requireAdmitted,timeoutMs});
  if(!side?.archive||!side.referenceInput||side.referenceStatus!=='agreed'||
    requireAdmitted&&(side.admission!=='admitted'||side.selectionOrigin!=='certified_teacher'))
    throw new Error('Missing complete independent effectful admission evidence');
  const projection=verifyEffectfulProjection(side.archive,exported,side.projectionOptions);
  const {sourceId,functionName,arguments:args}=side.archive.entrySpec;
  const source=side.archive.sources.find(s=>s.sourceId===sourceId)?.text;
  const inputGraph=encodeNativeGraph(realizeGraph(side.archive.initialState.heap,args));
  const input={source,entry:functionName,inputGraph,fixture:side.referenceInput.fixture};
  if(!isDeepStrictEqual(input,side.referenceInput)||hash(source)!==side.sourceProvenance?.sourceDigest||
    hash(input.fixture)!==side.sourceProvenance?.fixtureDigest)
    throw new Error('Source/reference inputs differ from the owned initial context');
  const references=[];
  for(const mode of [null,'operations','branches'])references.push(await independentEffectfulReference(
    mode?{...input,mode}:input,{timeoutMs}));
  for(const result of references)if(!isDeepStrictEqual(result.outcome,side.reference.outcome)||
      !isDeepStrictEqual(result.effects,side.effects))
    throw new Error('Independent effectful source evidence changed');
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
  if(requireAdmitted)requireNativeAdmission(exported,side.nativeAdmission);
  return {schema:'semantic-source-admission/4',episodeDigest:projection.publicDigest,
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
