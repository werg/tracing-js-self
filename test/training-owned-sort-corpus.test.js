import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';
import {cases} from '../corpus/cases.mjs';
import {original} from '../corpus/pinned-source.mjs';
import {buildOwnedFixtureEntry} from '../corpus/owned-fixture-adapter.mjs';

function verify(source,entry,args=[]){
 const result=verifyTrainingCase({source,entry,args,maxGenerated:1024,maxSteps:10000});
 assert.equal(result.status,'locally_verified',JSON.stringify(result).slice(0,700));
 assert.equal(replayExact(result.exported.sidecar.archive).valid,true);
 assert.equal(validateBundle(result.exported.sidecar.archive).valid,true);
 assert.equal(validateTrainingExport(result.exported).valid,true);
 assert.equal(recheckIndependentTrainingEvidence(result.exported).valid,true);
 return result.exported;
}
test('real pinned groupBy comparator with representative original inputs',()=>{
 const c=cases.find(x=>x.project==='vscode'&&x.entry==='groupBy');
 const text=original(c).text.replace(/\bexport\s+(?=(?:async\s+)?function\b)/g,'');
 const source=ts.transpileModule(text,{fileName:c.file,compilerOptions:{
   target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None
 }}).outputText.replace(/^["']use strict["'];\s*/,'');
 for(const i of [0,1,6,11]){
  const fixture=buildOwnedFixtureEntry(c.setup(i),c.entry);
  verify('"use strict";\n'+source+'\n'+fixture.source,fixture.entry);
 }
});
test('array-mutating comparators are not promoted to locally verified sort traces',()=>{
 const r=verifyTrainingCase({source:'"use strict";function f(a){a.sort((x,y)=>{a.push(9);return x-y;});return a;}',entry:'f',args:[[3,2,1]]});
 assert.notEqual(r.status,'locally_verified');
});
