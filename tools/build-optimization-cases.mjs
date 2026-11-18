#!/usr/bin/env node
// Private expectations remain in this declaration. The optimizer smoke sends
// only each envelope to run-selected-evaluation.mjs and the model process.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {controlledEvaluationCase} from '../src/training/selected-evaluation.js';

export function optimizationCase(exported,{seed=17}={}){
  if(exported?.sidecar?.admission!=='admitted'||exported.sidecar.split!=='train'||
    exported.sidecar.nativeAdmission?.admitted!==true)
    throw new TypeError('Optimization smoke requires natively admitted training examples');
  if(![17,29,43].includes(seed))throw new TypeError('Use a declared evaluation seed');
  if(!/^[0-9a-f]{64}$/.test(exported.sidecar.identityDigest??''))
    throw new TypeError('Optimization evaluation requires immutable candidate identity');
  const id=exported.sidecar.sourceFamily+'/'+exported.sidecar.taskId+'@'+exported.sidecar.identityDigest.slice(0,16);
  const fixture=controlledEvaluationCase(exported,{id});
  const request=structuredClone(fixture.request);
  delete request.controlledSelectionsByRepresentation;
  return {id:fixture.id,family:fixture.family,split:'train',expected:fixture.expected,
    envelope:{schema:'semantic-evaluation-request/4',caseId:fixture.id,request,
      seed,representation:'compact'}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,output,rawSeed='17']=process.argv.slice(2);
  if(!input||!output)throw new TypeError('Usage: build-optimization-cases.mjs INPUT_PATHS.json OUTPUT.json [SEED]');
  const paths=JSON.parse(readFileSync(input,'utf8'));
  if(!Array.isArray(paths)||!paths.length||paths.some(path=>typeof path!=='string'))
    throw new TypeError('Input paths must be a nonempty array');
  const cases=paths.map(path=>optimizationCase(JSON.parse(readFileSync(path,'utf8')),{seed:Number(rawSeed)}));
  if(new Set(cases.map(item=>item.id)).size!==cases.length)
    throw new TypeError('Optimization case identities must be unique');
  writeFileSync(output,JSON.stringify({schema:'optimization-cases/1',cases},null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({cases:cases.length,split:'train',injectedSelections:false})+'\n');
}
