import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gitBlobSha } from '../src/test262-baseline.js';
import {
  validateSelection, checkExecutionFixture, parseExecutionMetadata,
  unavailableFeatures, runOwnedScript, matchesTest262Expectation,
  classifyExecutionCase, summarizeExecutionCases
} from '../src/test262-execution.js';

const manifest = JSON.parse(readFileSync(new URL('../conformance/test262-cases.json',import.meta.url),'utf8'));
const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json',import.meta.url),'utf8'));
const copy = x => structuredClone(x);

test('selected official suite is pinned to the same engine and revision as syntax baseline', () => {
  validateSelection(manifest,profile);
  assert.equal(manifest.cases.length,11);
  assert.equal(manifest.cases.filter(x=>x.baseline==='pass').length,4);
  assert.equal(manifest.cases.filter(x=>x.baseline==='xfail').length,5);
  assert.equal(manifest.cases.filter(x=>x.baseline==='skip').length,2);
  const changed = copy(manifest); changed.referenceVersion='other';
  assert.throws(()=>validateSelection(changed,profile),/unpinned/);
  const dupe = copy(manifest); dupe.cases.push(copy(dupe.cases[0]));
  assert.throws(()=>validateSelection(dupe,profile),/duplicate/);
  const path = copy(manifest); path.cases[0].path='../escape.js';
  assert.throws(()=>validateSelection(path,profile),/path/);
  const pin = copy(manifest); pin.cases[0].gitBlobSha='not-a-sha';
  assert.throws(()=>validateSelection(pin,profile),/unpinned/);
});

test('the exact official source bytes must match a pinned Git blob SHA',()=>{
  const bytes=Buffer.from('/*---\ndescription: example\n---*/\nlet n=1;\n');
  const entry={path:'language/statements/let/example.js',gitBlobSha:gitBlobSha(bytes)};
  checkExecutionFixture(entry,bytes);
  assert.throws(()=>checkExecutionFixture(entry,Buffer.from('tampered')),/blob mismatch/);
  assert.throws(()=>checkExecutionFixture({...entry,path:'../escape.js'},bytes),/Invalid pinned Test262 path/);
});

test('metadata recognizes only explicitly supported modes and negative phases',()=>{
  const source='/*---\nnegative:\n  phase: runtime\n  type: ReferenceError\nflags: [noStrict]\n---*/\nlet x=x;';
  assert.deepEqual(parseExecutionMetadata(source),{
    flags:['noStrict'],includes:[],features:[],
    negative:{phase:'runtime',type:'ReferenceError'}
  });
  assert.deepEqual(unavailableFeatures(parseExecutionMetadata(source),source),[]);
  const unsupported='/*---\nflags: [onlyStrict, async]\nincludes: [assert.js]\nfeatures: [Proxy]\n---*/\nassert.throws(Error, ()=>{});';
  assert.deepEqual(unavailableFeatures(parseExecutionMetadata(unsupported),unsupported),[
    'flag:onlyStrict','flag:async','include:assert.js','feature:Proxy','assert-harness'
  ]);
  assert.throws(()=>parseExecutionMetadata('/*---\nnegative:\n  phase: resolution\n  type: SyntaxError\n---*/\n'),/Unsupported/);
  assert.throws(()=>parseExecutionMetadata('/*---\nflags:\n  - module\n---*/\n'),/Unsupported/);
  assert.throws(()=>parseExecutionMetadata('const x=1;'),/Missing/);
});

test('bounded execution distinguishes parse and compiler refusal from runtime failures',()=>{
  assert.equal(runOwnedScript('const x = ;').phase,'parse');
  assert.equal(runOwnedScript('if (true) function f() {}').phase,'compile');
  assert.deepEqual(
    {phase:runOwnedScript('let x = x + 1;').phase,errorName:runOwnedScript('let x = x + 1;').errorName},
    {phase:'runtime',errorName:'ReferenceError'}
  );
  assert.equal(runOwnedScript('let x=1; x+=2;').phase,'normal');
  assert.equal(runOwnedScript('host.readNumber("key");').phase,'incomplete');
});

test('selected Test262 pass, XFAIL, XPASS and reference regressions are distinct',()=>{
  const path='language/statements/let/example.js';
  const testCase={path,gitBlobSha:'0'.repeat(40),baseline:'pass'};
  const source='/*---\nnegative:\n  phase: runtime\n  type: ReferenceError\n---*/\nlet x = x + 1;';
  const runtimeError = {phase:'runtime',errorName:'ReferenceError'};
  const pass = classifyExecutionCase(testCase,source,()=>runtimeError,()=>runtimeError);
  assert.equal(pass.status,'pass');
  assert.equal(pass.unexpected,undefined);
  assert.equal(pass.referencePass,true);
  const fails = classifyExecutionCase(testCase,source,()=>runtimeError,()=>({phase:'parse',errorName:'SyntaxError'}));
  assert.equal(fails.status,'xfail');
  assert.match(fails.unexpected,/Expected pass/);

  const expectedFailure={...testCase,baseline:'xfail',reason:'legacy gap'};
  const xpass=classifyExecutionCase(expectedFailure,source,()=>runtimeError,()=>runtimeError);
  assert.equal(xpass.status,'pass');
  assert.match(xpass.unexpected,/Expected xfail, observed pass/);
  const referenceDiverged=classifyExecutionCase(testCase,source,()=>({phase:'normal'}),()=>runtimeError);
  assert.match(referenceDiverged.unexpected,/Reference engine/);
  assert.equal(matchesTest262Expectation({phase:'compile',errorName:'SyntaxError'},{
    phase:'parse',type:'SyntaxError'
  }),false);
});

test('unavailable harness coverage is never silently credited as passing',()=>{
  const source='/*---\nflags: [onlyStrict]\n---*/\nconst a=1;';
  const entry={path:'language/statements/let/x.js',gitBlobSha:'0'.repeat(40),baseline:'pass'};
  const row=classifyExecutionCase(entry,source,()=>{throw new Error('reference must not run');});
  assert.equal(row.status,'skip');
  assert.match(row.unexpected,/Unsupported/);
  assert.deepEqual(row.reasons,['flag:onlyStrict']);
  const declared=classifyExecutionCase({...entry,baseline:'skip',reason:'unsupported strict goal'},source,()=>{throw new Error('reference must not run');});
  assert.equal(declared.unexpected,undefined);
  assert.equal(summarizeExecutionCases([declared,row]).unexpected,1);
});

test('report counts never present known failures or skips as passes',()=>{
  assert.deepEqual(summarizeExecutionCases([
    {status:'pass'},{status:'xfail'},{status:'skip'},
    {status:'pass',unexpected:'oracle mismatch'}
  ]),{selected:4,executed:3,passed:2,knownFailed:1,skipped:1,unexpected:1});
});
