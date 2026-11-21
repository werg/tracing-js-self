// Bounded source-to-native child execution. Source authority is established by
// the independent source checker; lifecycle receipts never substitute for it.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {recheckRegionEvidence} from './compiler-v8.js';
import {RegionExecutionHarness} from './region-harness.js';
import {commitCausalLmV8Selection} from './causal-lm-v8.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/,preparedCases=new WeakMap();
const demand=(condition,message)=>{if(!condition)throw new TypeError('V8 child bridge: '+message);};
const bounded=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const clean=value=>JSON.parse(JSON.stringify(value));
const failure=error=>({category:error.category??error.name,message:String(error.message),
  evidence:copy(error.evidence??null),acknowledgementUnknown:error.acknowledgementUnknown===true});

/** This is an actual independent recheck, not recognition of a claimed receipt.
 * Private expected records remain in a module-owned scoring table, never in a
 * coordinator or child request. The initial profile deliberately has one pure
 * root without prior realm state; native lifecycle keeps its typed multi-child
 * representation and preserves the original declared realm policy. */
export async function prepareV8OrchestrationCase({id,artifact}={}){
  demand(typeof id==='string'&&id.length>0&&id.length<=256,'case identity required');
  artifact=copy(artifact);const checked=await recheckRegionEvidence(artifact);
  demand(checked.valid===true&&checked.sourceValidated===true&&checked.replayValidated===true,
    'independent original source/input recheck failed');
  const rows=artifact.public.timeline,first=rows.findIndex(row=>row.mode==='generated'),
    programs=rows.filter(row=>row.kind==='program'),roots=rows.filter(row=>row.kind==='invocation');
  demand(first>=2&&programs.length===1&&roots.length===1&&rows.slice(0,first).every(row=>
    row.mode==='observed'&&['program','invocation'].includes(row.kind))&&
    rows.slice(first).every(row=>row.mode==='generated'),
    'profile requires one original pure root; host observations and dynamic child admission remain unsupported');
  const root=roots[0].fields;
  demand(root.activation==='call'&&root.parentInvocationId===null&&root.closureId===null&&
    ['fresh','retained'].includes(root.realmPolicy)&&root.taskRevision===1&&programs[0].fields.module===false,
    'profile requires an unchanged initial root call and non-module source');
  const initialPublic={...copy(artifact.public),timeline:copy(rows.slice(0,first))};
  RegionExecutionHarness.replay(initialPublic,{requireTerminal:false});
  const sourceCheck=clean(checked),body={schema:'semantic-orchestration-case/8',id,initialPublic,
    artifactDigest:hashAlgorithmData(artifact),sourceCheckDigest:hashAlgorithmData(sourceCheck),
    sourceInputValidated:true,nativeAdmissionClaim:false,sourceAdmissionClaim:false,
    profile:'single-pure-root-native-child/1'};
  const prepared=freeze({...body,digest:hashAlgorithmData(body)});
  preparedCases.set(prepared,{artifact,sourceCheck});return prepared;
}

function checkedCase(prepared){
  const saved=preparedCases.get(prepared);demand(saved,'prepare the original artifact through an independent source recheck');
  return saved;
}
function validatePolicy(policy){
  demand(policy&&['model','engineering'].includes(policy.origin)&&
    HASH.test(policy.checkpointIdentity??'')&&HASH.test(policy.tokenizerIdentity??'')&&
    (policy.trainingIdentity===null||HASH.test(policy.trainingIdentity))&&[17,29,43].includes(policy.seed)&&
    bounded(policy.maxCoordinatorSelections,10000)&&bounded(policy.maxChildSelections,100000)&&
    bounded(policy.childBudget,100000)&&policy.maxActive===1&&policy.generationSettings&&
    typeof policy.generationSettings==='object'&&!Array.isArray(policy.generationSettings),
    'frozen model identities, generation settings and bounded policy required');
}
function replayGuest(publicData,contexts,initial){
  demand(isDeepStrictEqual({...publicData,timeline:[]},{...initial,timeline:[]})&&
    isDeepStrictEqual(publicData.timeline.slice(0,initial.timeline.length),initial.timeline)&&
    publicData.timeline.slice(initial.timeline.length).every(row=>row.mode==='generated'),
    'guest history changed source/input or introduced unsupported host observations');
  const harness=RegionExecutionHarness.replay(initial,{requireTerminal:false});let index=0;
  for(const row of publicData.timeline.slice(initial.timeline.length)){
    const context=harness.modelContext(row.fields.invocationId);
    demand(isDeepStrictEqual(context,contexts[index]),'guest checkpoint context differs from independent public replay');
    commitCausalLmV8Selection(harness,row.fields.invocationId,row.fields.line,{context});
    demand(isDeepStrictEqual(harness.timeline.at(-1),row),'guest checkpoint record changed during public replay');index++;
  }
  demand(index===contexts.length,'guest checkpoint omitted or added contexts');return harness;
}

