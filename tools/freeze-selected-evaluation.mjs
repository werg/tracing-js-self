#!/usr/bin/env node
// Prepare the independently checked declaration consumed by Megatoken's freeze
// command. Whole source families retain the corpus split fixed before expansion.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {controlledEvaluationCase} from '../src/training/selected-evaluation.js';
import {controlledOrchestrationCase} from '../src/training/orchestration-evaluation.js';
import {buildBenchmarkCohortMetadata} from '../src/training/benchmark-cohort-metadata.js';
const [directory,output,...rawOptions]=process.argv.slice(2);
const options=new Set(),values=new Map();
for(let i=0;i<rawOptions.length;i++){
  const option=rawOptions[i];
  if(['--common-support','--include-validation','--with-orchestration','--benchmark-v1'].includes(option))options.add(option);
  else if(option==='--metadata-output'&&rawOptions[i+1])values.set(option,rawOptions[++i]);
  else throw new Error('Usage: freeze-selected-evaluation.mjs CORPUS_DIRECTORY DECLARATION.json [--common-support] [--include-validation] [--with-orchestration] [--benchmark-v1 --metadata-output FILE]');
}
if(!directory||!output)throw new Error('Usage: freeze-selected-evaluation.mjs CORPUS_DIRECTORY DECLARATION.json [--common-support] [--include-validation] [--with-orchestration] [--benchmark-v1 --metadata-output FILE]');
const commonSupport=options.has('--common-support');
if(commonSupport&&options.has('--with-orchestration'))
  throw new Error('Common-support outcome controls cannot include interactive orchestration');
const benchmark=options.has('--benchmark-v1'),metadataOutput=values.get('--metadata-output');
if(benchmark&&!metadataOutput)throw new Error('--benchmark-v1 requires a separate --metadata-output path');
if(!benchmark&&metadataOutput)throw new Error('--metadata-output is reserved for --benchmark-v1');
if(benchmark&&(options.has('--with-orchestration')||options.has('--include-validation')))
  throw new Error('benchmark-v1 freezes test-only source families; use --common-support for pure tasks');
const splits=options.has('--include-validation')?['test','validation']:['test'];
const manifest=JSON.parse(readFileSync(join(resolve(directory),'manifest.json'),'utf8'));
if(benchmark&&manifest.recipe?.name!=='benchmark-v1')throw new Error('--benchmark-v1 requires a benchmark-v1 generated corpus');
const candidates=manifest.cases.filter(item=>item.path&&splits.includes(item.split)).map(item=>{
  const episode=JSON.parse(readFileSync(join(resolve(directory),item.path),'utf8'));
  return controlledEvaluationCase(episode,{id:item.id,family:item.family,split:item.split});
});
// Every source task has exactly one canonical selected trajectory.
const cases=candidates.filter(item=>{
  const pure=Boolean(item.request.program&&item.request.invocation&&
    !item.request.program.capabilities.length&&!item.request.fixture.calls.length);
  return commonSupport?pure:!pure;
});
if(!cases.length)throw new Error('No independently verified held-out source families');
if(cases.some(item=>!item.request.controlledSelectionsByRepresentation.compact))
  throw new Error('A canonical selected trace is required for every source task');
if(options.has('--with-orchestration')){
  const children=cases.map(source=>controlledOrchestrationCase(source,{id:source.id+':orchestration'}));
  cases.push(...children);
}
const declaration={cases,name:commonSupport?'common-support':'effectful-tracks-events',
  thresholds:{wholeTaskSuccess:0.9,traceValid:1}
};
writeFileSync(output,JSON.stringify(declaration,null,2)+'\n');
if(benchmark){
  const metadata=buildBenchmarkCohortMetadata(manifest,declaration,
    [...new Set(cases.map(item=>item.family))]);
  writeFileSync(resolve(metadataOutput),JSON.stringify(metadata,null,2)+'\n');
}
process.stdout.write(JSON.stringify({cases:cases.length,families:[...new Set(cases.map(c=>c.family))]})+'\n');
