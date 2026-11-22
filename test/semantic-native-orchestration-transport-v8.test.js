// These controls exercise the JSONL producer contract with a deterministic
// protocol peer. They are not evidence of real model selection or task success.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {runSelectedRegionOrchestrationV8} from '../src/semantic/selected-orchestration-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {nativeV8OrchestrationContext} from '../src/semantic/native-orchestration-transport-v8.js';

const repository=dirname(dirname(fileURLToPath(import.meta.url)));
const explicitMegatokenRoot=Object.hasOwn(process.env,'MEGATOKEN_ROOT');
const configuredMegatokenRoot=explicitMegatokenRoot?process.env.MEGATOKEN_ROOT:process.env.MEGATOKEN_REPOSITORY;
const megatokenRepository=configuredMegatokenRoot?resolve(configuredMegatokenRoot):resolve(repository,'../megatoken');
const python=process.env.MEGATOKEN_PYTHON??process.env.PYTHON??'python3';
const pythonDeps=process.env.MEGATOKEN_PYTHON_DEPS??resolve(repository,'../python-deps');
const artifact=JSON.parse(readFileSync(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)))
  .examples.find(row=>row.id==='ordered-map');
const identity={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),seed:17};
const programModule=new URL('../src/semantic/program.js',import.meta.url).href;
const contextInstruction='Emit one JSON object {name,arguments}. Allowed actions are track_create, track_join, track_progress, track_complete and track_cancel. Copy a declared execution binding exactly into track_create, with purpose, completion, capabilities and budget. Join only this coordinator\'s issued child dependency. Progress must contain the exact JSON {kind,value} of a delivered child completion. Complete only after all declared children have delivered and published results. Other lifecycle actions are outside this bounded profile.';
const completion={kind:'return',value:['num',7]};

function ingress(childCount=1){
  const publicData={...artifact.public,timeline:artifact.public.timeline.slice(0,2).map(row=>structuredClone(row))};
  for(let index=1;index<childCount;index++){
    const invocation=structuredClone(publicData.timeline.find(row=>row.kind==='invocation')),
      fields=invocation.fields,oldId=fields.inputGraph.objects[0]?.id??'o2',newId='o'+(index+2);
    invocation.sequence=publicData.timeline.length+1;
    fields.track='worker'+(index+1);fields.invocationId='invocation'+(index+1);
    fields.triggerId='teacher-entry-'+(index+1);fields.ingressKey=fields.triggerId;fields.realmId='realm'+(index+1);
    fields.inputGraph.roots=fields.inputGraph.roots.map(value=>
      value[0]==='ref'&&value[1]===oldId?['ref',newId]:value);
    fields.inputGraph.objects=fields.inputGraph.objects.map(object=>({...object,id:newId}));
    publicData.timeline.push(invocation);
  }
  return publicData;
}

function expectedBinding(publicData,track,invocationId){
  const program=publicData.timeline.find(row=>row.kind==='program'),invocation=publicData.timeline.find(row=>
    row.kind==='invocation'&&(invocationId===undefined||row.fields.invocationId===invocationId));
  const source=program.fields,input=invocation.fields;
  return {schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
    entry:input.entry,invocation_id:input.invocationId,realm_id:input.realmId,trigger_id:input.triggerId,
    input_ref:hashAlgorithmData(input.inputGraph),realm_policy:input.realmPolicy,
    completion_mode:input.completionPolicy,capability_grants:structuredClone(source.capabilities),
    completion_target:track};
}

