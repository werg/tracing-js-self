import {verifyRegionFamilyRegistry,REGION_DATASET_SPLITS} from '../src/semantic/family-registry-v8.js';

// Derive lifecycle denominators from authenticated current source membership.
// A past fixture's cardinality or split distribution is not an input policy.
export function verifyLifecycleSourcePopulation(registry,inventory,{verifyRegistry=verifyRegionFamilyRegistry}={}){
  verifyRegistry(registry);
  const ids=inventory?.sourceIds;
  if(inventory?.schema!=='semantic-v8-source-population/1'||inventory.registryDigest!==registry.digest||
    !Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)
    throw new Error('Support inventory must bind a nonempty set of unique sources to the prepared registry');
  const expected=new Set(registry.sources.map(row=>row.id));
  if(expected.size!==ids.length||ids.some(id=>!expected.has(id)))
    throw new Error('Prepared support registry differs from the immutable source inventory');
  const splitById=new Map(registry.components.flatMap(component=>
    component.sourceIds.map(id=>[id,component.split])));
  return {registryDigest:registry.digest,populationCount:ids.length,sourceIds:[...ids],splitSeed:registry.seed,
    splitCounts:Object.fromEntries(REGION_DATASET_SPLITS.map(split=>[split,
      registry.sources.filter(row=>splitById.get(row.id)===split).length])),
    trainSourceIds:registry.sources.filter(row=>splitById.get(row.id)==='train').map(row=>row.id)};
}

export function verifyLifecycleTargetPopulation(inventory,population){
  const ids=inventory?.sourceIds,expected=new Set(population.trainSourceIds);
  if(!expected.size||!Array.isArray(ids)||ids.length!==expected.size||new Set(ids).size!==ids.length||
    ids.some(id=>!expected.has(id))||inventory.trainEpisodeCount!==expected.size||
    inventory.registryDigest!==population.registryDigest||inventory.phaseMeter!=='P'||
    !Number.isSafeInteger(inventory.windowCount)||inventory.windowCount<1||
    !Number.isSafeInteger(inventory.optimizerWindowCount)||inventory.optimizerWindowCount<1||
    inventory.optimizerWindowCount>inventory.windowCount||
    !Number.isSafeInteger(inventory.phaseBudget)||inventory.phaseBudget<1||
    !Number.isSafeInteger(inventory.onePassMeterCount)||inventory.onePassMeterCount<0||
    inventory.onePassMeterCount>inventory.phaseBudget)
    throw new Error('Positive-loss target inventory differs from the authenticated support training split or job budget');
  return {valid:true,registryDigest:population.registryDigest,trainEpisodeCount:expected.size};
}
