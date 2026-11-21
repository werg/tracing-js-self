// Explicit transport-only process stub. This is not the independent native
// consumer, model execution, a source receipt, or qualifying evidence.
import assert from 'node:assert/strict';
import {readFileSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {hashAlgorithmData} from '../../src/semantic/program.js';
import {nativeV8ChildBinding,nativeV8CoordinatorContext} from '../../src/semantic/native-orchestration-process-v8.js';
import {RegionExecutionHarness} from '../../src/semantic/region-harness.js';
import {commitCausalLmV8Selection} from '../../src/semantic/causal-lm-v8.js';

const copy=structuredClone,artifact=JSON.parse(readFileSync(process.argv[2],'utf8')),
  targets=artifact.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line);
let identity=null,state=null,publicData=null,contexts=[],pending=null,attempts=[],decisions=[],operations=[];
const observed=()=>({...copy(state),pendingSelection:pending?.selection.selectionId??null,
  publicDigest:hashAlgorithmData(publicData),decisions:copy(decisions)});
const track=address=>state.tracks.find(row=>row.address===address);
function evidence(request,record,family){
  const payloadHex=Buffer.from(record).toString('hex');
  return {adapter:'native-semantic-v8/1',selectionId:'v8:'+attempts.length,
    session:request.session,invocationId:family?null:request.context.invocationId,
    ...(family?{family}:{}),checkpointIdentity:identity.checkpointIdentity,
    tokenizerIdentity:identity.tokenizerIdentity,trainingIdentity:identity.trainingIdentity,
    origin:family&&state.origin==='controlled'?'controlled':'actual-model-selected',
    modelSelected:!(family&&state.origin==='controlled'),status:'awaiting-commit',
    contextDigest:hashAlgorithmData(family?nativeV8CoordinatorContext(observed()):request.context),
    publicDigest:hashAlgorithmData(publicData),...(family?{}:{prefixDigest:request.context.prefixDigest}),
    payloadHex,fragments:[{tokenIds:[...Buffer.from(record)],payloadHex,modelTrack:family?state.track:state.children[0].track}],
    engineeringTransportStub:true};
}
function run(request){
  if(request.op==='initialize')return identity={schema:'semantic-inference-identity/8',seed:request.seed,
    checkpointIdentity:request.checkpointIdentity,tokenizerIdentity:request.tokenizerIdentity,
    trainingIdentity:request.trainingIdentity??null,generationSettings:{device:'cpu',maxTokens:512,maxFragments:16,effort:1}};
  if(request.op==='open-orchestration'){
    publicData=copy(request.public);const coordinator='track:0',program=publicData.timeline[0],invocation=publicData.timeline[1];
    state={schema:'semantic-orchestration-state/8',session:request.session,track:coordinator,origin:request.origin,
      sourceAdmissionClaim:false,status:'active',children:[{program,invocation,
        execution:nativeV8ChildBinding(program,invocation,coordinator),track:null,completion:null}],
      tracks:[{address:coordinator,parent:null,status:'active',capabilities:['text',...program.fields.capabilities],
        budget:100000,execution:null,bootstrap_ready:false}],receipts:[],published:[]};
    const result=observed();
    if(process.env.V8_STUB_TAMPER==='binding')result.children[0].execution.input_ref='0'.repeat(64);
    return result;
  }
  if(request.op==='status-orchestration')return observed();
  if(request.op==='select-orchestration'){
    assert(!pending);assert.equal(state.status,'active');
    const record=request.controlledRecord??'{}',selection=evidence(request,record,'orchestration');
    pending={record,selection};attempts.push(selection);
    const result={schema:'semantic-orchestration-output/8',record,selection:copy(selection)};
    if(process.env.V8_STUB_TAMPER==='context')result.selection.contextDigest='0'.repeat(64);
    return result;
  }
  if(request.op==='commit-orchestration'){
    const old=decisions.find(row=>row.selectionId===request.selection.selectionId);
    if(old){assert.equal(request.record,old.record);assert.deepEqual(request.selection,{...attempts.find(row=>row.selectionId===old.selectionId),status:'awaiting-commit'});return old.outcome;}
    assert(pending);assert.equal(request.record,pending.record);assert.deepEqual(request.selection,pending.selection);
    const action=JSON.parse(request.record),args=action.arguments;let result;
    if(action.name==='track_create'){
      const child=state.children[0];assert.equal(child.track,null);assert.deepEqual(args.execution,child.execution);
      assert.deepEqual(args.capabilities,['text',...child.program.fields.capabilities]);
      child.track='track:1';const description={address:child.track,parent:state.track,status:'waiting',
        execution:copy(child.execution),bootstrap_ready:false,budget:args.budget,capabilities:copy(args.capabilities)};
      state.tracks.push(description);result={track:copy(description),completion_dependency:{schema:'semantic-completion-dependency/4',
        id:'completion:track:1:0',track:child.track,revision:0,invocation:child.execution.invocation_id}};
    }else if(action.name==='track_join'){
      assert.equal(args.address,state.track);assert.deepEqual(args.completion_dependency,decisions[0].outcome.completion_dependency);
      state.status=track(state.track).status='waiting';track(state.children[0].track).status='active';result={track:copy(track(state.track))};
    }else if(action.name==='track_progress'){
      assert.deepEqual(JSON.parse(args.progress),state.children[0].completion.completion);
      state.published.push(state.children[0].execution.invocation_id);result={track:copy(track(state.track))};
    }else if(action.name==='track_complete'){
      assert.equal(state.published.length,1);state.status=track(state.track).status='completed';result={track:copy(track(state.track))};
    }else throw new Error('Unsupported stub action');
    result={schema:'semantic-orchestration-commit/8',selectionId:pending.selection.selectionId,committed:true,...result};
    decisions.push({selectionId:pending.selection.selectionId,record:pending.record,outcome:copy(result)});
    operations.push({kind:'coordinator',attempt:attempts.length-1});pending.selection.status='committed';pending=null;
    if(process.env.V8_STUB_TAMPER==='lost-ack')process.exit(23);
    return result;
  }
  if(request.op==='bootstrap-orchestration-child'){
    assert(!pending);const child=track(request.childTrack);assert(child);assert.equal(child.parent,state.track);
    assert(!['completed','cancelled'].includes(state.status));child.bootstrap_ready=true;
    operations.push({kind:'bootstrap',track:child.address});
    return {schema:'semantic-orchestration-bootstrap/8',bootstrapped:true,track:copy(child)};
  }
  if(request.op==='select'){
    assert(!pending);assert.equal(track(state.children[0].track).status,'active');
    assert.deepEqual(request.public,publicData);assert.deepEqual(request.contexts,contexts);
    const h=RegionExecutionHarness.replay(publicData,{requireTerminal:false});
    assert.deepEqual(request.context,h.modelContext(request.context.invocationId));
    const record=process.env.V8_STUB_TAMPER==='guest'?'detail not canonical':targets[contexts.length],
      selection=evidence(request,record);pending={record,selection,context:request.context};attempts.push(selection);
    return {schema:'semantic-model-output/8',record,selection:copy(selection)};
  }
  if(request.op==='commit'){
    assert(pending);assert.deepEqual(request.selection,pending.selection);assert.equal(request.record,pending.record);
    const h=RegionExecutionHarness.replay(publicData,{requireTerminal:false});
    commitCausalLmV8Selection(h,request.invocationId,request.record,{context:pending.context});
    assert.deepEqual(request.public,h.exportEpisode());assert.deepEqual(request.contexts,[...contexts,pending.context]);
    publicData=copy(request.public);contexts=copy(request.contexts);pending.selection.status='committed';pending=null;
    operations.push({kind:'semantic'});return {schema:'semantic-native-commit/8',selectionId:request.selection.selectionId,
      committed:true,publicDigest:hashAlgorithmData(publicData)};
  }
  if(request.op==='reject'){
    assert.equal(request.selectionId,pending.selection.selectionId);pending.selection.status='semantic-rejected';pending=null;
    return {schema:'semantic-native-rejection/8',rejected:true,selectionId:request.selectionId};
  }
  if(request.op==='complete'){
    assert.deepEqual(request.public,publicData);assert.deepEqual(request.contexts,contexts);
    const h=RegionExecutionHarness.replay(publicData),completion=h.activation(request.invocationId).controller.completion;
    assert.deepEqual(completion,request.completion);const child=state.children[0];
    child.completion??={schema:'semantic-child-completion/8',session:request.session,invocationId:request.invocationId,
      track:child.track,completion:copy(completion),heap:[],publicDigest:hashAlgorithmData(publicData),contextsDigest:hashAlgorithmData(contexts)};
    track(child.track).status='completed';if(state.status==='waiting')state.status=track(state.track).status='active';
    return {schema:'semantic-native-completion/8',session:request.session,invocationId:request.invocationId,
      completed:true,sessionRetained:true,publicDigest:hashAlgorithmData(publicData),childCompletion:copy(child.completion)};
  }
  if(request.op==='cancel-orchestration'){
    if(pending)pending.selection.status='cancelled';pending=null;
    state.status='cancelled';for(const row of state.tracks)if(row.status!=='completed')row.status='cancelled';return observed();
  }
  if(request.op==='checkpoint'){
    const root=state.children[0],initialPublic={...copy(publicData),timeline:[copy(root.program),copy(root.invocation)]},
      saved={public:copy(publicData),contexts:copy(contexts),unacknowledgedSelection:pending?.selection.selectionId??null,
        orchestration:{initialPublic,origin:state.origin,track:state.track,childBudget:64,maxActive:1,
          children:copy(state.children),decisions:copy(decisions)}};
    const body={schema:'semantic-model-checkpoint/8',equivalence:'verified-model-reexecution',
      initialization:copy(identity),attempts:copy(attempts),sessions:{[state.session]:saved},closedSessions:{},
      engineeringTransportStub:true,stubState:copy(state),stubOperations:copy(operations)};
    return {...body,digest:hashAlgorithmData(body)};
  }
  if(request.op==='restore'){
    const packet=request.checkpoint;assert.equal(packet.engineeringTransportStub,true);
    identity=copy(packet.initialization);state=copy(packet.stubState);attempts=copy(packet.attempts);
    const saved=packet.sessions[state.session];publicData=copy(saved.public);contexts=copy(saved.contexts);
    decisions=copy(saved.orchestration.decisions);operations=copy(packet.stubOperations);
    return {schema:'semantic-model-restore/8',restored:true,equivalence:'verified-model-reexecution',
      checkpointDigest:packet.digest,restoredSessions:1,consumedAttempts:attempts.length,
      reexecutedSelections:attempts.filter(row=>row.status==='committed').length,hostDispatches:0};
  }
  if(request.op==='cancel')return {schema:'semantic-native-close/8',session:request.session,closed:true,reason:request.reason};
  throw new Error('Unknown stub RPC '+request.op);
}
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);if(process.env.V8_STUB_LOG)appendFileSync(process.env.V8_STUB_LOG,JSON.stringify(request)+'\n');
  try{process.stdout.write(JSON.stringify({id:request.id,ok:true,result:run(request)})+'\n');}
  catch(error){process.stdout.write(JSON.stringify({id:request.id,ok:false,error:{category:error.name,message:error.message}})+'\n');}
}
