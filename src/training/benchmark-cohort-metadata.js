import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Versioned sidecar builder; the Megatoken v4 frozen cohort remains unchanged. */
export function buildBenchmarkCohortMetadata(manifest,declaration,selectedFamilies){
  if(manifest?.recipe?.name!=='benchmark-v1'||!Array.isArray(manifest.recipe.algorithms)||
    !Array.isArray(manifest.cases)||!Array.isArray(declaration?.cases)||
    !Array.isArray(selectedFamilies)||!selectedFamilies.length)
    throw new TypeError('Benchmark sidecar requires a benchmark-v1 manifest and frozen cases');
  const algorithms=new Map();
  for(const item of manifest.recipe.algorithms){
    if(typeof item.family!=='string'||typeof item.name!=='string'||typeof item.ancestor!=='string'||
      !/^[0-9a-f]{64}$/.test(item.normalizedAstDigest??'')||!['train','validation','test'].includes(item.split)||
      algorithms.has(item.family))throw new TypeError('Invalid or duplicated benchmark algorithm lineage');
    algorithms.set(item.family,item);
  }
  const unique=[...new Set(selectedFamilies)];
  if(unique.length!==selectedFamilies.length||unique.some(family=>!algorithms.has(family)))
    throw new Error('Frozen cohort contains unknown or repeated benchmark families');
  const familyRows=unique.sort().map(family=>{
    const algorithm=algorithms.get(family);
    const roles=[...new Set(manifest.cases.filter(item=>item.family===family).map(item=>item.role)
      .filter(role=>typeof role==='string'))].sort();
    if(!roles.length)throw new Error('Benchmark family has no emitted role coverage');
    return {family,algorithm:algorithm.name,sourceAncestor:algorithm.ancestor,split:algorithm.split,
      roles,normalizedAstDigest:algorithm.normalizedAstDigest};
  });
  return {schema:'semantic-benchmark-cohort-metadata/1',recipe:manifest.recipe.name,
    sourceManifestDigest:digest(manifest),declarationDigest:digest(declaration),families:familyRows};
}
