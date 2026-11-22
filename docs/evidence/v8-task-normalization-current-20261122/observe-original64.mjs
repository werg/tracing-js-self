// Read only: no journal reconstruction, source replay, native call or optimizer.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {verifyV8TaskArtifactBinding} from '../../../src/corpus/release-task-binding-v8.mjs';

const [directory,output]=process.argv.slice(2);
assert.ok(directory&&output,'usage: node observe-original64.mjs PRESERVED_ROOT OUTPUT_JSON');
const root=resolve(directory),digest=bytes=>createHash('sha256').update(bytes).digest('hex'),reads=new Map();
function read(name){
  const bytes=readFileSync(join(root,name)),sha256=digest(bytes);
  assert.equal(reads.has(name),false,'read each original input once before rechecking');
  reads.set(name,{path:name,bytes:bytes.length,sha256});return JSON.parse(bytes);
}
const population=read('population.json'),registry=read('family-registry.json'),report=read('report.json');
assert.equal(population.tasks.length,64);assert.equal(report.rows.length,64);
const bindings=[];
for(const [index,task] of population.tasks.entries()){
  const row=report.rows[index],name=row.sourceArtifact;
  assert.equal(task.fixture.id,row.id);assert.equal(row.source,'passed');
  assert.equal(name,task.fixture.id+'.source.json');
  const artifact=read(name);
  assert.equal(reads.get(name).sha256,report.artifacts[name],'original reported source bytes');
  bindings.push(verifyV8TaskArtifactBinding(task,artifact,{registry,expectedSourceId:row.sourceId}));
}
assert.equal(reads.get('population.json').sha256,report.artifacts['population.json']);
assert.equal(reads.get('family-registry.json').sha256,report.artifacts['family-registry.json']);
const files=[...reads.values()].map(before=>{
  const bytes=readFileSync(join(root,before.path)),afterSha256=digest(bytes);
  assert.equal(afterSha256,before.sha256);assert.equal(bytes.length,before.bytes);
  return {...before,afterSha256,unchanged:true};
});
writeFileSync(output,JSON.stringify({schema:'semantic-v8-original64-normalization-observation/1',
  status:'passed',originalProducerRevision:population.producerRevision,
  originalConsumerRevision:report.nativePolicy.consumerRevision,
  populationDigest:population.digest,registryDigest:registry.digest,checkedSourceTasks:bindings.length,
  originalFiles:files.length,originalBytes:files.reduce((n,row)=>n+row.bytes,0),files,bindings,
  fullJournalVerified:false,freshSourceReplays:0,freshNativeAdmissions:0,optimizerUpdates:0,
  authority:'Original encoded tasks and source artifacts only; no missing lock reconstructed and no current-pair qualification'},null,2)+'\n');
console.log(JSON.stringify({status:'passed',checkedSourceTasks:bindings.length,originalFiles:files.length,
  unchanged:true,freshSourceReplays:0,freshNativeAdmissions:0,optimizerUpdates:0}));
