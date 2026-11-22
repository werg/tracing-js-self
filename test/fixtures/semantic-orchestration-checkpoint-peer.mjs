// JSONL protocol peer for the composite orchestration recovery tests. This
// verifies JavaScript transport and restore wiring; the native Python adapter
// independently owns production reexecution verification.
import {createInterface} from 'node:readline';
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from '../../src/semantic/program.js';

const childRecords=JSON.parse(process.argv.at(-1)),copy=structuredClone;
const instruction='Emit one JSON object {name,arguments}. Allowed actions are track_create, track_join, track_progress, track_complete and track_cancel. Copy a declared execution binding exactly into track_create, with purpose, completion, capabilities and budget. Join only this coordinator\'s issued child dependency. Progress must contain the exact JSON {kind,value} of a delivered child completion. Complete only after all declared children have delivered and published results. Other lifecycle actions are outside this bounded profile.';
const completion={kind:'return',value:['num',7]};
let identity=null,orchestration=null,sessionId=null,dependencies=new Map(),currentStatus='active',currentPublic=null,contexts=[],replay=[],completed=[],
  attempts=[],nextSelection=0,closedSessions={},childStatuses=new Map();
const pending=new Map();

function binding(publicData,track,invocationId){
  const program=publicData.timeline.find(row=>row.kind==='program'),invocation=publicData.timeline.find(row=>
    row.kind==='invocation'&&row.fields.invocationId===invocationId),source=program.fields,input=invocation.fields;
  return {schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
    entry:input.entry,invocation_id:input.invocationId,realm_id:input.realmId,trigger_id:input.triggerId,
    input_ref:hashAlgorithmData(input.inputGraph),realm_policy:input.realmPolicy,
    completion_mode:input.completionPolicy,capability_grants:copy(source.capabilities),completion_target:track};
}

function coordinatorTrack(){return {address:orchestration.track,
  purpose:'Execute the declared V8 child tasks and publish their exact results',label:'',parent:null,
  completion:'All declared children completed and their exact results were published',capabilities:['text'],
  budget:389,revision:0,status:currentStatus,prerequisites:[],progress:'',execution:null,bootstrap_ready:false};}

function childTrack(child){
  if(!child.track)return null;
  const bootstrap=orchestration.operations.some(row=>row.kind==='bootstrap'&&row.track===child.track);
  return {address:child.track,purpose:'Run the exact declared V8 source',label:'',parent:orchestration.track,
    completion:'Deliver its exact result',capabilities:['text'],budget:64,revision:0,
    status:child.completion?'completed':childStatuses.get(child.track)??'waiting',
    prerequisites:[],progress:'',execution:copy(child.execution),bootstrap_ready:bootstrap};
}

function status(){
  const tracks=[coordinatorTrack(),...orchestration.children.map(childTrack).filter(Boolean)];
  return {schema:'semantic-orchestration-state/8',session:sessionId,track:orchestration.track,
    origin:'model',sourceAdmissionClaim:false,status:currentStatus,children:copy(orchestration.children),
    decisions:copy(orchestration.decisions),tracks,receipts:orchestration.children.filter(row=>row.completion)
      .map(child=>({schema:'semantic-completion/4',dependency:copy(dependencies.get(child.track)),
        kind:child.completion.completion.kind,value:copy(child.completion.completion.value),
        parent:orchestration.track,target:orchestration.track})),published:copy(orchestration.published),
    publicDigest:hashAlgorithmData(currentPublic),pendingSelection:[...pending.keys()][0]??null};
}

function context(){const state=status();return {schema:'semantic-orchestration-context/8',session:state.session,
  track:state.track,children:state.children,tracks:state.tracks,receipts:state.receipts,published:state.published,
  publicDigest:state.publicDigest,instruction};}

function reorderedJson(value){
  return ' { '+Object.entries(value).reverse().map(([key,item])=>JSON.stringify(key)+': '+JSON.stringify(item)).join(', ')+' } ';
}

function action(){
  const unpublished=orchestration.children.find(child=>child.completion&&
    !orchestration.published.includes(child.execution.invocation_id));
  if(unpublished)return {name:'track_progress',arguments:{address:orchestration.track,
    progress:reorderedJson(unpublished.completion.completion)}};
  const uncreated=orchestration.children.find(child=>!child.track);
  if(uncreated)return {name:'track_create',arguments:{purpose:'Run the exact declared V8 source',
    completion:'Deliver its exact result',budget:64,capabilities:['text'],execution:copy(uncreated.execution)}};
  const unfinished=orchestration.children.find(child=>child.track&&!child.completion);
  if(unfinished)return {name:'track_join',arguments:{address:orchestration.track,
    completion_dependency:copy(dependencies.get(unfinished.track))}};
  return {name:'track_complete',arguments:{address:orchestration.track}};
}

