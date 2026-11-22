#!/usr/bin/env node
// One connected registry spans authored, real-source and generated inventories.
// Freeze this before collecting any input/schedule expansions or inspecting loss.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {trainingCandidateTasks,candidateSourceInventory,SOURCE_RECIPES} from '../src/corpus/training-candidates.mjs';
import {buildSourceRegistry,verifySourceRegistry,canonicalHash} from '../src/corpus/source-registry.mjs';
import {SourceCloneResourceError} from '../src/corpus/source-clusters.mjs';

const options=new Map(),allowed=new Set(['--out','--recipes','--source-stream','--per-family',
  '--generated-families','--generation-seed','--input-seed','--split-seed',
  '--holdout-projects','--holdout-compositions','--prior-registry',
  '--clone-max-comparisons','--clone-max-candidate-visits','--clone-max-index-entries']);
for(let index=2;index<process.argv.length;index++){
  const key=process.argv[index],value=process.argv[++index];
  if(!allowed.has(key)||options.has(key)||!value||value.startsWith('--'))throw new Error('Invalid option '+key);
  options.set(key,value);
}
if(!options.has('--out'))throw new Error('--out is required');
const root=fileURLToPath(new URL('..',import.meta.url));
const producerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const recipes=(options.get('--recipes')??SOURCE_RECIPES.join(',')).split(',');
const tasks=recipes.flatMap(recipe=>trainingCandidateTasks(recipe,{root,
  streams:(options.get('--source-stream')??'utilities,exercism,production').split(','),
  // Every pinned callback wrapper source is registered before selecting inputs.
  perFamily:Number(options.get('--per-family')??12),generatedFamilies:Number(options.get('--generated-families')??16),
  generationSeed:Number(options.get('--generation-seed')??73),inputSeed:Number(options.get('--input-seed')??89)}));
let sources=candidateSourceInventory(tasks,{producerRevision}),previous=null;
if(options.has('--prior-registry')){
  previous=JSON.parse(readFileSync(resolve(options.get('--prior-registry')),'utf8'));
  verifySourceRegistry(previous);
  // Keep prior versions as lineage evidence. A new source revision cannot
  // escape its component merely because the old source is no longer generated.
  const existing=new Set(sources.map(row=>row.id));
  sources.push(...previous.sources.filter(row=>!existing.has(row.id)));
}
const cloneBudget=Object.fromEntries([
  ['--clone-max-comparisons','maxComparisons'],['--clone-max-candidate-visits','maxCandidateVisits'],
  ['--clone-max-index-entries','maxIndexEntries']].filter(([flag])=>options.has(flag))
  .map(([flag,key])=>[key,Number(options.get(flag))]));
const policy={seed:Number(options.get('--split-seed')??17),cloneBudget,
  holdoutProjects:(options.get('--holdout-projects')??'').split(',').filter(Boolean),
  holdoutCompositions:(options.get('--holdout-compositions')??'').split(',').filter(Boolean)};
let registry;
try{registry=buildSourceRegistry(sources,policy);}
catch(error){
  if(error instanceof SourceCloneResourceError)atomicWrite(resolve(options.get('--out'))+'.failure.json',
    JSON.stringify({status:error.status,complete:false,reason:error.message,resource:error.resource,
      budget:error.budget,costs:error.costs,sources,policy,producerRevision,
      sourceInventoryDigest:canonicalHash(sources),command:process.argv.slice(1),
      runtime:{node:process.version,v8:process.versions.v8},
      retry:'Rerun these original sources with an increased resource budget; no partial registry was admitted.'},null,2)+'\n');
  throw error;
}
if(previous)for(const component of previous.components)for(const family of component.members){
  const current=registry.components.find(row=>row.members.includes(family));
  if(!current||current.split!==component.split)throw new Error('Registry extension would reassign frozen split for '+family+'; retain stable family IDs or quarantine the conflicting release');
}
atomicWrite(resolve(options.get('--out')),JSON.stringify(registry,null,2)+'\n');
console.log(JSON.stringify({digest:canonicalHash(registry),recipes,...registry.diagnostics,
  holdoutProjects:registry.holdoutProjects,holdoutCompositions:registry.holdoutCompositions}));
