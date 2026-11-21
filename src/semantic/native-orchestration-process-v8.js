// Coordinator transport uses the V8 native authority directly. Its lifecycle
// log stays separate from the guest program's public semantic history.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';

const copy=structuredClone,HASH=/^[a-f0-9]{64}$/;
const demand=(condition,message)=>{if(!condition)throw new TypeError('Native v8 orchestration: '+message);};
const instruction='Emit one JSON object {name,arguments}. Allowed actions are track_create, track_join, track_progress, track_complete and track_cancel. Copy a declared execution binding exactly into track_create, with purpose, completion, capabilities and budget. Join only this coordinator\'s issued child dependency. Progress must contain the exact JSON {kind,value} of a delivered child completion. Complete only after all declared children have delivered and published results. Other lifecycle actions are outside this bounded profile.';
export const nativeV8CoordinatorContext=state=>({schema:'semantic-orchestration-context/8',session:state.session,track:state.track,
  children:state.children,tracks:state.tracks,receipts:state.receipts,published:state.published,
  publicDigest:state.publicDigest,instruction});

export function nativeV8ChildBinding(program,invocation,track){
  const source=program.fields,input=invocation.fields;
  return {program_id:source.programId,source_digest:source.digest,entry:input.entry,
    invocation_id:input.invocationId,realm_id:input.realmId,trigger_id:input.triggerId,
    input_ref:hashAlgorithmData(input.inputGraph),realm_policy:input.realmPolicy,
    completion_mode:input.completionPolicy,capability_grants:copy(source.capabilities),
    completion_target:track,schema:'semantic-execution-binding/4'};
}

function validateState(state,owner){
  demand(state?.schema==='semantic-orchestration-state/8'&&state.session===owner.session&&
    typeof state.track==='string'&&state.track.length>0&&(!owner.track||state.track===owner.track)&&
    state.origin===owner.origin&&state.sourceAdmissionClaim===false&&
    ['active','waiting','completed','cancelled'].includes(state.status)&&HASH.test(state.publicDigest??'')&&
    Array.isArray(state.children)&&Array.isArray(state.tracks)&&Array.isArray(state.receipts)&&
    Array.isArray(state.decisions)&&Array.isArray(state.published),'invalid coordinator state or owner');
  const programs=new Map(owner.public.timeline.filter(row=>row.kind==='program').map(row=>[row.fields.programId,row])),
    roots=owner.public.timeline.filter(row=>row.kind==='invocation');
  demand(state.children.length===roots.length&&state.tracks.length<=roots.length+1,
    'coordinator changed its declared child population');
  for(const [index,invocation]of roots.entries()){
    const program=programs.get(invocation.fields.programId),child=state.children[index];
    demand(program&&isDeepStrictEqual(child.program,program)&&isDeepStrictEqual(child.invocation,invocation)&&
      isDeepStrictEqual(child.execution,nativeV8ChildBinding(program,invocation,state.track)),
      'native child changed original source, input, grants or completion owner');
    if(child.track!==null){const track=state.tracks.find(item=>item.address===child.track);
      demand(track?.parent===state.track&&isDeepStrictEqual(track.execution,child.execution),
        'native child track changed its exact typed binding');}
  }
  demand(new Set(state.tracks.map(row=>row.address)).size===state.tracks.length&&
    state.tracks.some(row=>row.address===state.track&&row.status===state.status),
    'coordinator track inventory changed');
  return state;
}

/** Installed by the ordinary V8 process client, sharing its request channel,
 * attested identity, global attempt log and pending semantic candidates. */
