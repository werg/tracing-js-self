import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {serialize} from 'node:v8';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';

test('an ordinary V8 generation worker runs with legacy effect clients blocked',t=>{
  const outputDirectory=mkdtempSync(join(tmpdir(),'semantic-v8-import-boundary-'));
  t.after(()=>rmSync(outputDirectory,{recursive:true,force:true}));
  const loader=join(outputDirectory,'block-legacy-loader.mjs');
  writeFileSync(loader,`export async function resolve(specifier, context, nextResolve){
  if(specifier.endsWith('/src/training/effectful-admit.js')||
     specifier.endsWith('/src/training/effectful-session.js'))
    throw new Error('blocked legacy effect client: '+specifier);
  return nextResolve(specifier,context);
}\n`);
  const output=join(outputDirectory,'worker-result.json');
  const source='"use strict";function run(x){return x+1;}';
  const fixture={id:'v8-import-boundary',family:'v8-import-boundary',
      source,entry:'run',args:[1],fixture:{calls:[]}};
  const task=encodeGenerationTask({kind:'source',traceVersion:8,producerRevision:'a'.repeat(40),
    fixture},
    {jsonStorage:false});
  const worker=resolve('tools/generation-worker.mjs');
  for(const workerTask of [task,encodeGenerationTask({kind:'source',traceVersion:8,
      producerRevision:'a'.repeat(40),fixture:{...fixture,originalReferenceSource:source}},
      {jsonStorage:false})]){
    const result=spawnSync(process.execPath,
      ['--experimental-loader='+pathToFileURL(loader).href,worker],
      {cwd:resolve('.'),env:{...process.env,TRACING_REFERENCE_ISOLATION:'trusted-process'},
        input:serialize({task:workerTask,output,maxOutputBytes:64<<20}),
        encoding:'utf8',timeout:60000,maxBuffer:1048576});
    assert.equal(result.status,0,result.stderr);
    assert.ok(JSON.parse(result.stdout).peakRssBytes>0);
    const evidence=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(evidence.status,'locally_verified',evidence.reason);
    assert.equal(evidence.exported.public.schema,'semantic-execution/8');
  }
});