function fakeServer({meridian='number',tamper='',childRecords=[]}={}){
  const selectionTamper={model:"selection.checkpointIdentity='f'.repeat(64);",
    context:"selection.contextDigest='f'.repeat(64);",payload:"selection.payloadHex='00';"}[tamper]??'';
  const creationTamper={owner:"outcome.track.parent='track:forged';",
    dependency:"outcome.completion_dependency.invocation='foreign';"}[tamper]??'';
  const completionTamper=tamper==='completion'?"receipt.contextsDigest='f'.repeat(64);":'';
  return `import {createInterface} from 'node:readline';
    import {isDeepStrictEqual} from 'node:util';
    import {hashAlgorithmData} from ${JSON.stringify(programModule)};
    const clone=structuredClone, identitySeed=${JSON.stringify(identity)}, childRecords=${JSON.stringify(childRecords)};
    const plan=['track_create','track_join','track_progress','track_complete'];
    const completion=${JSON.stringify(completion)};
    let modelIdentity=null, orchestration=null, closedSessions={}, nativeAttempts=[], nextSelection=0, childPositions={};
    const pending=new Map(), receipts=[];
    function binding(publicData,track,invocationId){
      const program=publicData.timeline.find(row=>row.kind==='program');
      const invocation=publicData.timeline.find(row=>row.kind==='invocation'&&
        (invocationId===undefined||row.fields.invocationId===invocationId));
      const source=program.fields, input=invocation.fields;
      return {schema:'semantic-execution-binding/4',program_id:source.programId,source_digest:source.digest,
        entry:input.entry,invocation_id:input.invocationId,realm_id:input.realmId,trigger_id:input.triggerId,
        input_ref:hashAlgorithmData(input.inputGraph),realm_policy:input.realmPolicy,
        completion_mode:input.completionPolicy,capability_grants:clone(source.capabilities),completion_target:track};
    }
    function coordinator(){return {address:orchestration.track,purpose:'Execute the declared V8 child tasks and publish their exact results',
      label:'',parent:null,completion:'All declared children completed and their exact results were published',
      capabilities:['text'],budget:389,revision:0,status:orchestration.status,prerequisites:[],progress:'',
      execution:null,bootstrap_ready:false};}
    function trackRows(){return [coordinator(),...(orchestration.child? [clone(orchestration.child)]:[])];}
    function status(){return {schema:'semantic-orchestration-state/8',session:orchestration.session,track:orchestration.track,
      origin:'model',sourceAdmissionClaim:false,status:orchestration.status,children:clone(orchestration.children),
      decisions:clone(orchestration.decisions),tracks:trackRows(),receipts:clone(receipts),published:clone(orchestration.published),
      publicDigest:orchestration.publicDigest,pendingSelection:orchestration.pendingSelection};}
    function context(){const s=status();return {schema:'semantic-orchestration-context/8',session:s.session,track:s.track,
      children:s.children,tracks:s.tracks,receipts:s.receipts,published:s.published,publicDigest:s.publicDigest,
      instruction:${JSON.stringify(contextInstruction)}};}
    function selectedAction(){
      const child=orchestration.children[0],invocation=child.execution.invocation_id;
      switch(plan[orchestration.decisions.length]){
        case 'track_create':return {name:'track_create',arguments:{purpose:'Run the exact declared V8 source',
          completion:'Deliver its exact result',budget:64,capabilities:['text'],execution:clone(child.execution)}};
        case 'track_join':return {name:'track_join',arguments:{address:orchestration.track,
          completion_dependency:clone(orchestration.dependency)}};
        case 'track_progress':return {name:'track_progress',arguments:{address:orchestration.track,
          progress:JSON.stringify(orchestration.childCompletion??completion)}};
        case 'track_complete':return {name:'track_complete',arguments:{address:orchestration.track}};
        default:throw new Error('fake action plan exhausted');
      }
    }
    function save(){return {orchestration:clone(orchestration)};}
    function checkpoint(){const body={schema:'semantic-model-checkpoint/8',equivalence:'verified-model-reexecution',
      contractDigest:'a'.repeat(64),initialization:clone(modelIdentity),settings:{},randomState:{},
      attempts:clone(nativeAttempts),openings:[],sessions:{},closedSessions:clone(closedSessions)};
      if(orchestration&&!Object.hasOwn(closedSessions,orchestration.session))body.sessions[orchestration.session]=save();
      body.digest=hashAlgorithmData(body);return body;}
    function typedCompletion(request){const child=orchestration.children.find(item=>
      item.execution.invocation_id===request.invocationId);
      if(!child?.track)throw new Error('completion has no declared child track');
      const receipt={schema:'semantic-child-completion/8',session:request.session,invocationId:request.invocationId,
        track:child.track,completion:clone(request.completion??completion),heap:[],publicDigest:hashAlgorithmData(request.public),
        contextsDigest:hashAlgorithmData(request.contexts)};
      ${completionTamper}
      if(!child.completion){child.completion=clone(receipt);orchestration.childCompletion=clone(receipt.completion);
        orchestration.child.status='completed';
        orchestration.status='active';orchestration.publicDigest=hashAlgorithmData(request.public);
        const dependency=orchestration.dependency;
        receipts.push({schema:'semantic-completion/4',dependency:clone(dependency),kind:receipt.completion.kind,
          value:clone(receipt.completion.value),parent:orchestration.track,target:orchestration.track});}
      // The protocol peer returns its retained original receipt; the JavaScript
      // transport, not this fixture, rejects an altered retry payload.
      return {schema:'semantic-native-completion/8',session:request.session,invocationId:request.invocationId,
        completed:true,sessionRetained:!Object.hasOwn(closedSessions,request.session),
        publicDigest:hashAlgorithmData(request.public),childCompletion:clone(child.completion)};
    }
    for await (const line of createInterface({input:process.stdin})){
      const request=JSON.parse(line);let result;
      if(request.op==='initialize'){
        modelIdentity={schema:'semantic-inference-identity/8',adapter:'native-semantic-v8/1',seed:request.seed,
          checkpointIdentity:request.checkpointIdentity,tokenizerIdentity:request.tokenizerIdentity,
          trainingIdentity:request.trainingIdentity??null,nativeAdmissionClaim:false,generationSettings:{device:'test-runtime',
          maxTokens:512,maxFragments:64,effort:1}};result=clone(modelIdentity);
      }else if(request.op==='open-orchestration'){
        const track='track:0', publicData=clone(request.public), program=publicData.timeline.find(row=>row.kind==='program'),
          children=publicData.timeline.filter(row=>row.kind==='invocation').map(invocation=>({program:clone(program),
            invocation:clone(invocation),execution:binding(publicData,track,invocation.fields.invocationId),track:null,completion:null}));
        orchestration={session:request.session,initialPublic:publicData,track,origin:'model',maxActive:request.maxActive,
          childBudget:request.childBudget,status:'active',children,decisions:[],operations:[],published:[],cancelled:null,
          publicDigest:hashAlgorithmData(publicData),pendingSelection:null,child:null,dependency:null};
        closedSessions={};receipts.length=0;result=status();
      }else if(request.op==='status-orchestration')result=status();
      else if(request.op==='select-orchestration'){
        if(request.session!==orchestration.session||request.track!==orchestration.track)throw new Error('wrong coordinator');
        const action=selectedAction(),record=JSON.stringify(action),bytes=Buffer.from(record,'utf8'),
          index=nextSelection++,selectionId='v8:'+index,ctx=context(),selection={family:'orchestration',
          selectionId,session:request.session,invocationId:null,checkpointIdentity:modelIdentity.checkpointIdentity,
          tokenizerIdentity:modelIdentity.tokenizerIdentity,trainingIdentity:modelIdentity.trainingIdentity,
          modelSelected:true,origin:'actual-model-selected',contextDigest:hashAlgorithmData(ctx),
          publicDigest:orchestration.publicDigest,payloadHex:bytes.toString('hex'),fragments:[{selectedEventId:'e:'+index,
          meridian:${meridian === 'number' ? '7' : JSON.stringify(meridian)},modelTrack:request.track,
          payloadHex:bytes.toString('hex'),tokenIds:[...bytes],emittedTokenIds:[...bytes],terminal:true}]};
        ${selectionTamper}
        nativeAttempts.push({selectionId,session:request.session,status:'awaiting-commit',family:'orchestration'});
        pending.set(selectionId,{action,record,selection});orchestration.pendingSelection=selectionId;
        result={schema:'semantic-orchestration-output/8',record,selection};
      }else if(request.op==='select'){
        const invocationId=request.context.invocationId,index=childPositions[invocationId]??0,record=childRecords[index];
        if(typeof record!=='string')throw new Error('child semantic fixture exhausted');
        childPositions[invocationId]=index+1;
        const bytes=Buffer.from(record,'utf8'),selectionId='v8:'+nextSelection++,track=
          orchestration.children.find(item=>item.execution.invocation_id===invocationId)?.track;
        const selection={selectionId,session:request.session,invocationId,
          checkpointIdentity:modelIdentity.checkpointIdentity,tokenizerIdentity:modelIdentity.tokenizerIdentity,
          trainingIdentity:modelIdentity.trainingIdentity,origin:'actual-model-selected',modelSelected:true,
          prefixDigest:request.context.prefixDigest,contextDigest:hashAlgorithmData(request.context),
          publicDigest:hashAlgorithmData(request.public),payloadHex:bytes.toString('hex'),fragments:[{
            selectedEventId:'child:'+selectionId,meridian:9,modelTrack:track,payloadHex:bytes.toString('hex'),
            tokenIds:[...bytes],emittedTokenIds:[...bytes],terminal:true}]};
        nativeAttempts.push({selectionId,session:request.session,invocationId,status:'awaiting-commit'});
        pending.set(selectionId,{semantic:true,record,selection});
        result={schema:'semantic-model-output/8',record,selection};
      }else if(request.op==='commit'){
        const item=pending.get(request.selection?.selectionId);
        if(!item?.semantic||item.record!==request.record||!isDeepStrictEqual(item.selection,request.selection))
          throw new Error('changed original child selection');
        pending.delete(request.selection.selectionId);
        const attempt=nativeAttempts.find(row=>row.selectionId===request.selection.selectionId);attempt.status='committed';
        result={schema:'semantic-native-commit/8',selectionId:request.selection.selectionId,committed:true,
          publicDigest:hashAlgorithmData(request.public)};
      }else if(request.op==='commit-orchestration'){
        const old=orchestration.decisions.find(item=>item.selectionId===request.selection?.selectionId);
        if(old){if(old.record!==request.record||!isDeepStrictEqual(old.selection,request.selection))throw new Error('changed retry');result=clone(old.outcome);}
        else{
          const item=pending.get(request.selection?.selectionId);
          if(!item||item.record!==request.record||!isDeepStrictEqual(item.selection,request.selection))throw new Error('changed original selection');
          const name=item.action.name;let description,outcome;
          if(name==='track_create'){
            const bindingValue=item.action.arguments.execution;
            if(!isDeepStrictEqual(bindingValue,orchestration.children[0].execution))throw new Error('changed child binding');
            const receiptBinding=orchestration.children[${tamper === 'swapped-child' ? '1' : '0'}].execution;
            description={address:'track:1',purpose:item.action.arguments.purpose,label:'',parent:orchestration.track,
              completion:item.action.arguments.completion,capabilities:['text'],budget:64,revision:0,status:'waiting',
              prerequisites:[],progress:'',execution:clone(receiptBinding),bootstrap_ready:false};
            orchestration.children[0].track='track:1';orchestration.child=clone(description);
            orchestration.dependency={schema:'semantic-completion-dependency/4',id:'completion:track:1:0',
              track:'track:1',revision:0,invocation:receiptBinding.invocation_id};
            outcome={schema:'semantic-orchestration-commit/8',selectionId:item.selection.selectionId,
              committed:true,track:clone(description),completion_dependency:clone(orchestration.dependency)};
            ${creationTamper}
          }else if(name==='track_join'){
            if(!isDeepStrictEqual(item.action.arguments.completion_dependency,orchestration.dependency))throw new Error('changed dependency');
            orchestration.status='waiting';orchestration.child.status='active';
            description=coordinator();outcome={schema:'semantic-orchestration-commit/8',
              selectionId:item.selection.selectionId,committed:true,track:clone(description)};
          }else if(name==='track_progress'){
            orchestration.published.push(orchestration.children[0].execution.invocation_id);
            orchestration.child.progress=item.action.arguments.progress;description=coordinator();
            outcome={schema:'semantic-orchestration-commit/8',selectionId:item.selection.selectionId,
              committed:true,track:clone(description)};
          }else if(name==='track_complete'){
            orchestration.status='completed';orchestration.child.status='completed';
            description=coordinator();outcome={schema:'semantic-orchestration-commit/8',
              selectionId:item.selection.selectionId,committed:true,track:clone(description)};
          }else throw new Error('unknown action');
          orchestration.decisions.push({selectionId:item.selection.selectionId,record:item.record,
            selection:clone(item.selection),outcome:clone(outcome)});
          orchestration.pendingSelection=null;pending.delete(item.selection.selectionId);
          const attempt=nativeAttempts.find(row=>row.selectionId===item.selection.selectionId);attempt.status='committed';
          result=outcome;
        }
      }else if(request.op==='bootstrap-orchestration-child'){
        const child=orchestration.children.find(item=>item.track===request.childTrack);
        if(!child)throw new Error('unknown child');
        orchestration.child.bootstrap_ready=true;
        result={schema:'semantic-orchestration-bootstrap/8',bootstrapped:true,track:clone(orchestration.child)};
      }else if(request.op==='cancel-orchestration'){
        orchestration.status='cancelled';orchestration.cancelled=request.reason;
        for(const item of orchestration.children)if(item.track)orchestration.child.status='cancelled';
        const receipt={schema:'semantic-orchestration-cancel/8',track:orchestration.track,reason:request.reason};
        receipts.push(receipt);orchestration.pendingSelection=null;
        if(pending.size){const item=[...pending.values()][0];
          const attempt=nativeAttempts.find(row=>row.selectionId===item.selection.selectionId);attempt.status='cancelled';
          pending.clear();}
        result=status();
      }else if(request.op==='complete')result=typedCompletion(request);
      else if(request.op==='checkpoint')result=checkpoint();
      else if(request.op==='restore'){
        modelIdentity=clone(request.checkpoint.initialization);nativeAttempts=clone(request.checkpoint.attempts);
        closedSessions=clone(request.checkpoint.closedSessions??{});
        const all={...request.checkpoint.sessions,...closedSessions},entry=Object.values(all)[0];
        orchestration=entry?.orchestration?clone(entry.orchestration):null;
        if(orchestration){orchestration.child=orchestration.children[0]?.track?{
          address:orchestration.children[0].track,purpose:'Run the exact declared V8 source',label:'',
          parent:orchestration.track,completion:'Deliver its exact result',capabilities:['text'],budget:64,
          revision:0,status:orchestration.cancelled?'cancelled':orchestration.status==='completed'?'completed':'active',
          prerequisites:[],progress:'',execution:clone(orchestration.children[0].execution),
          bootstrap_ready:true}:null;}
        result={schema:'semantic-model-restore/8',checkpointDigest:request.checkpoint.digest,
          equivalence:'verified-model-reexecution',restored:true,restoredSessions:Object.keys(request.checkpoint.sessions).length,
          consumedAttempts:nativeAttempts.length,hostDispatches:0};
      }else if(request.op==='cancel'){
        if(orchestration&&request.session===orchestration.session){closedSessions[request.session]=save();}
        result={schema:'semantic-native-close/8',session:request.session,closed:true,reason:request.reason};
      }else throw new Error('unsupported RPC '+request.op);
      const encoded=JSON.stringify({id:request.id,ok:true,result})+'\\n';
      process.stdout.write(encoded.slice(0,11));await new Promise(resolve=>setTimeout(resolve,1));
      process.stdout.write(encoded.slice(11));
    }`;
}

