import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {prepareRegionFamilyRegistry,bindRegionFamilySplit} from '../src/semantic/dataset-v8.js';
import {exportCanonicalTinkerExample, readableAgentMessages, exportAgentTinkerExample} from '../src/training/tinker-import.js';

const task = {id: 'agent-add', family: 'agent-addition',
  source: '"use strict";function run(x){return x+1;}', entry: 'run', args: [4], fixture: {calls: []}};
const trajectory = () => ({task, messages: [
  {role: 'system', content: 'Use JavaScript to answer the request.'},
  {role: 'user', content: 'Add one to four.'},
  {role: 'assistant', content: 'I will calculate it.', tool_calls: [
    {id: 'private-routing-id-937', type: 'function',
      function: {name: 'javascript', arguments: JSON.stringify({code: '4 + 1'})}},
  ]},
  {role: 'tool', tool_call_id: 'private-routing-id-937', name: 'javascript',
    content: '5', trainable: true},
  {role: 'assistant', content: 'The result is 5.'},
]});

test('agent imports preserve causal JS call/result turns and mask actual observations', () => {
  const result = readableAgentMessages(trajectory());
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.messages.map(row => row.trainable), [false, false, true, false, true]);
  assert.match(result.messages[2].content, /Call javascript/);
  assert.match(result.messages[2].content, /4 \+ 1/);
  assert.match(result.messages[3].content, /External observation from javascript for arguments .*:\n5/);
  assert(!JSON.stringify(result.messages).includes('private-routing-id-937'));
  assert(!result.messages[0].content.includes('External observation'));
});

test('agent imports reject observations before calls and missing or duplicated results', () => {
  const early = trajectory();
  [early.messages[2], early.messages[3]] = [early.messages[3], early.messages[2]];
  assert.throws(() => readableAgentMessages(early), /earlier outstanding call/);
  const missing = trajectory();
  missing.messages.splice(3, 1);
  assert.throws(() => readableAgentMessages(missing), /outstanding observations/);
  const duplicated = trajectory();
  duplicated.messages.splice(4, 0, duplicated.messages[3]);
  assert.throws(() => readableAgentMessages(duplicated), /earlier outstanding call/);
  const mismatched = trajectory();
  mismatched.messages[3].name = 'another_tool';
  assert.throws(() => readableAgentMessages(mismatched), /differs/);
});

test('agent conversation import retains an independently runnable source task without claiming agent success', async () => {
  const exported = await exportAgentTinkerExample(trajectory());
  assert.equal(exported.metadata.sourceVerified, true);
  assert.equal(exported.metadata.agentTaskSuccessVerified, false);
  assert.equal(exported.metadata.sourceVerificationScope, 'attached-executor-task-only');
  assert(exported.sourceHashes.includes(exported.sourceHash));
  assert(exported.sourceHashes.length >= 3);
  assert.equal(exported.metadata.externalObservationsTrainable, false);
  assert.equal(exported.task.family, task.family);
  assert.equal(exported.messages.at(-1).content, 'The result is 5.');
  assert(!Object.hasOwn(exported.task, 'agentTrajectory'));
  assert(!JSON.stringify(exported.messages).includes('sidecar'));
});

test('canonical V8 source is rechecked and imported without runtime records or private sidecars', async () => {
  const verified = await verifyRegionTrainingCase({...task, id: 'canonical-add', family: 'canonical-addition'});
  assert(verified.exported, verified.reason);
  const imported = await exportCanonicalTinkerExample(verified.exported, {id: 'canonical-readable'});
  assert.equal(imported.id, 'canonical-readable');
  assert.equal(imported.family, verified.exported.sidecar.sourceFamily);
  assert.equal(imported.metadata.canonicalSourceRechecked, true);
  assert.equal(imported.metadata.canonicalAdmissionClaim, false);
  assert.match(imported.messages.at(-1).content, /"value":5/);
  const text = JSON.stringify(imported.messages);
  for (const privateName of ['sourceArtifactDigest', 'prefixDigest', 'invocationId', 'sidecar', 'nativeAdmission'])
    assert(!text.includes(privateName), privateName + ' leaked');
  await assert.rejects(exportCanonicalTinkerExample(verified.exported, {family: 'relabeled'}), /cannot be relabeled/);
  assert.equal(imported.metadata.canonicalDatasetBinding, null);
  assert.equal(Object.hasOwn(imported.task, 'split'), false);
  const fixture = {...task, id: 'canonical-add', family: 'canonical-addition'};
  const candidate = {...fixture, ...verified};
  const {registry,members} = prepareRegionFamilyRegistry([candidate], {seed:17, families:[fixture.family]});
  const bound = bindRegionFamilySplit(candidate,members[0],registry);
  const heldout = await exportCanonicalTinkerExample(bound, {id:'held-out-canonical'});
  assert.equal(heldout.task.split, 'test');
  assert.equal(heldout.metadata.canonicalDatasetBinding.split, 'test');
  assert(heldout.task.ancestors.some(value => value.startsWith('canonical-component:')));
  const relabeled = structuredClone(bound);
  relabeled.sidecar.splitIdentity.split = 'train';
  await assert.rejects(exportCanonicalTinkerExample(relabeled));
  const changed = structuredClone(verified.exported);
  changed.sidecar.sourceArtifact.sidecar.referenceInput.inputGraph.roots[0] = ['num', 99];
  await assert.rejects(exportCanonicalTinkerExample(changed));
});

test('parallel same-tool observations keep argument context after private IDs are removed', () => {
  const input = trajectory();
  input.messages[2].tool_calls.push({id:'second-private-id',type:'function',
    function:{name:'javascript',arguments:JSON.stringify({code:'8 + 1'})}});
  input.messages.splice(3,0,{role:'tool',tool_call_id:'second-private-id',name:'javascript',content:'9'});
  const exported = readableAgentMessages(input);
  assert.match(exported.messages[3].content,/8 \+ 1/);
  assert.match(exported.messages[3].content,/:\n9$/);
  assert.match(exported.messages[4].content,/4 \+ 1/);
  assert.match(exported.messages[4].content,/:\n5$/);
  assert(!JSON.stringify(exported.messages).includes('private-id'));
  assert.equal(exported.sourceHashes.length,4);
});

test('agent source identities normalize whitespace and comments across families', () => {
  const original = trajectory(), changed = trajectory();
  changed.messages[2].tool_calls[0].function.arguments=JSON.stringify({code:'4 /* comment */+1'});
  assert.deepEqual(readableAgentMessages(original).sourceHashes,readableAgentMessages(changed).sourceHashes);
});
