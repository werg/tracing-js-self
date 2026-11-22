// This fixed 64-source cohort supports production behavior checks only. It is
// a separate population and cannot replace or shrink the original 66/665
// evaluation denominator. Every declared member is frozen before execution.
import {semanticRecipeFamilies} from '../../src/training/recipe-fixtures.js';
import {buildRegionFamilyRegistry,REGION_DATASET_SPLITS} from '../../src/semantic/family-registry-v8.js';
import {hashAlgorithmData} from '../../src/semantic/program.js';

export const SEMANTIC_REGION_SUPPORT_COHORT_SCHEMA='semantic-region-support-cohort/1';
export const SEMANTIC_REGION_SUPPORT_COHORT_SEED=17;
export const SEMANTIC_REGION_SUPPORT_VARIANTS=Object.freeze([
  'pure','callbacks-recovery','repeated-2calls','child-teacher'
]);

const clone=structuredClone;
function freeze(value){
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}
const memberId=(template,variant)=>`se-support-${template}-${variant}`;
function member(family,variant,fixture){
  return {...clone(fixture),id:memberId(family.template,variant),
    supportCohort:{schema:'semantic-region-support-member/1',template:family.template,variant}};
}

/**
 * Construct the full, data-only support inventory and its pre-execution split.
 * No source is run here, and no row is selected or dropped by its result.
 */
export function buildSemanticRegionSupportCohortV8(){
  const families=semanticRecipeFamilies(),fixtures=[];
  for(const family of families){
    const pure=member(family,'pure',family.pure);
    fixtures.push(pure);
    fixtures.push(member(family,'callbacks-recovery',family.callbacks));
    const first=family.repeated.cases[0];
    fixtures.push({...member(family,'repeated-2calls',first),source:first.source,entry:first.entry,
      ancestorIds:clone(first.ancestorIds),sessionCases:clone(family.repeated.cases)});
    fixtures.push({...member(family,'child-teacher',family.pure),orchestrationTeacher:true});
  }

  const sourceRows=fixtures.map(fixture=>({id:fixture.id,family:fixture.family,
    ancestors:clone(fixture.ancestorIds??[]),source:fixture.source,entry:fixture.entry}));
  const registry=buildRegionFamilyRegistry(sourceRows,{seed:SEMANTIC_REGION_SUPPORT_COHORT_SEED});
  const splitById=new Map(registry.components.flatMap(component=>
    component.sourceIds.map(id=>[id,component.split])));
  const sourceCounts=Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,0]));
  for(const source of registry.sources)sourceCounts[splitById.get(source.id)]++;
  const body={schema:SEMANTIC_REGION_SUPPORT_COHORT_SCHEMA,
    seed:SEMANTIC_REGION_SUPPORT_COHORT_SEED,templateCount:families.length,
    fixtureCount:fixtures.length,variants:[...SEMANTIC_REGION_SUPPORT_VARIANTS],
    sourceCounts,fixtures,registry};
  return freeze({...body,digest:hashAlgorithmData(body)});
}