export function attachNativeV8Orchestration(select,{request,identity,sessions,attempts,
    isClosed,allowControlled=false}={}){
  const owners=new Map();
  const ownerOf=input=>{const owner=owners.get(input?.session);
    demand(owner&&!owner.closed&&input.track===owner.track,'unknown coordinator owner');return owner;};
  const attest=()=>{const value=identity();demand(value,'initialize the native model first');return value;};
  select.openOrchestration=async input=>{
    attest();const {session,public:publicData,maxActive=1,childBudget=128,origin='model'}=input??{};
    demand(typeof session==='string'&&session.length>0&&!owners.has(session)&&!sessions.has(session),
      'opening requires a fresh session');
    demand(publicData?.schema==='semantic-execution/8'&&Array.isArray(publicData.timeline)&&
      publicData.timeline.length>=2&&publicData.timeline.every(row=>row.mode==='observed'&&
        ['program','invocation'].includes(row.kind)&&row.fields?.session===session),
      'only original source and root input may open a coordinator');
    demand(['model','controlled'].includes(origin)&&(origin!=='controlled'||allowControlled),
      'controlled coordinator requires explicit engineering authority');
    demand(Number.isSafeInteger(maxActive)&&maxActive>=1&&maxActive<=16&&
      Number.isSafeInteger(childBudget)&&childBudget>=1&&childBudget<=100000,'invalid coordinator bounds');
    const owner={session,public:copy(publicData),origin,track:null,pending:null,acknowledged:new Map(),closed:false};
    const state=validateState(await request({op:'open-orchestration',session,public:publicData,
      maxActive,childBudget,origin}),owner);
    demand(state.publicDigest===hashAlgorithmData(publicData)&&state.children.every(child=>child.track===null&&
      child.completion===null)&&state.decisions.length===0&&state.published.length===0,
      'new coordinator already contains unacknowledged work');
    owner.track=state.track;owner.state=copy(state);owners.set(session,owner);
    sessions.set(session,{pending:null,evidence:null});return copy(state);
  };
  select.statusOrchestration=async input=>{
    const owner=ownerOf(input),state=validateState(await request({op:'status-orchestration',
      session:owner.session,track:owner.track}),owner);
    owner.state=copy(state);return copy(state);
  };
  select.selectOrchestration=async input=>{
    const pin=attest(),owner=ownerOf(input);
    demand(!owner.pending&&!sessions.get(owner.session)?.pending,'a previous candidate still needs acknowledgement');
    demand(owner.origin==='controlled'?allowControlled&&typeof input.controlledRecord==='string':
      input.controlledRecord===undefined,'actual model coordinator cannot receive fixture decisions');
    const state=await select.statusOrchestration(input),contextDigest=hashAlgorithmData(nativeV8CoordinatorContext(state)),
      evidence={attempt:attempts.length,family:'orchestration',session:owner.session,invocationId:null,
        checkpointIdentity:pin.checkpointIdentity,tokenizerIdentity:pin.tokenizerIdentity,
        trainingIdentity:pin.trainingIdentity??null,contextDigest,status:'submitted',elapsedMs:null,
        record:null,selection:null,failure:null,failureEvidence:null};
    attempts.push(evidence);const started=performance.now();
    try{
      const output=await request({op:'select-orchestration',session:owner.session,track:owner.track,
        ...(owner.origin==='controlled'?{controlledRecord:input.controlledRecord}:{})}),selection=output?.selection;
      evidence.record=typeof output?.record==='string'?output.record:null;evidence.selection=copy(selection??null);
      demand(output?.schema==='semantic-orchestration-output/8'&&typeof output.record==='string'&&
        selection?.family==='orchestration'&&selection.session===owner.session&&selection.invocationId===null&&
        selection.status==='awaiting-commit'&&typeof selection.selectionId==='string'&&selection.selectionId.length>0&&
        selection.origin===(owner.origin==='controlled'?'controlled':'actual-model-selected')&&
        selection.modelSelected===(owner.origin!=='controlled')&&selection.checkpointIdentity===pin.checkpointIdentity&&
        selection.tokenizerIdentity===pin.tokenizerIdentity&&(selection.trainingIdentity??null)===(pin.trainingIdentity??null)&&
        selection.contextDigest===contextDigest&&selection.publicDigest===state.publicDigest,
        'coordinator selection changed source context, origin or loaded identity');
      demand(typeof selection.payloadHex==='string'&&/^(?:[a-f0-9]{2})+$/.test(selection.payloadHex)&&
        Buffer.from(selection.payloadHex,'hex').equals(Buffer.from(output.record,'utf8'))&&
        Array.isArray(selection.fragments)&&selection.fragments.length>0&&selection.fragments.every(part=>
          Array.isArray(part.tokenIds)&&part.tokenIds.length>0&&part.tokenIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&
          typeof part.payloadHex==='string'&&/^(?:[a-f0-9]{2})*$/.test(part.payloadHex))&&
        selection.fragments.map(part=>part.payloadHex).join('')===selection.payloadHex,
        'original coordinator bytes and token evidence differ');
      evidence.status='decoded';owner.pending={record:output.record,selection:copy(selection),evidence};
      return copy(output);
    }catch(error){evidence.status='failed';evidence.failure=String(error.message);
      evidence.failureEvidence=copy(error.evidence??null);throw error;}
    finally{evidence.elapsedMs=performance.now()-started;}
  };
  select.commitOrchestration=async input=>{
    const owner=ownerOf(input),selected=owner.pending??owner.acknowledged.get(input.selection?.selectionId);
    demand(selected&&input.record===selected.record&&isDeepStrictEqual(input.selection,selected.selection),
      'acknowledgement changed original coordinator bytes or evidence');
    selected.evidence.status='acknowledging';
    try{
      const result=await request({op:'commit-orchestration',session:owner.session,track:owner.track,
        record:input.record,selection:input.selection});
      demand(result?.schema==='semantic-orchestration-commit/8'&&result.committed===true&&
        result.selectionId===selected.selection.selectionId&&typeof result.track?.address==='string',
        'native authority did not acknowledge the exact coordinator action');
      if(selected.receipt)demand(isDeepStrictEqual(selected.receipt,result),'historical coordinator receipt changed');
      selected.receipt=copy(result);selected.evidence.status='accepted';owner.pending=null;
      owner.acknowledged.set(selected.selection.selectionId,selected);return copy(result);
    }catch(error){selected.evidence.status=isClosed()?'acknowledgement-unknown':'commit-failed';
      selected.evidence.failure=String(error.message);if(isClosed())error.acknowledgementUnknown=true;throw error;}
  };
  select.bootstrapOrchestrationChild=async input=>{
    const owner=ownerOf(input);demand(!owner.pending&&!sessions.get(owner.session)?.pending,
      'resolve pending work before bootstrap');
    const state=await select.statusOrchestration(input),child=state.children.find(row=>row.track===input.childTrack);
    demand(child,'bootstrap requires an acknowledged child reservation');
    const result=await request({op:'bootstrap-orchestration-child',session:owner.session,track:owner.track,
      childTrack:input.childTrack});
    demand(result?.schema==='semantic-orchestration-bootstrap/8'&&result.bootstrapped===true&&
      result.track?.address===child.track&&result.track.parent===owner.track&&result.track.bootstrap_ready===true&&
      isDeepStrictEqual(result.track.execution,child.execution),'bootstrap receipt changed its child binding');
    return copy(result);
  };
  select.cancelOrchestration=async input=>{
    const owner=ownerOf(input);demand(typeof input.reason==='string'&&input.reason.length>0&&
      input.reason.length<=4096,'bounded cancellation reason required');
    const state=validateState(await request({op:'cancel-orchestration',session:owner.session,
      track:owner.track,reason:input.reason}),owner);
    demand(state.status==='cancelled'&&state.tracks.every(row=>['completed','cancelled'].includes(row.status)),
      'native cancellation left runnable work');
    if(owner.pending){owner.pending.evidence.status='cancelled';owner.pending.evidence.failure=input.reason;owner.pending=null;}
    const semantic=sessions.get(owner.session);
    if(semantic?.pending){semantic.evidence.status='cancelled';semantic.evidence.failure=input.reason;semantic.pending=null;}
    owner.state=copy(state);return copy(state);
  };
  return {
    clear:()=>owners.clear(),
    assertSemanticReady:session=>demand(!owners.get(session)?.pending,'coordinator candidate still needs acknowledgement'),
    close:session=>{const owner=owners.get(session);if(owner)owner.closed=true;},
    async restore(native){
      for(const [session,saved]of Object.entries(native.sessions))if(saved.orchestration){
        const state=saved.orchestration;
        demand(state.origin!=='controlled'||allowControlled,'controlled recovery requires explicit engineering authority');
        const owner={session,public:copy(state.initialPublic),origin:state.origin,track:state.track,
          pending:null,acknowledged:new Map(),closed:false};
        owners.set(session,owner);
        for(const decision of state.decisions){const evidence=attempts.find(row=>row.family==='orchestration'&&
            row.selection?.selectionId===decision.selectionId);
          demand(evidence&&evidence.record===decision.record&&evidence.status==='accepted',
            'retained coordinator action lacks its original transport evidence');
          owner.acknowledged.set(decision.selectionId,{record:evidence.record,selection:copy(evidence.selection),
            evidence,receipt:copy(decision.outcome)});}
        await select.statusOrchestration({session,track:state.track});
      }
    }
  };
}
