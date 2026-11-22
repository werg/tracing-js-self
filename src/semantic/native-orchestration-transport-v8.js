// The native coordinator owns lifecycle transitions. This transport binds its
// acknowledgements to observed V8 inputs and preserves original model bytes.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';
import {RegionExecutionHarness} from './region-harness.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const demand=(value,message)=>{if(!value)throw new TypeError('Native v8 orchestration: '+message);};
const nonempty=value=>typeof value==='string'&&value.length>0;
const hex=value=>typeof value==='string'&&/^(?:[0-9a-f]{2})*$/.test(value);
const statuses=new Set(['active','waiting','completed','cancelled']);
const instruction='Emit one JSON object {name,arguments}. Allowed actions are track_create, track_join, track_progress, track_complete and track_cancel. Copy a declared execution binding exactly into track_create, with purpose, completion, capabilities and budget. Join only this coordinator\'s issued child dependency. Progress must contain the exact JSON {kind,value} of a delivered child completion. Complete only after all declared children have delivered and published results. Other lifecycle actions are outside this bounded profile.';

export function nativeV8OrchestrationContext(state){
  return {schema:'semantic-orchestration-context/8',session:state.session,track:state.track,
    children:copy(state.children),tracks:copy(state.tracks),receipts:copy(state.receipts),
    published:copy(state.published),publicDigest:state.publicDigest,instruction};
}

function expectedChildren(publicData,session,track){
  demand(publicData?.schema==='semantic-execution/8'&&Array.isArray(publicData.timeline)&&
    publicData.timeline[0]?.fields?.session===session,'observed V8 source and input required');
  demand(publicData.timeline.every(row=>row.mode==='observed'&&['program','invocation'].includes(row.kind)),
    'coordinator ingress must contain only observed source and root inputs');
  RegionExecutionHarness.replay(copy(publicData),{requireTerminal:false});
  const programs=new Map(),children=[];
  for(const row of publicData.timeline){
    const fields=row.fields;
    if(row.kind==='program'){programs.set(fields.programId,row);continue;}
    demand(fields.activation==='call'&&fields.parentInvocationId===null&&fields.closureId===null&&
      fields.taskRevision===1,'coordinator profile requires declared root calls');
    const program=programs.get(fields.programId),source=program?.fields;
    demand(source&&hashAlgorithmData(source.source)===source.digest&&fields.sourceDigest===source.digest,
      'child source differs from its published bytes');
    children.push({program:copy(program),invocation:copy(row),execution:{
      schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
      entry:fields.entry,invocation_id:fields.invocationId,realm_id:fields.realmId,trigger_id:fields.triggerId,
      input_ref:hashAlgorithmData(fields.inputGraph),realm_policy:fields.realmPolicy,
      completion_mode:fields.completionPolicy,capability_grants:copy(source.capabilities),completion_target:track}});
  }
  demand(children.length>=1&&children.length<=16,'one to sixteen declared child inputs required');
  return children;
}

