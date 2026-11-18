import {EFFECTFUL_ENGINEERING_FIXTURES} from '../training/engineering-fixtures.js';
import {semanticRecipeFamilies,benchmarkFamiliesV1} from '../training/recipe-fixtures.js';
import {trustedRealSourceCases} from './trusted-source-candidates.mjs';
import {generatedProgramCases} from './generated-programs.mjs';
import {canonicalHash} from './source-registry.mjs';

export const SOURCE_RECIPES=['engineering','training-v4','benchmark-v1','real-source','generated-v1'];
export function trainingCandidateTasks(recipe,{root=process.cwd(),perFamily=2,mutationsPerFamily=0,
    streams=['utilities','exercism','production'],generatedFamilies=16,generationSeed=73,inputSeed=89}={}){
  if(!SOURCE_RECIPES.includes(recipe))throw new Error('Unknown source recipe '+recipe);
  const tasks=[],source=fixture=>tasks.push({kind:'source',fixture});
  if(recipe==='engineering'){
    EFFECTFUL_ENGINEERING_FIXTURES.forEach(source);
    tasks.push({kind:'session',fixture:{id:'repeated-ingress',family:'async-counter',
      cases:EFFECTFUL_ENGINEERING_FIXTURES.slice(0,2)}});
  }else if(recipe==='real-source')trustedRealSourceCases({root,streams,perFamily,mutationsPerFamily}).forEach(source);
  else if(recipe==='generated-v1')generatedProgramCases({families:generatedFamilies,perFamily,generationSeed,inputSeed}).forEach(source);
  else for(const family of recipe==='training-v4'?semanticRecipeFamilies({}):benchmarkFamiliesV1({})){
    source({...family.pure,role:'common-support'});source({...family.callbacks,role:'effectful'});
    tasks.push({kind:'session',fixture:{...family.repeated,role:'effectful'}});
  }
  return tasks;
}
export function candidateSourceInventory(tasks,{producerRevision=null}={}){
  const rows=new Map();
  for(const task of tasks)for(const fixture of task.kind==='source'?[task.fixture]:task.fixture.cases){
    // Identical source bytes are one inventory variant even when 12 pinned
    // invocation wrappers and every input reference them.
    const sourceHash=canonicalHash(fixture.source),id=task.fixture.family+':'+sourceHash.slice(0,24);
    const record={id,family:task.fixture.family,source:fixture.source,
      ancestorIds:fixture.ancestorIds??[],project:fixture.provenance?.upstream?.repository??
        (fixture.provenance?.schema==='bounded-program-grammar/1'?'bounded-generated-grammar':'repository-authored'),
      upstreamPath:fixture.provenance?.upstream?.path??null,
      upstreamRevision:fixture.provenance?.upstream?.revision??producerRevision,
      composition:fixture.provenance?.composition??null};
    if(rows.has(id)&&canonicalHash(rows.get(id))!==canonicalHash(record))
      throw new Error('Source inventory lineage conflict for identical family/source');
    rows.set(id,record);
  }
  return [...rows.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
