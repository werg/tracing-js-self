import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,validateTrainingExport} from '../src/training/index.js';
import {cases} from '../corpus/cases.mjs';
import {original} from '../corpus/pinned-source.mjs';
import {replayExact,validateBundle} from '../src/index.js';

function verify(source,entry,args){
  const result=verifyTrainingCase({source,entry,args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result).slice(0,800));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  assert.equal(replayExact(result.exported.sidecar.archive).valid,true);
  assert.equal(validateBundle(result.exported.sidecar.archive).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(result.exported).valid,true);
  return result.exported;
}
test('rest allocation and ordered spread are independently verifiable',()=>{
  verify('"use strict"; function f(...xs){return xs.concat([9]);}','f',[1,2,3]);
  verify('"use strict"; function f(a,...rest){return [a,rest];}','f',[9,8,7]);
  verify('"use strict"; function f(xs){return [].concat(...xs);}','f',[[[1,2],[3]]]);
});
test('rest arrays are not fabricated from sparse or exotic spread input',()=>{
  const result=verifyTrainingCase({source:'"use strict"; function f(o){return [].concat(...o);}',entry:'f',args:[{}]});
  assert.notEqual(result.status,'locally_verified');
});
test('pinned real-source concatArrays preserves source and independently verifies all fixtures',()=>{
  const item=cases.find(c=>c.project==='vscode'&&c.entry==='concatArrays');
  const text=original(item).text.replace(/\bexport\s+(?=(?:async\s+)?function\b)/g,'');
  const source='"use strict";\n'+ts.transpileModule(text,{fileName:item.file,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}})
    .outputText.replace(/^["']use strict["'];\s*/,'');
  for(let i=0;i<12;i++)verify(source,item.entry,item.args(i));
});