export function attachNativeV8OrchestrationTransport(select,{request,identity,epoch,sessions,attempts,stop}){
  const coordinators=new Map();
  const requireIdentity=()=>{demand(identity()!==null,'model has not attested its checkpoint');return identity();};
  const requireCoordinator=input=>{
    requireIdentity();
    const state=coordinators.get(input?.session);
    demand(state&&input.track===state.track&&!state.closed,'unknown or closed coordinator session/track');
    return state;
  };
  const verifyState=(state,expected)=>{
    demand(state?.schema==='semantic-orchestration-state/8'&&state.session===expected.session&&
      state.track===expected.track&&state.origin==='model'&&state.sourceAdmissionClaim===false&&
      statuses.has(state.status)&&HASH.test(state.publicDigest??'')&&
      (state.pendingSelection===null||nonempty(state.pendingSelection))&&
      ['children','decisions','tracks','receipts','published'].every(key=>Array.isArray(state[key])),
      'invalid coordinator state or admission claim');
    demand(state.children.length===expected.children.length,'coordinator changed its declared children');
    for(let i=0;i<state.children.length;i++){
      const child=state.children[i],original=expected.children[i];
      demand(['program','invocation','execution'].every(key=>isDeepStrictEqual(child?.[key],original[key]))&&
        (child.track===null||nonempty(child.track)),'coordinator changed an observed child binding');
      if(original.track!=null)demand(child.track===original.track,'coordinator changed a reserved child address');
    }
    expected.children=copy(state.children);return copy(state);
  };
  select.openOrchestration=async input=>{
    const captured=copy(input),model=requireIdentity(),capturedEpoch=epoch();
    const {session,public:publicData,maxActive=1,childBudget=128}=captured??{};
    demand(nonempty(session)&&!sessions.has(session)&&!coordinators.has(session),'fresh session identity required');
    demand(Number.isSafeInteger(maxActive)&&maxActive>=1&&maxActive<=16&&
      Number.isSafeInteger(childBudget)&&childBudget>=1&&childBudget<=100000&&
      (captured.origin===undefined||captured.origin==='model'),'bounded model-selected coordinator required');
    // Validate before opening a native session; the returned track binds the
    // independently derived completion destination afterward.
    expectedChildren(publicData,session,'unallocated');
    const state=await request({op:'open-orchestration',session,public:publicData,maxActive,childBudget,origin:'model'});
    demand(identity()===model&&epoch()===capturedEpoch&&nonempty(state?.track),
      'checkpoint changed or coordinator track was not allocated');
    const expected={session,track:state.track,closed:false,children:expectedChildren(publicData,session,state.track)};
    demand(state.publicDigest===hashAlgorithmData(publicData),'coordinator opening changed its public source cut');
    const result=verifyState(state,expected);
    coordinators.set(session,expected);sessions.set(session,{pending:null,evidence:null});return result;
  };
  select.statusOrchestration=async input=>{
    const captured=copy(input),expected=requireCoordinator(captured);
    return verifyState(await request({op:'status-orchestration',session:captured.session,track:captured.track}),expected);
  };
  select.selectOrchestration=async input=>{
    const captured=copy(input);requireCoordinator(captured);
    demand(captured.controlledRecord===undefined,'actual coordinator cannot receive controlled decisions');
    demand(!sessions.get(captured.session)?.pending,'previous output needs acknowledgement or rejection');
    const state=await select.statusOrchestration(captured);
    demand(state.status==='active'&&state.pendingSelection===null,'coordinator is waiting or closed');
    const model=identity(),capturedEpoch=epoch(),context=nativeV8OrchestrationContext(state);
    const evidence={attempt:attempts.length,family:'orchestration',session:captured.session,track:captured.track,
      invocationId:null,contextDigest:hashAlgorithmData(context),publicDigest:state.publicDigest,
      checkpointIdentity:model.checkpointIdentity,tokenizerIdentity:model.tokenizerIdentity,
      trainingIdentity:model.trainingIdentity??null,status:'submitted',elapsedMs:null,
      selection:null,record:null,failure:null,failureEvidence:null};
    attempts.push(evidence);const started=performance.now();
    try{
      const output=await request({op:'select-orchestration',session:captured.session,track:captured.track});
      evidence.record=typeof output?.record==='string'?output.record:null;evidence.selection=copy(output?.selection??null);
      demand(identity()===model&&epoch()===capturedEpoch,'checkpoint changed during coordinator selection');
      const chosen=output?.selection;
      demand(output?.schema==='semantic-orchestration-output/8'&&typeof output.record==='string'&&
        Buffer.from(output.record,'utf8').toString('utf8')===output.record&&
        chosen?.family==='orchestration'&&chosen.modelSelected===true&&chosen.origin==='actual-model-selected'&&
        nonempty(chosen.selectionId)&&chosen.session===captured.session&&chosen.invocationId===null&&
        chosen.checkpointIdentity===model.checkpointIdentity&&chosen.tokenizerIdentity===model.tokenizerIdentity&&
        (chosen.trainingIdentity??null)===(model.trainingIdentity??null)&&
        chosen.contextDigest===evidence.contextDigest&&chosen.publicDigest===state.publicDigest,
        'coordinator selection is not bound to the frozen model and current task context');
      demand(hex(chosen.payloadHex)&&Buffer.from(chosen.payloadHex,'hex').equals(Buffer.from(output.record,'utf8'))&&
        Array.isArray(chosen.fragments)&&chosen.fragments.length>0&&chosen.fragments.every(fragment=>
          hex(fragment.payloadHex)&&Array.isArray(fragment.tokenIds)&&fragment.tokenIds.length>0&&
          fragment.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&
          isDeepStrictEqual(fragment.emittedTokenIds,fragment.tokenIds)&&nonempty(fragment.selectedEventId)&&
          Number.isSafeInteger(fragment.meridian)&&fragment.meridian>=0&&
          fragment.modelTrack===captured.track&&typeof fragment.terminal==='boolean')&&
        chosen.fragments.at(-1).terminal===true&&chosen.fragments.slice(0,-1).every(fragment=>!fragment.terminal)&&
        chosen.fragments.map(fragment=>fragment.payloadHex).join('')===chosen.payloadHex,
        'coordinator original bytes, tokens or native track evidence changed');
      evidence.status='decoded';
      sessions.set(captured.session,{pending:{family:'orchestration',record:output.record,
        selection:copy(chosen),contextDigest:evidence.contextDigest},evidence});
      return copy(output);
    }catch(error){
      evidence.status='failed';evidence.failure=String(error.message);evidence.failureEvidence=copy(error.evidence??null);
      throw error;
    }finally{evidence.elapsedMs=performance.now()-started;}
  };
  select.commitOrchestration=async input=>{
    demand(select.status().pending===0,'cannot commit while a native request is outstanding');
    const captured=copy(input),expected=requireCoordinator(captured),session=sessions.get(captured.session);
    const previous=attempts.find(row=>row.family==='orchestration'&&row.session===captured.session&&
      row.selection?.selectionId===captured.selection?.selectionId&&row.status==='accepted');
    const pending=session?.pending,evidence=previous??session?.evidence;
    const original=previous??(pending?.family==='orchestration'?pending:null);
    demand(original&&captured.record===original.record&&isDeepStrictEqual(captured.selection,original.selection),
      'acknowledgement changed the original coordinator selection');
    if(!previous)evidence.status='acknowledging';
    try{
      const receipt=await request({op:'commit-orchestration',session:captured.session,track:captured.track,
        record:captured.record,selection:captured.selection});
      demand(receipt?.schema==='semantic-orchestration-commit/8'&&receipt.committed===true&&
        receipt.selectionId===captured.selection.selectionId&&nonempty(receipt.track?.address),
        'native coordinator did not acknowledge this exact lifecycle selection');
      const action=JSON.parse(captured.record),description=receipt.track;
      demand(action&&typeof action==='object'&&!Array.isArray(action)&&
        Object.keys(action).length===2&&typeof action.name==='string'&&
        ['track_create','track_join','track_progress','track_complete','track_cancel'].includes(action.name)&&
        action.arguments&&typeof action.arguments==='object'&&!Array.isArray(action.arguments)&&
        (action.name==='track_create'||action.arguments.address===captured.track),
        'lifecycle acknowledgement does not match an allowed action on this coordinator');
      if(action.name==='track_create'){
        const child=expected.children.find(child=>isDeepStrictEqual(child.execution,action.arguments.execution));
        const dependency=receipt.completion_dependency;
        demand(child&&isDeepStrictEqual(description.execution,action.arguments.execution)&&
          description.parent===captured.track&&description.bootstrap_ready===false&&
          (child.track==null||child.track===description.address)&&
          dependency?.schema==='semantic-completion-dependency/4'&&
          Object.keys(dependency).length===5&&nonempty(dependency.id)&&
          Number.isSafeInteger(description.revision)&&description.revision>=0&&
          dependency.id===`completion:${description.address}:${description.revision}`&&
          dependency.revision===description.revision&&dependency.track===description.address&&
          dependency.invocation===child.execution.invocation_id,
          'child reservation changed its source binding, owner or completion dependency');
        child.track=description.address;
      }else demand(description.address===captured.track&&statuses.has(description.status)&&
        (action.name!=='track_complete'||description.status==='completed')&&
        (action.name!=='track_cancel'||description.status==='cancelled'),
        'lifecycle acknowledgement belongs to another coordinator or disposition');
      if(previous)demand(isDeepStrictEqual(receipt,previous.commitReceipt),'historical acknowledgement changed its receipt');
      else{evidence.status='accepted';evidence.commitReceipt=copy(receipt);session.pending=null;}
      return copy(receipt);
    }catch(error){
      if(!previous){evidence.status=select.status().closed?'acknowledgement-unknown':'commit-failed';
        evidence.failure=String(error.message);if(select.status().closed)error.acknowledgementUnknown=true;}
      throw error;
    }
  };
  select.bootstrapOrchestrationChild=async input=>{
    const captured=copy(input),expected=requireCoordinator(captured);
    const child=expected.children.find(child=>child.track===captured.childTrack);
    demand(child&&nonempty(captured.childTrack),'child bootstrap requires an acknowledged reservation');
    const receipt=await request({op:'bootstrap-orchestration-child',session:captured.session,
      track:captured.track,childTrack:captured.childTrack});
    demand(receipt?.schema==='semantic-orchestration-bootstrap/8'&&receipt.bootstrapped===true&&
      receipt.track?.address===captured.childTrack&&receipt.track.parent===captured.track&&
      receipt.track.bootstrap_ready===true&&isDeepStrictEqual(receipt.track.execution,child.execution),
      'child bootstrap changed its reserved execution binding');
    return copy(receipt);
  };
  select.cancelOrchestration=async input=>{
    const captured=copy(input),expected=requireCoordinator(captured);
    demand(nonempty(captured.reason)&&Buffer.byteLength(captured.reason)<=4096,'bounded cancellation reason required');
    const result=verifyState(await request({op:'cancel-orchestration',session:captured.session,
      track:captured.track,reason:captured.reason}),expected);
    demand(result.status==='cancelled'&&result.receipts.some(receipt=>
      receipt.schema==='semantic-orchestration-cancel/8'&&receipt.track===captured.track&&receipt.reason===captured.reason),
      'coordinator cancellation lacks its exact terminal receipt');
    const session=sessions.get(captured.session);
    if(session?.pending){
      if(!['acknowledgement-unknown','commit-failed'].includes(session.evidence.status)){
        session.evidence.status='cancelled';session.evidence.failure=captured.reason;}
      session.pending=null;
    }
    return result;
  };
  return {
    reset:()=>coordinators.clear(),
    closed:session=>{const state=coordinators.get(session);if(state)state.closed=true;},
    restore:native=>{
      coordinators.clear();
      for(const [session,saved] of [...Object.entries(native.sessions??{}),...Object.entries(native.closedSessions??{})]){
        const state=saved?.orchestration;if(!state)continue;
        const expected={session,track:state.track,closed:Object.hasOwn(native.closedSessions??{},session),
          children:expectedChildren(state.initialPublic,session,state.track)};
        demand(state.origin==='model'&&state.children.length===expected.children.length,
          'restored coordinator authority differs');
        state.children.forEach((child,index)=>{
          demand(['program','invocation','execution'].every(key=>isDeepStrictEqual(child[key],expected.children[index][key])),
            'restored coordinator changed observed child authority');
        });
        expected.children=copy(state.children);coordinators.set(session,expected);
      }
    },
    verifyCompletion:(input,result)=>{
      const expected=coordinators.get(input.session),receipt=result.childCompletion;
      if(!receipt){demand(!expected,'coordinator child completion omitted its typed receipt');return false;}
      const child=expected?.children.find(child=>child.execution.invocation_id===input.invocationId);
      demand(child&&receipt.schema==='semantic-child-completion/8'&&receipt.session===input.session&&
        receipt.invocationId===input.invocationId&&receipt.track===child.track&&nonempty(child.track)&&
        receipt.publicDigest===hashAlgorithmData(input.public)&&receipt.contextsDigest===hashAlgorithmData(input.contexts)&&
        ['return','throw'].includes(receipt.completion?.kind)&&Object.hasOwn(receipt.completion,'value')&&
        Array.isArray(receipt.heap)&&(input.completion===undefined||isDeepStrictEqual(receipt.completion,input.completion))&&
        (result.sessionRetained===true||expected.closed&&result.sessionRetained===false),
        'child completion changed its source cut, result, owner or closed-session authority');
      return true;
    },
  };
}
