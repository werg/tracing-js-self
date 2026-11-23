import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNativeConsumerPolicy} from '../tools/resolve-native-consumer.mjs';

const policy={schema:'semantic-native-policy/8',consumerRepository:'werg/megatoken',tokenizerSha256:'a'.repeat(64)};
const current='b'.repeat(40),main='c'.repeat(40);

test('current native resolution observes the matching branch and retains the exact per-run revision',()=>{
  const calls=[],lookup=(repository,ref)=>{calls.push([repository,ref]);return current;};
  const result=resolveNativeConsumerPolicy(policy,{branch:'codex/living-javascript-coverage',lookup});
  assert.deepEqual(calls,[['werg/megatoken','refs/heads/codex/living-javascript-coverage']]);
  assert.equal(result.policy.consumerRevision,current);
  assert.equal(result.selection.kind,'matching-branch');
  assert.equal(Object.hasOwn(policy,'consumerRevision'),false);
  assert.equal(result.policy.tokenizerSha256,policy.tokenizerSha256);
});

test('only an absent implicit branch falls back to the current default, never a network failure',()=>{
  const calls=[],lookup=(_repository,ref)=>{calls.push(ref);return ref==='HEAD'?main:null;};
  const result=resolveNativeConsumerPolicy(policy,{branch:'unpaired-work',lookup});
  assert.deepEqual(calls,['refs/heads/unpaired-work','HEAD']);
  assert.equal(result.policy.consumerRevision,main);assert.equal(result.selection.kind,'default-head');
  assert.throws(()=>resolveNativeConsumerPolicy(policy,{branch:'paired',lookup:()=>{throw new Error('network failed');}}),/network failed/);
  assert.throws(()=>resolveNativeConsumerPolicy(policy,{explicitRef:'missing',lookup}),/Explicit paired branch/);
  assert.throws(()=>resolveNativeConsumerPolicy(policy,{lookup:()=>null}),/no exact observed revision/);
});

test('historical observations and explicit refs stay exact and unsafe branch names are rejected',()=>{
  const lookup=()=>{throw new Error('recorded revisions must not be re-resolved');};
  const saved={...policy,consumerRevision:current};
  assert.equal(resolveNativeConsumerPolicy(saved,{branch:'changed',lookup}).policy.consumerRevision,current);
  assert.equal(resolveNativeConsumerPolicy(policy,{explicitRef:current,lookup}).policy.consumerRevision,current);
  assert.throws(()=>resolveNativeConsumerPolicy(saved,{explicitRef:main,lookup}),/cannot override/);
  assert.throws(()=>resolveNativeConsumerPolicy({...policy,consumerRevision:null},{lookup}),/recorded consumer revision/);
  for(const branch of ['bad\noutput=x','../main','-bad:ref','refs/heads/bad..ref'])
    assert.throws(()=>resolveNativeConsumerPolicy(policy,{branch,lookup}),/Invalid paired branch/);
  assert.throws(()=>resolveNativeConsumerPolicy(policy,{lookup:()=> 'HEAD'}),/no exact observed revision/);
});
