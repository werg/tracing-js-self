import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness} from '../src/training/format.js';
import {buildSemanticDiagnostics,renderSemanticDiagnosticsHtml} from '../src/training/semantic-diagnostics.js';

function completedEpisode(source='function run(){return 1;}'){
  const harness=new SelectedExecutionHarness({sessionId:'diag1'});
  harness.publishProgram({programId:'demo',source,entry:'run'});
  harness.admitInvocation({programId:'demo',invocationId:'call1',trackId:'worker:1',
    realmId:'realm1',triggerId:'outside:1'});
  harness.selected('call1',encodeWitness('return',{value:['num',1]}));
  harness.selected('call1',encodeWitness('end',{kind:'return'}));
  return harness.exportEpisode({sourceLineage:'diagnostic-fixture'});
}

test('diagnostic HTML is self-contained and escapes hostile source and identifiers',()=>{
  const source='function run(){/* </pre><script>alert("owned")</script> & */return 1;}';
  const report=buildSemanticDiagnostics(completedEpisode(source));
  const html=renderSemanticDiagnosticsHtml(report);
  assert.equal(report.replayValid,true);
  assert.equal(report.partial,false);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/&lt;\/pre&gt;/);
  assert.doesNotMatch(html,/<script/i);
  assert.doesNotMatch(html,/https?:\/\//i);
  assert.match(html,/href="#source-demo"/);
});

test('invalid partial traces remain visible and expected comparison reports first divergence',()=>{
  const valid=completedEpisode(),expected=structuredClone(valid);
  expected.public.timeline[1]=Object.fromEntries(Object.entries(expected.public.timeline[1]).reverse());
  assert.equal(buildSemanticDiagnostics(valid,{expected}).firstDivergence,null,
    'object-key order alone is not a semantic divergence');
  expected.public.timeline[1].triggerId='different-trigger';
  const report=buildSemanticDiagnostics(valid,{expected});
  assert.equal(report.firstDivergence.index,1);
  const invalid=structuredClone(valid);
  invalid.public.timeline[1].sequence=invalid.public.timeline[0].sequence;
  const diagnostic=buildSemanticDiagnostics(invalid);
  assert.equal(diagnostic.replayValid,false);
  assert.equal(diagnostic.partial,true);
  assert.equal(diagnostic.records.length,invalid.public.timeline.length);
  assert.ok(diagnostic.replayError);
});