function selector(options={}){
  return createNativeV8ProcessSelector({command:process.execPath,args:['--input-type=module','-e',fakeServer(options)],timeoutMs:5000});
}

function pythonContract(publicData){
  if(!existsSync(join(megatokenRepository,'src/megatoken/semantic_orchestration_v8.py')))return null;
  const script=`import json,sys,threading\nfrom dataclasses import asdict\nfrom types import SimpleNamespace\nfrom megatoken.execution_context import execution_binding\nfrom megatoken.lifecycle import TrackRegistry\nfrom megatoken.semantic_orchestration_v8 import _context, validate_ingress, status_orchestration\npublic=json.load(sys.stdin)\nsession=public['timeline'][0]['fields']['session']\nchildren=validate_ingress(session,public,max_active=1,child_budget=64)\nregistry=TrackRegistry(max_active=1)\ncoordinator=registry.create('Execute the declared V8 child tasks and publish their exact results',budget=100)\nchildren[0]['execution']=json.loads(json.dumps(asdict(execution_binding(**children[0],completion_target=coordinator.address))))\nchildren[0].update(track=None,completion=None)\norchestration={'schema':'semantic-orchestration/8','initialPublic':public,'maxActive':1,'childBudget':64,'origin':'model','track':coordinator.address,'children':children,'decisions':[],'operations':[],'published':[],'cancelled':None}\nwork=SimpleNamespace(runtime=SimpleNamespace(tracks=registry,completed_events=set(),execution_receipts=[]),orchestration=orchestration,public=public,pending=None)\nadapter=SimpleNamespace(sessions={session:work},lock=threading.RLock())\nstate=status_orchestration(adapter,session=session,track=coordinator.address)\ncontext=_context(adapter,session,coordinator.address)\nfrom megatoken.data.semantic_json import stable_algorithm_hash\nprint(json.dumps({'state':state,'context':context,'binding':children[0]['execution'],'digest':stable_algorithm_hash(context)}))`;
  const env={...process.env,PYTHONPATH:[pythonDeps,join(megatokenRepository,'src'),process.env.PYTHONPATH]
    .filter(Boolean).join(delimiter)};
  return spawnSync(python,['-c',script],{cwd:megatokenRepository,env,input:JSON.stringify(publicData),
    encoding:'utf8',timeout:30000});
}

