import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options:{producer:{type:'string'},retained:{type:'string'},output:{type:'string'}}});
assert(values.producer && values.retained && values.output, '--producer, --retained and --output are required');
const producer = resolve(values.producer);
const producerRevision = execFileSync('git',['rev-parse','HEAD'],{cwd:producer,encoding:'utf8'}).trim();
assert.equal(producerRevision, '9d4f6b3fcff97e7f915ae9c7228f7fd75aaaec3c');
assert.equal(process.versions.node, '24.22.3');
assert.equal(process.env.TZ, 'Europe/Berlin');
const {validateRegionExecutionStudy, scoreSelectedRegionExecution} = await import(pathToFileURL(resolve(producer,'src/semantic/execution-study-v8.js')));
const {hashAlgorithmData} = await import(pathToFileURL(resolve(producer,'src/semantic/program.js')));
const root = pathToFileURL(resolve(values.retained)+'/');
const read = async path => JSON.parse(await fs.readFile(new URL(path, root), 'utf8'));
const digest = value => hashAlgorithmData(JSON.parse(JSON.stringify(value)));
const output = {scope:'Historical exact-producer replay of retained private scoring; no inference, optimization, or model-weight verification', producerRevision, node:process.versions.node, v8:process.versions.v8, timezone:process.env.TZ, studies:[]};
for (const phase of ['current-source', 'stale-source-authority']) {
  for (const model of ['baseline', 'fitted']) {
    const study = await read(`${phase}/${model}-study/study.json`);
    const cases = await read(`${phase}/${model}-study/private-cases.json`);
    const report = await read(`${phase}/${model}-run/report.json`);
    validateRegionExecutionStudy(study);
    assert.equal(report.studyDigest, study.digest);
    for (const entry of study.cases) {
      const privateCase = cases.find(c => c.id === entry.id);
      assert.equal(entry.requestDigest, digest(privateCase.request));
      assert.equal(entry.expectedArtifactDigest, digest(privateCase.expectedArtifact));
      assert(!Object.hasOwn(entry, 'expectedArtifact'));
      assert.deepEqual(Object.keys(entry.request).sort(), ['fixture', 'initialPublic']);
      assert(entry.request.initialPublic.timeline.every(row => row.mode === 'observed'));
    }
    const rows = [];
    for (const row of report.rows) {
      const {digest: claimed, ...body} = row.result;
      assert.equal(claimed, digest(body));
      let rescored;
      try {
        rescored = await scoreSelectedRegionExecution(row.result, cases.find(c => c.id === row.caseId).expectedArtifact);
        assert.equal(rescored.publicCompleted, row.result.publicCompleted);
        assert.equal(rescored.sourceValidated, row.sourceValidated);
        assert.equal(rescored.completedExecution, row.completedExecution);
        assert.equal(rescored.sourceStatus, row.result.sourceStatus);
        assert.equal(phase, 'current-source');
        rows.push({case:row.caseId, seed:row.seed, sourceStatus:rescored.sourceStatus, sourceValidated:rescored.sourceValidated, completedExecution:rescored.completedExecution, originalDigestValid:true});
      } catch (error) {
        if (phase === 'current-source') throw error;
        assert.equal(row.sourceValidated, false);
        assert.equal(row.completedExecution, false);
        assert(error.message.includes('environment'));
        rows.push({case:row.caseId, seed:row.seed, sourceError:error.message, publicCompleted:row.result.publicCompleted, sourceValidated:false, completedExecution:false, originalDigestValid:true});
      }
    }
    output.studies.push({phase,model,studyDigest:study.digest,declared:study.declared,rows});
  }
}
await fs.writeFile(resolve(values.output), JSON.stringify(output, null, 2)+'\n');
console.log(JSON.stringify({status:'passed',scoredReports:output.studies.length,rows:output.studies.reduce((n,s)=>n+s.rows.length,0),currentSourceQualified:output.studies.filter(s=>s.phase==='current-source').flatMap(s=>s.rows).filter(r=>r.completedExecution).length,staleSourceQualified:0},null,2));