function makeCheckpoint(){
  const session=sessionId,body={schema:'semantic-model-checkpoint/8',
    equivalence:'verified-model-reexecution',contractDigest:'a'.repeat(64),initialization:copy(identity),
    settings:{},randomState:{},attempts:copy(attempts),openings:[{session,metadataTokens:0,metadataBytes:0,openSeconds:0}],
    sessions:closedSessions[session]?{}:{[session]:{public:copy(currentPublic),contexts:copy(contexts),
      ingestedThrough:currentPublic.timeline.length,completed:copy(completed),openingRandom:{},replay:copy(replay),
      continuationDigest:'b'.repeat(64),unacknowledgedSelection:null,orchestration:copy(orchestration)}},
    closedSessions:copy(closedSessions)};
  return {...body,digest:hashAlgorithmData(body)};
}

for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);let result;
  if(request.op==='initialize'){
    identity={schema:'semantic-inference-identity/8',adapter:'native-semantic-v8/1',seed:request.seed,
      checkpointIdentity:request.checkpointIdentity,tokenizerIdentity:request.tokenizerIdentity,
      trainingIdentity:request.trainingIdentity??null,nativeAdmissionClaim:false,
      generationSettings:{device:'test-runtime',maxTokens:512,maxFragments:64,effort:1}};
    result=copy(identity);
  }else if(request.op==='open-orchestration'){
    const track='track:0',program=request.public.timeline.find(row=>row.kind==='program');
    sessionId=request.session;
    currentStatus='active';
    currentPublic=copy(request.public);contexts=[];replay=[];completed=[];attempts=[];nextSelection=0;closedSessions={};
    dependencies=new Map();pending.clear();childStatuses=new Map();
    orchestration={schema:'semantic-orchestration/8',initialPublic:copy(request.public),maxActive:request.maxActive,
      childBudget:request.childBudget,origin:'model',track,children:request.public.timeline
        .filter(row=>row.kind==='invocation').map(invocation=>({program:copy(program),invocation:copy(invocation),
          execution:binding(request.public,track,invocation.fields.invocationId),track:null,completion:null})),
      decisions:[],operations:[],published:[],cancelled:null};
    result=status();
  }else if(request.op==='status-orchestration')result=status();
  else if(request.op==='select-orchestration'){
    if(request.track!==orchestration.track)throw new Error('wrong coordinator track');
    const selected=action(),record=JSON.stringify(selected),bytes=Buffer.from(record),index=nextSelection++,selectionId='v8:'+index,
      current=context(),selection={family:'orchestration',selectionId,session:request.session,invocationId:null,
        checkpointIdentity:identity.checkpointIdentity,tokenizerIdentity:identity.tokenizerIdentity,
        trainingIdentity:identity.trainingIdentity,modelSelected:true,origin:'actual-model-selected',
        contextDigest:hashAlgorithmData(current),publicDigest:hashAlgorithmData(currentPublic),
        payloadHex:bytes.toString('hex'),fragments:[{selectedEventId:'coordinator:'+selectionId,meridian:7,
          modelTrack:orchestration.track,payloadHex:bytes.toString('hex'),tokenIds:[...bytes],
          emittedTokenIds:[...bytes],terminal:true}]};
    attempts.push({...copy(selection),status:'awaiting-commit'});
    pending.set(selectionId,{action:selected,record,selection});
    result={schema:'semantic-orchestration-output/8',record,selection};
  }else if(request.op==='commit-orchestration'){
    const item=pending.get(request.selection.selectionId);
    if(!item||item.record!==request.record||!isDeepStrictEqual(item.selection,request.selection))
      throw new Error('changed coordinator selection');
    const name=item.action.name,index=attempts.findIndex(row=>row.selectionId===request.selection.selectionId);
    let track,outcome;
    if(name==='track_create'){
      const child=orchestration.children.find(row=>row.execution.invocation_id===item.action.arguments.execution.invocation_id),
        address='track:'+ (orchestration.children.indexOf(child)+1);
      if(!child||!isDeepStrictEqual(child.execution,item.action.arguments.execution))throw new Error('wrong binding');
      child.track=address;
      childStatuses.set(address,'waiting');
      track={address,purpose:item.action.arguments.purpose,label:'',parent:orchestration.track,
        completion:item.action.arguments.completion,capabilities:['text'],budget:64,revision:0,status:'waiting',
        prerequisites:[],progress:'',execution:copy(child.execution),bootstrap_ready:false};
      const dependency={schema:'semantic-completion-dependency/4',id:'completion:'+address+':0',
        track:address,revision:0,invocation:child.execution.invocation_id};
      dependencies.set(address,dependency);
      outcome={schema:'semantic-orchestration-commit/8',selectionId:request.selection.selectionId,committed:true,
        track:copy(track),completion_dependency:copy(dependency)};
    }else if(name==='track_join'){
      const dependency=item.action.arguments.completion_dependency;
      if(!isDeepStrictEqual(dependency,dependencies.get(dependency?.track))||
          !orchestration.children.some(child=>child.track===dependency.track&&
            child.execution.invocation_id===dependency.invocation))
        throw new Error('wrong dependency');
      currentStatus='waiting';
      for(const candidate of orchestration.children){
        if(!candidate.track||candidate.completion||childStatuses.get(candidate.track)!=='waiting'||
          !orchestration.operations.some(row=>row.kind==='bootstrap'&&row.track===candidate.track))continue;
        const used=[...childStatuses.values()].filter(value=>value==='active').length;
        if(used>=orchestration.maxActive)break;
        childStatuses.set(candidate.track,'active');
      }
      track=coordinatorTrack();
      outcome={schema:'semantic-orchestration-commit/8',selectionId:request.selection.selectionId,committed:true,track};
    }else if(name==='track_progress'){
      const publishedChild=orchestration.children.find(child=>child.completion&&
        !orchestration.published.includes(child.execution.invocation_id));
      if(!publishedChild)throw new Error('no exact completed child result to publish');
      orchestration.published.push(publishedChild.execution.invocation_id);
      track=coordinatorTrack();
      outcome={schema:'semantic-orchestration-commit/8',selectionId:request.selection.selectionId,committed:true,track};
    }else{
      currentStatus='completed';track=coordinatorTrack();
      outcome={schema:'semantic-orchestration-commit/8',selectionId:request.selection.selectionId,committed:true,track};
    }
    orchestration.decisions.push({selectionId:request.selection.selectionId,selectionDigest:hashAlgorithmData(request.selection),
      record:request.record,outcome:copy(outcome)});
    orchestration.operations.push({kind:'coordinator',attempt:index,randomBefore:{},commitRandom:{}});
    attempts[index].status='committed';pending.delete(request.selection.selectionId);result=outcome;
  }else if(request.op==='bootstrap-orchestration-child'){
    const child=orchestration.children.find(row=>row.track===request.childTrack);
    if(!child)throw new Error('child not reserved');
    const used=(currentStatus==='active'?1:0)+[...childStatuses.values()].filter(value=>value==='active').length;
    childStatuses.set(request.childTrack,used<orchestration.maxActive?'active':'waiting');
    orchestration.operations.push({kind:'bootstrap',track:request.childTrack,randomBefore:{}});
    const receipt={schema:'semantic-orchestration-bootstrap/8',bootstrapped:true,track:childTrack(child)};
    result=receipt;
  }else if(request.op==='select'){
    const invocationId=request.context.invocationId,child=orchestration.children.find(row=>
      row.execution.invocation_id===invocationId),position=attempts.filter(row=>
        row.family===undefined&&row.status==='committed').length,
      record=childRecords[position];
    if(!child||typeof record!=='string')throw new Error('child fixture exhausted');
    const bytes=Buffer.from(record),index=nextSelection++,selectionId='v8:'+index,
      selection={selectionId,session:request.session,invocationId,checkpointIdentity:identity.checkpointIdentity,
        tokenizerIdentity:identity.tokenizerIdentity,trainingIdentity:identity.trainingIdentity,
        origin:'actual-model-selected',modelSelected:true,prefixDigest:request.context.prefixDigest,
        contextDigest:hashAlgorithmData(request.context),publicDigest:hashAlgorithmData(request.public),
        payloadHex:bytes.toString('hex'),fragments:[{selectedEventId:'child:'+selectionId,meridian:9,
          modelTrack:child.track,payloadHex:bytes.toString('hex'),tokenIds:[...bytes],
          emittedTokenIds:[...bytes],terminal:true}]};
    attempts.push({...copy(selection),status:'awaiting-commit'});
    pending.set(selectionId,{semantic:true,record,selection});
    result={schema:'semantic-model-output/8',record,selection};
  }else if(request.op==='reject'){
    const attempt=attempts.find(row=>row.selectionId===request.selectionId);
    if(!attempt||attempt.status!=='awaiting-commit'||!pending.has(request.selectionId))
      throw new Error('no exact candidate can be rejected');
    attempt.status='semantic-rejected';attempt.failure=request.reason;
    pending.delete(request.selectionId);
    result={schema:'semantic-native-rejection/8',selectionId:request.selectionId,rejected:true};
  }else if(request.op==='commit'){
    const item=pending.get(request.selection.selectionId);
    if(!item?.semantic||item.record!==request.record||!isDeepStrictEqual(item.selection,request.selection))
      throw new Error('changed semantic selection');
    const index=attempts.findIndex(row=>row.selectionId===request.selection.selectionId),
      contextIndex=request.contexts.length-1;
    attempts[index].status='committed';pending.delete(request.selection.selectionId);
    currentPublic=copy(request.public);contexts=copy(request.contexts);
    replay.push({attempt:index,contextIndex,acknowledgedThrough:currentPublic.timeline.length,randomBefore:{}});
    orchestration.operations.push({kind:'semantic',replay:replay.length-1});
    result={schema:'semantic-native-commit/8',selectionId:request.selection.selectionId,committed:true,
      publicDigest:hashAlgorithmData(currentPublic)};
  }else if(request.op==='complete'){
    const child=orchestration.children.find(row=>row.execution.invocation_id===request.invocationId),
      receipt={schema:'semantic-child-completion/8',session:request.session,invocationId:request.invocationId,
        track:child.track,completion:copy(request.completion??completion),heap:[],publicDigest:hashAlgorithmData(request.public),
        contextsDigest:hashAlgorithmData(request.contexts)};
    child.completion=copy(receipt);currentPublic=copy(request.public);contexts=copy(request.contexts);
    childStatuses.set(child.track,'completed');
    if(!completed.includes(request.invocationId))completed.push(request.invocationId);currentStatus='active';
    orchestration.operations.push({kind:'completion',invocationId:request.invocationId,
      acknowledgedThrough:request.public.timeline.length,randomBefore:{}});
    result={schema:'semantic-native-completion/8',session:request.session,invocationId:request.invocationId,
      completed:true,sessionRetained:true,publicDigest:hashAlgorithmData(request.public),childCompletion:receipt};
  }else if(request.op==='checkpoint')result=makeCheckpoint();
  else if(request.op==='restore'){
    const checkpoint=request.checkpoint,sessions=Object.keys(checkpoint.sessions??{}),
      tombstones=Object.keys(checkpoint.closedSessions??{});
    identity=copy(checkpoint.initialization);attempts=copy(checkpoint.attempts);nextSelection=attempts.length;
    pending.clear();closedSessions=copy(checkpoint.closedSessions??{});
    if(sessions.length===0){
      if(tombstones.length!==1||!closedSessions[tombstones[0]])throw new Error('invalid closed-session tombstone');
      sessionId=null;currentPublic=null;contexts=[];replay=[];completed=true;orchestration=null;
      childStatuses=new Map();dependencies=new Map();
      result={schema:'semantic-model-restore/8',checkpointDigest:checkpoint.digest,
        equivalence:'verified-model-reexecution',restored:true,restoredSessions:0,
        consumedAttempts:attempts.length,hostDispatches:0};
    }else{
      if(sessions.length!==1||tombstones.length!==0)throw new Error('invalid active session checkpoint');
      const session=sessions[0],saved=checkpoint.sessions[session];
      sessionId=session;currentPublic=copy(saved.public);contexts=copy(saved.contexts);
      replay=copy(saved.replay);completed=copy(saved.completed);orchestration=copy(saved.orchestration);
      dependencies=new Map(orchestration.decisions.filter(row=>row.outcome?.completion_dependency)
        .map(row=>[row.outcome.completion_dependency.track,row.outcome.completion_dependency]));
      currentStatus=orchestration.decisions.at(-1)?.record.includes('track_complete')?'completed':
        orchestration.children.some(row=>row.completion)?'active':
          orchestration.operations.at(-1)?.kind==='coordinator'&&
          orchestration.decisions.at(-1)?.record.includes('track_join')?'waiting':'active';
      childStatuses=new Map();
      const bootstrapped=new Set(orchestration.operations.filter(row=>row.kind==='bootstrap').map(row=>row.track));
      let activeSlots=orchestration.maxActive-(currentStatus==='active'?1:0);
      if(currentStatus==='waiting')activeSlots=orchestration.maxActive;
      for(const child of orchestration.children){
        if(!child.track)continue;
        if(child.completion){childStatuses.set(child.track,'completed');continue;}
        const active=bootstrapped.has(child.track)&&activeSlots>0;
        childStatuses.set(child.track,active?'active':'waiting');
        if(active)activeSlots--;
      }
      result={schema:'semantic-model-restore/8',checkpointDigest:checkpoint.digest,
        equivalence:'verified-model-reexecution',restored:true,restoredSessions:1,
        consumedAttempts:attempts.length,hostDispatches:0};
    }
  }else if(request.op==='cancel'){
    result={schema:'semantic-native-close/8',session:request.session,closed:true,reason:request.reason};
    if(orchestration)closedSessions[request.session]={...makeCheckpoint().sessions[request.session]};
  }else throw new Error('unsupported RPC '+request.op);
  process.stdout.write(JSON.stringify({id:request.id,ok:true,result})+'\n');
}
