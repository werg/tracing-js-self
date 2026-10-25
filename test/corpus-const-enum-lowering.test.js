import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {cases} from '../corpus/cases.mjs';
import {original,lowerPinnedCharCode} from '../corpus/pinned-source.mjs';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';

const functions=['firstNonWhitespaceIndex','getLeadingWhitespace',
  'lastNonWhitespaceIndex','getIndentationLength'];
test('pinned TypeScript const enum is lowered to only verified compile-time constants',()=>{
 for(const entry of functions){
  const spec=cases.find(c=>c.project==='vscode'&&c.entry===entry),source=original(spec);
  const lowered=lowerPinnedCharCode(spec,source.text);
  assert.equal(lowered.lowering.kind,'pinned-typescript-const-enum-inlining/1');
  assert.deepEqual(lowered.lowering.constants,{Space:32,Tab:9});
  assert.match(lowered.lowering.pinnedDependencySha256,/^[a-f0-9]{64}$/);
  assert(!lowered.text.includes('enum CharCode'));
  assert(!lowered.text.includes('CharCode.Space'));
  assert(!lowered.text.includes('CharCode.Tab'));
  assert(source.text.includes('enum CharCode'), 'original upstream source must stay unchanged');
  const bare=lowered.text.replace(/\bexport\s+(?=(?:async\s+)?function\b)/g,'');
  const js=ts.transpileModule(bare,{fileName:spec.file,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}})
    .outputText.replace(/^["']use strict["'];\s*/,'');
  assert(Buffer.byteLength(js)<2048);
  for(const index of [0,4,11]){
    const verified=verifyOwnedSourceCase({source:'"use strict";\n'+js,
      entry,args:spec.args(index),maxGenerated:1024});
    assert.equal(verified.status,'locally_verified',JSON.stringify(verified).slice(0,500));
    assert.equal(recheckOwnedSourceEvidence(verified.exported).valid,true);
  }
 }
});
test('changed or unmodeled enum dependencies fail closed',()=>{
 const spec=cases.find(c=>c.entry==='firstNonWhitespaceIndex'),input=original(spec).text;
 assert.throws(()=>lowerPinnedCharCode(spec,input.replace('Space = 32','Space = 33')),
   /mismatch/);
 assert.throws(()=>lowerPinnedCharCode(spec,input.replaceAll('CharCode.Space','CharCode.UNRECOGNIZED')),
   /Unmodeled/);
});
