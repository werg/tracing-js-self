import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{producer:{type:'string'},retained:{type:'string'},output:{type:'string'}}});
assert(values.producer&&values.retained&&values.output,'--producer, --retained and --output are required');
const producer=resolve(values.producer);
const producerRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:producer,encoding:'utf8'}).trim();
assert.equal(producerRevision,'012c9fe49a082319bf98ac0c571596da925741a4');
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:producer,encoding:'utf8'}).trim(),'');
assert.equal(process.versions.node,'24.22.3');
assert.equal(process.env.TZ,'Europe/Berlin');
const {validateRegionExecutionStudy,scoreSelectedRegionExecution}=await import(pathToFileURL(resolve(producer,'src/semantic/execution-study-v8.js')));
const {hashAlgorithmData}=await import(pathToFileURL(resolve(producer,'src/semantic/program.js')));
const root=pathToFileURL(resolve(values.retained)+'/');
const read=async path=>JSON.parse(await fs.readFile(new URL(path,root),'utf8'));
const digest=value=>hashAlgorithmData(JSON.parse(JSON.stringify(value)));
const output={scope:'Exact producer replay of retained private source scoring; no neural inference, optimization or model-weight verification',producerRevision,node:process.versions.node,v8:process.versions.v8,timezone:process.env.TZ,models:[]};
for(const model of ['baseline','fitted']){
  const study=await read(`study/${model}-study/study.json`);
  const cases=await read(`study/${model}-study/private-cases.json`);
  const report=await read(`study/${model}-run/report.json`);
  validateRegionExecutionStudy(study);
  assert.equal(report.studyDigest,study.digest);
  for(const entry of study.cases){
    const privateCase=cases.find(c=>c.id===entry.id);
    assert.equal(entry.requestDigest,digest(privateCase.request));
    assert.equal(entry.expectedArtifactDigest,digest(privateCase.expectedArtifact));
    assert(!Object.hasOwn(entry,'expectedArtifact'));
    assert.deepEqual(Object.keys(entry.request).sort(),['fixture','initialPublic']);
    assert(entry.request.initialPublic.timeline.every(row=>row.mode==='observed'));
  }
  const rows=[];
  for(const row of report.rows){
    const {digest:claimed,...body}=row.result;
    assert.equal(claimed,digest(body));
    const rescored=await scoreSelectedRegionExecution(row.result,cases.find(c=>c.id===row.caseId).expectedArtifact);
    for(const field of ['publicCompleted','sourceValidated','completedExecution','sourceStatus'])
      assert.equal(rescored[field],row.result[field]);
    assert.equal(rescored.sourceValidated,row.sourceValidated);
    assert.equal(rescored.completedExecution,row.completedExecution);
    rows.push({case:row.caseId,seed:row.seed,sourceStatus:rescored.sourceStatus,sourceValidated:rescored.sourceValidated,completedExecution:rescored.completedExecution,originalDigestValid:true});
  }
  output.models.push({model,studyDigest:study.digest,declared:study.declared,rows});
}
await fs.writeFile(resolve(values.output),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({status:'passed',models:2,scoredRows:12,sourceQualified:output.models.flatMap(m=>m.rows).filter(r=>r.completedExecution).length},null,2));
