import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,cpSync,readFileSync}
 from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {extractPinnedHelper,verifyPinnedProductionHelpers}
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
 assert.equal(report.attempted,10);
 assert.equal(report.admitted,0);
 assert.equal(report.locallyVerified+report.refused,report.attempted);
 assert(report.locallyVerified>=1,JSON.stringify(report.rows));
 assert.equal(verified.length,report.locallyVerified);
 assert(report.rows.every(x=>x.admitted===false));
 for(const row of report.rows){
  assert(row.status==='locally_verified'||row.verifiedOwned===false);
  if(row.verifiedOwned){
   assert.equal(row.evidence.modelVisibleSchema,'semantic-execution/2');
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
