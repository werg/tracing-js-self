import test from 'node:test';
import assert from 'node:assert/strict';
import { gitBlobSha,verifySuiteFile,parseTest262Metadata,inspectBoundedFrontend,summarizeSyntaxRows } from '../src/test262-baseline.js';

test('Test262 metadata is explicitly restricted to single-goal script parsing', () => {
  const positive = '/*---\ndescription: script\n---*/\nif (1);';
  const negative = '/*---\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nif (true) let x;';
  assert.deepEqual(parseTest262Metadata(positive),{negativeParse:false,expectedParseAccepted:true});
  assert.deepEqual(parseTest262Metadata(negative),{negativeParse:true,expectedParseAccepted:false});
  assert.throws(()=>parseTest262Metadata('/*---\nflags: [module]\n---*/\n1;'),/Unsupported Test262 flags/);
  assert.throws(()=>parseTest262Metadata('/*---\nnegative:\n  phase: runtime\n  type: TypeError\n---*/\n1;'),/Unsupported negative phase/);
  assert.throws(()=>parseTest262Metadata('/*---\nincludes: [assert.js]\n---*/\n1;'),/Includes require/);
  assert.throws(()=>parseTest262Metadata('1 + 1;'),/Missing Test262 metadata/);
});

test('pinned Test262 bytes are verified using Git blob IDs, not just filenames', () => {
  const data = Buffer.from('if (true);\n');
  const entry = {path:'test/language/statements/if/example.js',gitBlobSha:gitBlobSha(data)};
  verifySuiteFile(entry,data);
  assert.throws(()=>verifySuiteFile(entry,Buffer.from('if (false);\n')),/blob mismatch/);
  assert.throws(()=>verifySuiteFile({...entry,path:'test/../escape.js'},data),/Invalid pinned Test262 path/);
  assert.throws(()=>verifySuiteFile({...entry,gitBlobSha:'not-a-hash'},data),/Invalid Test262 blob pin/);
});

test('bounded parser acceptance and compiler feasibility are separate observations', () => {
  assert.deepEqual(inspectBoundedFrontend('if (1);'),{parseAccepted:true,compileAccepted:true});
  const incorrectlyAccepted = inspectBoundedFrontend('if (true) let x;');
  assert.equal(incorrectlyAccepted.parseAccepted,true,'current bounded grammar gap remains visible');
  const clearlyInvalid = inspectBoundedFrontend('null = 42;');
  assert.equal(clearlyInvalid.parseAccepted,false);
  assert.equal(clearlyInvalid.compileAccepted,false);
  const compilerUnsupported = inspectBoundedFrontend('if (true) function f() {}');
  assert.equal(compilerUnsupported.parseAccepted,true);
  assert.equal(compilerUnsupported.compileAccepted,false);
});

test('syntax summary retains nonconformant cases rather than counting them as passes', () => {
  assert.deepEqual(summarizeSyntaxRows([
    {referencePassed:true,boundedPassed:true,bounded:{parseAccepted:true,compileAccepted:true}},
    {referencePassed:true,boundedPassed:false,bounded:{parseAccepted:true,compileAccepted:false}}
  ]),{
    total:2,referencePassed:2,boundedPassed:1,boundedKnownGaps:1,
    boundedParserAccepted:2,boundedCompilerAccepted:1
  });
});
