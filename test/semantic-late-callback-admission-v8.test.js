import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {lateCallbackFixture} from './helpers/late-callback-fixture-v8.js';
import {deriveCallbackAdmissionV8} from '../src/semantic/orchestration-callback-v8.js';
import {verifyNativeV8DurableCommit} from '../src/semantic/native-durable-commit-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const original=JSON.parse(gunzipSync(Buffer.from(readFileSync(new URL(
  './fixtures/late-callback-native-admission-v8.json.gz.b64',import.meta.url),'utf8'),'base64'))),
  sha=bytes=>createHash('sha256').update(bytes).digest('hex'),copy=structuredClone;
// The full original native intent/outcome is retained in native a390b279's
// successor proof. Only the deterministic outer RPC envelope is rebuilt here.
function pair(){
  const source=copy(original),outcome=source.outcome,pre=outcome.preCheckpoint,post=outcome.postCheckpoint,
    intent={identity:source.identity,requestBase64:source.requestBase64,checkpoint:{native:pre}},
    value={schema:'semantic-native-durable-commit/8',requestId:source.requestId,identity:source.identity,
      requestSha256:outcome.requestSha256,preCheckpointDigest:outcome.preCheckpointDigest,
      postCheckpointDigest:post.digest,responseBase64:outcome.responseBase64,
      responseSha256:sha(Buffer.from(outcome.responseBase64,'base64')),postCheckpoint:post,
      recovered:false,restoreReceipt:null};
  return {intent,value,pre,post,request:JSON.parse(Buffer.from(source.requestBase64,'base64'))};
}

test('original listener and later journal arrival reproduce the actual native admission input',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'late-callback-source-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const fixture=await lateCallbackFixture(directory),{request,pre}=pair();
  assert.deepEqual(fixture.reference,{registrations:1,root:1,callback:5});
  assert.equal(fixture.registrations,1);
  assert.deepEqual(fixture.admissionPublic,request.public);
  assert.deepEqual(fixture.contexts.slice(0,4),request.contexts);
  assert.deepEqual(fixture.rootPublic,pre.sessions[request.session].public);
  assert.equal(fixture.ingressRecords[0].arrival.visibleThrough,fixture.rootPublic.timeline.length);
  assert.equal(fixture.ingressRecords[0].arrival.event.eventId,'after-checkpoint');
});

test('independent producer derivation agrees with the actual native callback outcome',()=>{
  const {intent,value,request,pre}=pair(),before=pre.sessions[request.session],
    derived=deriveCallbackAdmissionV8({session:request.session,state:before.orchestration,
      previousPublic:before.public,previousContexts:before.contexts,completed:before.completed,
      public:request.public,contexts:request.contexts}),verified=verifyNativeV8DurableCommit(value,intent);
  assert.deepEqual(derived.receipt,verified.result);
  assert.deepEqual(derived.child,value.postCheckpoint.sessions[request.session].orchestration.children[1]);
  assert.equal(verified.result.execution.input_ref,hashAlgorithmData(request.public.timeline.at(-1).fields.inputGraph));
});

for(const field of ['sourceDigest','parentInvocationId','realmId','closureId','entry','triggerId','track'])
  test('original callback refuses changed '+field+' before accepting native authority',()=>{
    const {request,pre}=pair(),before=pre.sessions[request.session];
    request.public.timeline.at(-1).fields[field]=field==='sourceDigest'?'f'.repeat(64):'changed';
    assert.throws(()=>deriveCallbackAdmissionV8({session:request.session,state:before.orchestration,
      previousPublic:before.public,previousContexts:before.contexts,completed:before.completed,
      public:request.public,contexts:request.contexts}));
  });

for(const mutation of ['input','sibling-attempt','duplicate-operation','missing-operation','changed-parent'])
  test('actual native outcome cannot acquire '+mutation+' by resealing its postcheckpoint',()=>{
    const {intent,value,request}=pair(),post=value.postCheckpoint,state=post.sessions[request.session].orchestration;
    if(mutation==='input')state.children[1].execution.input_ref='f'.repeat(64);
    if(mutation==='sibling-attempt')post.attempts[0].status='rejected';
    if(mutation==='duplicate-operation')state.operations.push(copy(state.operations.at(-1)));
    if(mutation==='missing-operation')state.operations.pop();
    if(mutation==='changed-parent')state.children[1].invocation.fields.parentInvocationId='changed';
    const {digest,...body}=post;post.digest=hashAlgorithmData(body);value.postCheckpointDigest=post.digest;
    assert.throws(()=>verifyNativeV8DurableCommit(value,intent));
  });
