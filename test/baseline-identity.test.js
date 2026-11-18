import test from 'node:test';
import assert from 'node:assert/strict';
import {compareProducerSnapshot,compareReleaseEnvironment} from '../tools/lib/baseline-identity.mjs';

test('baseline identity refuses a different commit even when code tree is unchanged',()=>{
  const expected={revision:'commit-a',tree:'same-tree',trackedChanges:''};
  assert.deepEqual(compareProducerSnapshot(expected,{...expected}),[]);
  assert.match(compareProducerSnapshot(expected,{...expected,revision:'commit-b'}).join(' '),/revision changed/);
  assert.match(compareProducerSnapshot(expected,{...expected,trackedChanges:' M src/runtime.js'}).join(' '),/tracked producer files/);
});

test('release baseline cannot pass with a different runtime or locale',()=>{
  const expected={node:'24.22.3',v8:'13.6.233.17-node.63',npm:'11.9.0',
    platform:'linux',arch:'x64',timezone:'UTC',locale:'C.UTF-8'};
  assert.deepEqual(compareReleaseEnvironment(expected,expected),{});
  const mismatches=compareReleaseEnvironment(expected,{...expected,node:'25.0.0',locale:'en_US.UTF-8'});
  assert.deepEqual(Object.keys(mismatches),['node','locale']);
  assert.equal(mismatches.node.actual,'25.0.0');
  assert.equal(mismatches.locale.expected,'C.UTF-8');
});