export class NativeV8ChildBridge {
  constructor({prepared,select,policy}={}){
    checkedCase(prepared);validatePolicy(policy);
    demand(typeof select==='function'&&['initialize','openOrchestration','statusOrchestration',
      'selectOrchestration','commitOrchestration','bootstrapOrchestrationChild','cancelOrchestration',
      'commit','complete','reject','checkpoint','restore','metrics'].every(name=>typeof select[name]==='function'),
      'checked V8 coordinator and semantic transport required');
    this.prepared=prepared;this.select=select;this.policy=freeze(copy(policy));
    this.harness=RegionExecutionHarness.replay(prepared.initialPublic,{requireTerminal:false});
    this.session=prepared.initialPublic.timeline[0].fields.session;
    this.invocationId=prepared.initialPublic.timeline.find(row=>row.kind==='invocation').fields.invocationId;
    this.contexts=[];this.events=[];this.pendingCoordinator=null;this.pendingChild=null;
    this.coordinatorSelections=0;this.childSelections=0;this.state=null;this.fatal=null;
  }
  static async open(options){
    const bridge=new NativeV8ChildBridge(options),policy=bridge.policy;
    bridge.identity=copy(await bridge.select.initialize({seed:policy.seed,checkpointIdentity:policy.checkpointIdentity,
      tokenizerIdentity:policy.tokenizerIdentity,trainingIdentity:policy.trainingIdentity}));
    demand(bridge.identity.checkpointIdentity===policy.checkpointIdentity&&
      bridge.identity.tokenizerIdentity===policy.tokenizerIdentity&&
      (bridge.identity.trainingIdentity??null)===policy.trainingIdentity&&bridge.identity.seed===policy.seed&&
      isDeepStrictEqual(bridge.identity.generationSettings,policy.generationSettings),'loaded model settings differ');
    bridge.state=copy(await bridge.select.openOrchestration({session:bridge.session,public:bridge.prepared.initialPublic,
      maxActive:policy.maxActive,childBudget:policy.childBudget,origin:policy.origin==='engineering'?'controlled':'model'}));
    bridge.events.push({kind:'open',receipt:copy(bridge.state)});return bridge;
  }
  owner(){demand(this.state,'coordinator has not opened');return {session:this.session,track:this.state.track};}
  guard(){demand(!this.fatal,'bridge stopped after an uncertain or refused acknowledgement');}
  async status(){this.state=copy(await this.select.statusOrchestration(this.owner()));return copy(this.state);}
  async selectCoordinator({controlledRecord}={}){
    this.guard();demand(!this.pendingCoordinator&&!this.pendingChild,'resolve the pending candidate first');
    demand(this.coordinatorSelections<this.policy.maxCoordinatorSelections,'coordinator selection budget exhausted');
    demand(this.policy.origin==='engineering'?typeof controlledRecord==='string':controlledRecord===undefined,
      'actual model work cannot receive controlled lifecycle decisions');
    this.coordinatorSelections++;
    try{const selected=await this.select.selectOrchestration({...this.owner(),
      ...(controlledRecord===undefined?{}:{controlledRecord})});
      this.pendingCoordinator=copy(selected);this.events.push({kind:'coordinator-selected',selected:copy(selected)});
      return copy(selected);
    }catch(error){this.events.push({kind:'coordinator-selection-failed',failure:failure(error)});throw error;}
  }
  async commitCoordinator(selected){
    this.guard();
    // Native authority also validates retries after an acknowledged action.
    if(this.pendingCoordinator)demand(isDeepStrictEqual(selected,this.pendingCoordinator),'coordinator candidate was replaced');
    try{const receipt=await this.select.commitOrchestration({...this.owner(),record:selected.record,selection:selected.selection});
      this.pendingCoordinator=null;await this.status();
      this.events.push({kind:'coordinator-acknowledged',selected:copy(selected),receipt:copy(receipt)});return copy(receipt);
    }catch(error){this.events.push({kind:'coordinator-acknowledgement-failed',failure:failure(error)});
      if(error.acknowledgementUnknown)this.fatal=error;throw error;}
  }
  async bootstrap(childTrack=this.state?.children[0]?.track){
    this.guard();demand(!this.pendingCoordinator&&!this.pendingChild,'resolve pending work before bootstrap');
    const receipt=await this.select.bootstrapOrchestrationChild({...this.owner(),childTrack});
    await this.status();this.events.push({kind:'bootstrap',receipt:copy(receipt)});return copy(receipt);
  }
  async selectChild(){
    this.guard();demand(!this.pendingCoordinator&&!this.pendingChild,'resolve pending work before child selection');
    demand(this.childSelections<this.policy.maxChildSelections,'child selection budget exhausted');
    const state=await this.status(),child=state.children.find(row=>row.execution.invocation_id===this.invocationId),
      track=state.tracks.find(row=>row.address===child?.track);
    demand(track?.status==='active'&&track.bootstrap_ready===true,'native child must be reserved, bootstrapped and runnable');
    const context=this.harness.modelContext(this.invocationId),request={session:this.session,
      public:this.harness.exportEpisode(),contexts:copy(this.contexts),context};
    this.childSelections++;
    try{const selected=await this.select(request);this.pendingChild={selected:copy(selected),context:copy(context)};
      this.events.push({kind:'child-selected',selected:copy(selected),context:copy(context)});return copy(selected);
    }catch(error){this.events.push({kind:'child-selection-failed',failure:failure(error)});throw error;}
  }
  async commitChild(selected){
    this.guard();const pending=this.pendingChild;
    demand(pending&&isDeepStrictEqual(selected,pending.selected),'child candidate was replaced');
    const stage=RegionExecutionHarness.replay(this.harness.exportEpisode(),{requireTerminal:false}),
      contexts=[...copy(this.contexts),copy(pending.context)];
    // The public machine stages the exact bytes before any native commit. No
    // host service is attached to this pure-source profile.
    try{commitCausalLmV8Selection(stage,this.invocationId,selected.record,{context:pending.context});}
    catch(error){this.events.push({kind:'child-public-refusal',selected:copy(selected),failure:failure(error)});throw error;}
    try{const receipt=await this.select.commit({session:this.session,public:stage.exportEpisode(),contexts,
      invocationId:this.invocationId,record:selected.record,selection:selected.selection});
      demand(receipt.committed===true,'native child acknowledgement missing');
      this.harness=stage;this.contexts=contexts;this.pendingChild=null;
      this.events.push({kind:'child-acknowledged',selected:copy(selected),receipt:copy(receipt)});return copy(receipt);
    }catch(error){this.fatal=error;this.events.push({kind:'child-acknowledgement-failed',failure:failure(error)});throw error;}
  }
  async rejectChild(reason){
    demand(this.pendingChild&&typeof reason==='string'&&reason.length>0,'pending child and explicit rejection reason required');
    const receipt=await this.select.reject({session:this.session,selectionId:this.pendingChild.selected.selection.selectionId,reason});
    this.pendingChild=null;this.events.push({kind:'child-rejected',receipt:copy(receipt),reason});return copy(receipt);
  }
  async completeChild(){
    this.guard();demand(!this.pendingCoordinator&&!this.pendingChild,'resolve pending work before completion');
    const activation=this.harness.activation(this.invocationId);
    demand(activation.status==='completed','guest has not committed its terminal record');
    const receipt=await this.select.complete({session:this.session,public:this.harness.exportEpisode(),
      contexts:copy(this.contexts),invocationId:this.invocationId,completion:copy(activation.controller.completion)});
    demand(receipt.childCompletion?.track===this.state.children[0].track&&
      isDeepStrictEqual(receipt.childCompletion.completion,activation.controller.completion),
      'independent native completion differs from the public guest result');
    await this.status();this.events.push({kind:'child-completed',receipt:copy(receipt)});return copy(receipt);
  }
  async cancel(reason){
    const receipt=await this.select.cancelOrchestration({...this.owner(),reason});
    this.pendingCoordinator=null;this.pendingChild=null;this.state=copy(receipt);
    this.events.push({kind:'cancel',reason,receipt:copy(receipt)});return copy(receipt);
  }
  async checkpoint(){
    this.guard();demand(!this.pendingCoordinator&&!this.pendingChild,'checkpoint requires acknowledged candidates');
    const native=await this.select.checkpoint(),publicData=this.harness.exportEpisode(),saved=native.native.sessions[this.session];
    demand(saved&&isDeepStrictEqual(saved.public,publicData)&&isDeepStrictEqual(saved.contexts,this.contexts)&&
      isDeepStrictEqual(saved.orchestration?.initialPublic,this.prepared.initialPublic)&&saved.unacknowledgedSelection===null,
      'native checkpoint and acknowledged source-bound guest history differ');
    const body={schema:'semantic-orchestration-bridge-checkpoint/8',caseDigest:this.prepared.digest,
      policy:copy(this.policy),public:publicData,contexts:copy(this.contexts),native};
    return {...body,digest:hashAlgorithmData(body)};
  }
  static async restore({checkpoint,prepared,select,policy}={}){
    checkedCase(prepared);validatePolicy(policy);
    const {digest,...body}=checkpoint??{};
    demand(checkpoint?.schema==='semantic-orchestration-bridge-checkpoint/8'&&HASH.test(digest??'')&&
      digest===hashAlgorithmData(body)&&Object.keys(checkpoint).sort().join(',')===
        'caseDigest,contexts,digest,native,policy,public,schema'&&checkpoint.caseDigest===prepared.digest&&
      isDeepStrictEqual(checkpoint.policy,policy),'checkpoint differs from independently expected source and policy');
    const harness=replayGuest(checkpoint.public,checkpoint.contexts,prepared.initialPublic),
      session=prepared.initialPublic.timeline[0].fields.session,saved=checkpoint.native?.native?.sessions?.[session];
    const pin=checkpoint.native?.identity,nativeAttempts=checkpoint.native?.native?.attempts;
    demand(pin?.checkpointIdentity===policy.checkpointIdentity&&pin.tokenizerIdentity===policy.tokenizerIdentity&&
      (pin.trainingIdentity??null)===policy.trainingIdentity&&pin.seed===policy.seed&&
      isDeepStrictEqual(pin.generationSettings,policy.generationSettings)&&
      Array.isArray(nativeAttempts)&&nativeAttempts.filter(row=>row.family==='orchestration').length<=policy.maxCoordinatorSelections&&
      nativeAttempts.filter(row=>row.family!=='orchestration').length<=policy.maxChildSelections,
      'native checkpoint identity or consumed work differs from externally expected policy');
    demand(saved&&Object.keys(checkpoint.native.native.sessions).length===1&&
      Object.keys(checkpoint.native.native.closedSessions??{}).length===0&&
      isDeepStrictEqual(saved.public,checkpoint.public)&&isDeepStrictEqual(saved.contexts,checkpoint.contexts)&&
      isDeepStrictEqual(saved.orchestration?.initialPublic,prepared.initialPublic)&&
      saved.orchestration.origin===(policy.origin==='engineering'?'controlled':'model')&&
      saved.orchestration.childBudget===policy.childBudget&&saved.orchestration.maxActive===policy.maxActive&&
      saved.unacknowledgedSelection===null,
      'native restore authority differs from the original source-bound guest history');
    const bridge=new NativeV8ChildBridge({prepared,select,policy});
    bridge.restoreReceipt=await select.restore({checkpoint:checkpoint.native});
    bridge.harness=harness;bridge.contexts=copy(checkpoint.contexts);bridge.identity=copy(checkpoint.native.identity);
    bridge.state={track:saved.orchestration.track};await bridge.status();
    const attempts=select.metrics().attempts;
    bridge.coordinatorSelections=attempts.filter(row=>row.family==='orchestration').length;
    bridge.childSelections=attempts.length-bridge.coordinatorSelections;
    demand(bridge.coordinatorSelections<=policy.maxCoordinatorSelections&&bridge.childSelections<=policy.maxChildSelections,
      'restored attempt accounting exceeds externally expected limits');
    bridge.events.push({kind:'restored',receipt:copy(bridge.restoreReceipt)});return bridge;
  }
  async result(){
    let checkpoint=null,checkpointFailure=null;
    try{checkpoint=await this.checkpoint();}catch(error){checkpointFailure=failure(error);}
    const state=await this.status(),source=checkedCase(this.prepared),publicData=this.harness.exportEpisode(),
      sourceRecheck=await recheckRegionEvidence(source.artifact),
      publicCompleted=this.harness.activation(this.invocationId).status==='completed',
      exactSourceProjection=isDeepStrictEqual(publicData,source.artifact.public)&&
        isDeepStrictEqual(this.contexts,source.artifact.contexts),
      body={schema:'semantic-orchestration-bridge-result/8',caseId:this.prepared.id,
        caseDigest:this.prepared.digest,sourceArtifactDigest:this.prepared.artifactDigest,
        policy:copy(this.policy),public:publicData,contexts:copy(this.contexts),lifecycle:copy(state),
        events:copy(this.events),nativeMetrics:this.select.metrics(),checkpoint,checkpointFailure,
        publicCompleted,nativeCoordinatorCompleted:state.status==='completed',
        sourceInputValidated:sourceRecheck.sourceValidated===true,
        sourceCorrespondence:exactSourceProjection?'exact-source-certified-projection':'unqualified-alternative',
        nativeAdmissionClaim:false,sourceAdmissionClaim:false,productionExecutionClaim:false,
        modelMeasurement:this.policy.origin==='engineering'?'engineering-only':'actual-model-selected',
        tokenPacking:'unmeasured',optimizerSteps:0,hostDispatches:0};
    return {...body,digest:hashAlgorithmData(body)};
  }
}
