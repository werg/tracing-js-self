import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,cpSync,readFileSync}
 from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {extractPinnedHelper,verifyPinnedProductionHelpers,
 extractPinnedTypeOfTestClosure,verifyPinnedProductionClosures}
 from '../src/corpus/production-owned.mjs';
import {upstream} from '../corpus/stateful/cases.mjs';
test('pinned original Axios helper body has unchanged exact-source span',()=>{
 const original=readFileSync('corpus/stateful/upstream/axios/lib/core/InterceptorManager.js','utf8');
 const item=extractPinnedHelper('axios-interceptors','countHandlers');
 const {start,end}=item.provenance.sourceSpan;
 assert.equal(item.projected.slice(item.provenance.projectionStart,
  item.provenance.projectionStart+end-start),original.slice(start,end));
 assert.equal(item.provenance.repository,'axios/axios');
 assert.equal(item.provenance.revision,upstream['axios-interceptors'].revision);
 assert.throws(()=>extractPinnedHelper('axios-interceptors','constructor'),/No single/);
 assert.throws(()=>extractPinnedHelper('random','countHandlers'),/Unrecognized/);
});
test('actual pinned production functions produce independently checked owned candidates or refusals',()=>{
 const {report,verified}=verifyPinnedProductionHelpers();
 assert.equal(report.schema,'production-helper-owned-report/1');
 assert.equal(report.attempted,23);
 assert.equal(report.admitted,0);
 assert.equal(report.locallyVerified+report.refused,report.attempted);
 assert.equal(report.locallyVerified,19,JSON.stringify(report.rows));
 assert.equal(verified.length,report.locallyVerified);
 assert(report.rows.every(x=>x.admitted===false));
 for(const row of report.rows){
  assert(row.status==='locally_verified'||row.verifiedOwned===false);
  if(row.verifiedOwned){
   assert.equal(row.evidence.modelVisibleSchema,'semantic-execution/4');
   assert.equal(row.evidence.originalExactText.length,
    row.originalSource.sourceSpan.end-row.originalSource.sourceSpan.start);
  }
 }
});
test('tampered real vendor source refuses execution before any V8/owned check',()=>{
 const root=mkdtempSync(join(tmpdir(),'production-owned-'));
 try{
  const file=join(root,'corpus/stateful/upstream/axios/lib/core/InterceptorManager.js');
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,readFileSync(resolve('corpus/stateful/upstream/axios/lib/core/InterceptorManager.js'),'utf8')+'\n//tampered');
  assert.throws(()=>extractPinnedHelper('axios-interceptors','countHandlers',{root}),
   /SHA-256 mismatch/);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('pinned production arrow-body projection preserves original expression bytes',()=>{
 const source=readFileSync('corpus/stateful/upstream/axios/lib/utils.js','utf8');
 for(const name of ['isUnsafeObjectKey','isObject','isBoolean']){
  const item=extractPinnedHelper('axios-utils',name);
  assert.match(item.provenance.extraction,/unchanged-arrow-expression/);
  assert.equal(item.projected.slice(item.provenance.projectionStart,
   item.provenance.projectionStart+item.provenance.sourceSpan.end-
   item.provenance.sourceSpan.start),
   source.slice(item.provenance.sourceSpan.start,item.provenance.sourceSpan.end));
  assert(item.originalArrow.includes('const '+name+' ='));
 }
});


test('pinned Axios closure factory runs as a real owned nested closure or refuses',()=>{
 const artifact=extractPinnedTypeOfTestClosure();
 const source=readFileSync('corpus/stateful/upstream/axios/lib/utils.js','utf8');
 const {start,end}=artifact.provenance.sourceSpan;
 assert.equal(artifact.projected.slice(artifact.provenance.projectionStart,
  artifact.provenance.projectionStart+end-start),source.slice(start,end));
 assert.match(artifact.projected,/predicate = typeOfTest\(type\)/);
 const {report,verified}=verifyPinnedProductionClosures();
 assert.equal(report.attempted,11);
 assert.equal(report.locallyVerified+report.refused,11);
 assert.equal(report.admitted,0);
 assert.equal(verified.length,report.locallyVerified);
 for(const row of report.rows){
  assert.equal(row.admitted,false);
  assert.equal(row.verifiedOwned,row.status==='locally_verified');
  if(row.verifiedOwned)
   assert.equal(row.evidence.modelVisibleSchema,'semantic-execution/4');
  else assert.equal(typeof row.reason,'string');
 }
});

test('modified vendor bytes refuse original factory extraction',()=>{
 const root=mkdtempSync(join(tmpdir(),'production-closure-'));
 try{
  const file=join(root,'corpus/stateful/upstream/axios/lib/utils.js');
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,readFileSync('corpus/stateful/upstream/axios/lib/utils.js','utf8')+'\n');
  assert.throws(()=>extractPinnedTypeOfTestClosure({root}),/SHA-256 mismatch/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
