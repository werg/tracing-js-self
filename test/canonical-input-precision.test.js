import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectCanonicalInputPrecision} from '../src/corpus/canonical-input-precision.mjs';
import {loadPinnedPairs,extractCanonicalCases,INPUT_ROOT} from '../src/corpus/owned-exercism.mjs';
import {trustedRealSourceCases} from '../src/corpus/trusted-source-candidates.mjs';
import {runGenerationProcess} from '../src/corpus/generation-process.mjs';

const caseSource=(uuid,token)=>`{"uuid":"${uuid}","input":{"number":${token}},"expected":true}`;
test('canonical integer loss checks exact value rather than the safe-integer threshold',()=>{
  const exact=['9007199254740991','9007199254740992','18446744073709551616',
    '-9007199254740992','9.007199254740992e15','9007199254740992.0','-0','0e99999'];
  const rounded=['9007199254740993','-9007199254740993','18446744073709551615',
    '9.007199254740993e15','9007199254740993.0','1e400'];
  const source='{"cases":['+[
    ...exact.map((value,index)=>caseSource('exact-'+index,value)),
    ...rounded.map((value,index)=>caseSource('rounded-'+index,value)),
    caseSource('fraction','0.1')].join(',')+']}';
  const reports=inspectCanonicalInputPrecision(source,{slug:'example'});
  assert.equal(Object.keys(reports).length,rounded.length);
  for(const [index,token] of rounded.entries()){
    const report=reports['example/rounded-'+index];
    assert.equal(report.status,'unsupported');
    assert.equal(report.scope,'integer-valued-json-numbers');
    assert.equal(report.losses.length,1);
    const loss=report.losses[0];
    assert.equal(loss.lexeme,token);
    assert.equal(source.slice(loss.span.start,loss.span.end),token);
    assert.deepEqual(loss.path,['input','number']);
    if(loss.observedInteger!==null)assert.notEqual(loss.observedInteger,loss.canonicalInteger);
  }
  assert.equal(reports['example/rounded-0'].losses[0].canonicalInteger,'9007199254740993');
  assert.equal(reports['example/rounded-0'].losses[0].observedInteger,'9007199254740992');
  assert.equal(reports['example/rounded-5'].losses[0].observedNumber,'Infinity');
});

test('precision inspection follows canonical input paths without treating expectations or data objects as cases',()=>{
  const source='{"cases":[{"uuid":"nested","input":{"values":[0,9007199254740993],'+
    '"data":{"input":1,"expected":2}},"expected":18446744073709551615}]}';
  const report=inspectCanonicalInputPrecision(source,{slug:'example'})['example/nested'];
  assert.equal(report.losses.length,1);
  assert.deepEqual(report.losses[0].path,['input','values',1]);
  assert.throws(()=>inspectCanonicalInputPrecision('{"cases":[{"uuid":"x","input":{"n":1,"n":2},"expected":1}]}',
    {slug:'example'}),/Duplicate canonical JSON property/);
  assert.throws(()=>inspectCanonicalInputPrecision('{"cases":['+caseSource('same','1')+','+caseSource('same','2')+']}',
    {slug:'example'}),/Duplicate canonical input identity/);
});

test('the two pinned Armstrong big-integer cases retain exact lexemes and fail before execution',async t=>{
  const pair=loadPinnedPairs().find(row=>row.slug==='armstrong-numbers');
  const cases=extractCanonicalCases(pair),refused=cases.filter(row=>row.status==='unsupported_input_precision');
  assert.equal(cases.length,11);assert.equal(cases.filter(row=>row.status==='candidate').length,9);
  assert.equal(refused.length,2);
  const raw=readFileSync(join(INPUT_ROOT,'exercises/armstrong-numbers/canonical-data.json'),'utf8');
  assert.deepEqual(refused.map(row=>row.inputPrecision.losses[0].lexeme),
    ['186709961001538790100634132976990','115132219018763992565095597973971522401']);
  for(const row of refused){
    assert.equal(typeof row.args[0],'number','rounded arguments remain visible as forensic input, not silently converted');
    assert.deepEqual(row.scenarios,['big-integer']);
    assert.match(row.canonicalComments[0],/Consider skipping/);
    const loss=row.inputPrecision.losses[0];
    assert.equal(raw.slice(loss.span.start,loss.span.end),loss.lexeme);
    assert.equal(BigInt(row.args[0]).toString(),loss.observedInteger);
    assert.notEqual(loss.observedInteger,loss.canonicalInteger);
  }
  const fixtures=trustedRealSourceCases({streams:['exercism'],perFamily:12})
    .filter(row=>row.preflightFailure?.reason==='unsupported_input_precision');
  assert.deepEqual(fixtures.map(row=>row.id),
    ['real-exercism-fd163dd26aa026080cdd1737','real-exercism-4524e8796cbf93cbc09c7b60']);
  const directory=mkdtempSync(join(tmpdir(),'canonical-input-precision-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for(const fixture of fixtures){
    assert.equal(fixture.preflightFailure.status,'fixture_unsupported');
    assert.equal(fixture.provenance.canonicalInputPrecision.losses.length,1);
    // Invalid source would fail the reference parser if the preflight were
    // bypassed. The precision disposition must happen first.
    const invalid='this is deliberately not parseable JavaScript (';
    const run=await runGenerationProcess({kind:'source',fixture:{...fixture,
      source:invalid,originalReferenceSource:invalid},producerRevision:'a'.repeat(40)},
      {outputDirectory:directory,timeoutMs:10000});
    assert.equal(run.result.status,'fixture_unsupported');
    assert.equal(run.result.reason,'unsupported_input_precision');
    assert.equal(run.result.failure.originalSource,invalid);
    assert.deepEqual(run.result.failure.provenance.canonicalInputPrecision,fixture.provenance.canonicalInputPrecision);
    assert.equal(run.result.exported,undefined);
  }
});