test('V8 coordinator JSONL fixture preserves child bindings, original bytes, typed commits and closed retry',async()=>{
  const select=selector(),publicData=ingress(),session=publicData.timeline[0].fields.session;
  try{
    await select.initialize(identity);
    const opened=await select.openOrchestration({session,public:publicData,childBudget:64});
    assert.equal(opened.schema,'semantic-orchestration-state/8');
    assert.deepEqual(opened.children[0].execution,expectedBinding(publicData,opened.track));

    const chosen=await select.selectOrchestration({session,track:opened.track});
    assert.equal(chosen.schema,'semantic-orchestration-output/8');
    assert.deepEqual(Buffer.from(chosen.selection.payloadHex,'hex'),Buffer.from(chosen.record,'utf8'));
    assert.deepEqual(chosen.selection.fragments.map(fragment=>fragment.payloadHex).join(''),chosen.selection.payloadHex);
    assert.equal(chosen.selection.fragments[0].meridian,7,'Python meridian_id is an integer');
    const pendingState=await select.statusOrchestration({session,track:opened.track});
    assert.equal(chosen.selection.contextDigest,hashAlgorithmData(nativeV8OrchestrationContext(pendingState)));
    const action=JSON.parse(chosen.record);
    assert.deepEqual(action.arguments.execution,opened.children[0].execution);
    const firstReceipt=await select.commitOrchestration({session,track:opened.track,...chosen});
    assert.equal(firstReceipt.completion_dependency.schema,'semantic-completion-dependency/4');
    assert.deepEqual(await select.commitOrchestration({session,track:opened.track,...chosen}),firstReceipt,
      'lost coordinator acknowledgement can be retried with the original bytes and evidence');
    const childTrack=firstReceipt.track.address;
    assert.equal((await select.bootstrapOrchestrationChild({session,track:opened.track,childTrack})).track.execution.invocation_id,
      opened.children[0].execution.invocation_id);

    const joined=await select.selectOrchestration({session,track:opened.track});
    assert.equal(JSON.parse(joined.record).name,'track_join');
    await select.commitOrchestration({session,track:opened.track,...joined});
    const input={session,public:artifact.public,contexts:artifact.contexts,
      invocationId:artifact.contexts[0].invocationId,completion};
    const delivered=await select.complete(input);
    assert.equal(delivered.childCompletion.track,childTrack);
    assert.deepEqual(delivered.childCompletion.completion,completion);

    const progress=await select.selectOrchestration({session,track:opened.track});
    assert.equal(JSON.parse(progress.record).name,'track_progress');
    await select.commitOrchestration({session,track:opened.track,...progress});
    const finished=await select.selectOrchestration({session,track:opened.track});
    assert.equal(JSON.parse(finished.record).name,'track_complete');
    await select.commitOrchestration({session,track:opened.track,...finished});
    assert.equal((await select.statusOrchestration({session,track:opened.track})).status,'completed');

    await select.cancel({session,reason:'closed after exact completion'});
    const checkpoint=await select.checkpoint(),restored=selector();
    try{
      const recovery=await restored.restore({checkpoint:JSON.parse(JSON.stringify(checkpoint))});
      assert.equal(recovery.restored,true);
      assert.equal(checkpoint.native.closedSessions[session].orchestration.track,opened.track);
      assert.deepEqual(await restored.complete(input),{...delivered,sessionRetained:false});
      assert.deepEqual(await restored.complete(input),{...delivered,sessionRetained:false},
        'closed typed completion retries preserve the exact receipt');
      const altered={...input,completion:{kind:'throw',value:['num',8]}};
      await assert.rejects(restored.complete(altered),/source cut, result, owner or closed-session authority/);
    }finally{restored.close();}
  }finally{select.close();}
});

