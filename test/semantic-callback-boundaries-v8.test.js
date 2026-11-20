import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

const original=JSON.parse(gunzipSync(Buffer.from(readFileSync(
  new URL('./fixtures/semantic-callback-regions-v8.json.gz.b64',import.meta.url),'utf8').trim(),'base64')));

test('callback arguments bind once and owner completion policy survives native public replay',()=>{
  for(const policy of ['call-return','owned-quiescence','await-returned-promise']){
    const episode=structuredClone(original.public);
    for(const row of episode.timeline)if(row.kind==='invocation'){
      if(row.fields.activation==='callback')row.fields.bindings={n:0};
      else row.fields.completionPolicy=policy;
    }
    const harness=RegionExecutionHarness.replay(episode),expected={kind:'return',
      value:policy==='await-returned-promise'?['num',7]:['ref','p1']};
    assert.deepEqual(harness.controller.completion,expected);
    for(const id of ['event1','event2']){
      const aliases=[...harness.invocations.get(id).controller.captureAliases];
      assert.equal(aliases.filter(([name])=>name==='n').length,1);
    }
    assert.deepEqual(RegionExecutionHarness.restore(JSON.parse(JSON.stringify(harness.checkpoint()))).controller.completion,expected);
  }
});