test('ordinary V8 orchestration driver uses the native JSONL transport for model and child choices',async()=>{
  const publicData=ingress(),childRecords=artifact.public.timeline.filter(row=>row.mode==='generated')
    .map(row=>row.fields.line),select=selector({childRecords});
  try{
    const result=await runSelectedRegionOrchestrationV8({initialPublic:publicData,select,...identity,
      generationSettings:{device:'test-runtime',maxTokens:512,maxFragments:64,effort:1},maxActive:1});
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.finalState.status,'completed');assert.equal(result.publicCompleted,true);
    assert.equal(result.coordinatorAttempts.length,4);assert.equal(result.childAttempts.length,childRecords.length);
    assert.equal(result.completionReceipts.length,1);
    const attempts=select.metrics().attempts,order=attempts.map(row=>row.family==='orchestration'?
      JSON.parse(row.record).name:'child-selection');
    assert.deepEqual(order,['track_create','track_join',...childRecords.map(()=> 'child-selection'),
      'track_progress','track_complete']);
    assert.equal(result.nativeMetrics.nativeAdmissionClaim,false);
    assert.equal(result.nativeMetrics.sourceAdmissionClaim,false);
  }finally{select.close();}
});

test('cancellation discards a pending coordinator candidate and retains the exact receipt',async()=>{
  const select=selector(),publicData=ingress(),session=publicData.timeline[0].fields.session;
  try{
    await select.initialize(identity);
    const opened=await select.openOrchestration({session,public:publicData,childBudget:64});
    const pending=await select.selectOrchestration({session,track:opened.track});
    assert.equal(select.metrics().attempts[0].status,'decoded');
    const cancelled=await select.cancelOrchestration({session,track:opened.track,reason:'operator stopped child work'});
    assert.equal(cancelled.status,'cancelled');
    assert(cancelled.receipts.some(receipt=>receipt.schema==='semantic-orchestration-cancel/8'&&
      receipt.reason==='operator stopped child work'));
    assert.equal(select.metrics().attempts[0].status,'cancelled');
    await assert.rejects(select.commitOrchestration({session,track:opened.track,...pending}),/original coordinator selection/);
  }finally{select.close();}
});

test('noninteger or altered coordinator fragment provenance is refused',async()=>{
  const select=selector({meridian:'7'}),publicData=ingress(),session=publicData.timeline[0].fields.session;
  try{
    await select.initialize(identity);
    const opened=await select.openOrchestration({session,public:publicData,childBudget:64});
    await assert.rejects(select.selectOrchestration({session,track:opened.track}),/native track evidence changed/);
    assert.equal(select.metrics().attempts[0].status,'failed');
  }finally{select.close();}
});

test('creation acknowledgement cannot substitute another declared child binding',async()=>{
  const select=selector({tamper:'swapped-child'}),publicData=ingress(2),session=publicData.timeline[0].fields.session;
  try{
    await select.initialize(identity);
    const opened=await select.openOrchestration({session,public:publicData,childBudget:64});
    assert.equal(opened.children.length,2);
    const selected=await select.selectOrchestration({session,track:opened.track});
    const action=JSON.parse(selected.record);
    assert.deepEqual(action.arguments.execution,opened.children[0].execution);
    assert.notDeepEqual(opened.children[0].execution,opened.children[1].execution);
    await assert.rejects(select.commitOrchestration({session,track:opened.track,...selected}),
      /source binding, owner or completion dependency/);
  }finally{select.close();}
});

test('Python and JavaScript V8 coordinator contexts and child bindings agree',t=>{
  const result=pythonContract(ingress());
  if(result===null){
    if(explicitMegatokenRoot)assert.fail('MEGATOKEN_ROOT does not contain the paired V8 consumer');
    t.skip('paired megatoken checkout is unavailable');return;
  }
  assert.equal(result.status,0,result.stderr);
  const python=JSON.parse(result.stdout),jsContext=nativeV8OrchestrationContext(python.state);
  assert.deepEqual(jsContext,python.context);
  assert.equal(hashAlgorithmData(jsContext),python.digest);
  assert.deepEqual(expectedBinding(ingress(),python.state.track),python.binding);
  assert.equal(python.state.sourceAdmissionClaim,false);
});

test('transport refuses altered model/context/payload and forged lifecycle receipts',async()=>{
  const cases=[
    {tamper:'model',phase:'select',message:/frozen model and current task context/},
    {tamper:'context',phase:'select',message:/frozen model and current task context/},
    {tamper:'payload',phase:'select',message:/original bytes, tokens or native track evidence/},
    {tamper:'owner',phase:'commit',message:/source binding, owner or completion dependency/},
    {tamper:'dependency',phase:'commit',message:/source binding, owner or completion dependency/},
    {tamper:'completion',phase:'completion',message:/source cut, result, owner or closed-session authority/},
  ];
  for(const item of cases){
    const select=selector({tamper:item.tamper}),publicData=ingress(),session=publicData.timeline[0].fields.session;
    try{
      await select.initialize(identity);
      const opened=await select.openOrchestration({session,public:publicData,childBudget:64});
      const selected=await select.selectOrchestration({session,track:opened.track});
      if(item.phase==='select'){
        assert.fail('mutated native selection unexpectedly passed: '+item.tamper);
      }else if(item.phase==='completion'){
        await select.commitOrchestration({session,track:opened.track,...selected});
        await select.bootstrapOrchestrationChild({session,track:opened.track,childTrack:'track:1'});
        await assert.rejects(select.complete({session,public:artifact.public,contexts:artifact.contexts,
          invocationId:artifact.contexts[0].invocationId}),item.message);
      }else{
        await assert.rejects(select.commitOrchestration({session,track:opened.track,...selected}),item.message);
      }
    }catch(error){
      if(item.phase==='select'&&item.message.test(error.message))continue;
      throw error;
    }finally{select.close();}
  }
});
