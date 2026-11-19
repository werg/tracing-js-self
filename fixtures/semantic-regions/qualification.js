import {SEMANTIC_GALLERY_FIXTURES} from '../../src/training/semantic-trace-gallery.js';
import {readFileSync} from 'node:fs';
import {expansionCoveragePopulation} from '../../src/semantic/expansion-benchmark.js';

export function regionQualificationFixtures(){return [
  {id:'ordered-map',source:'"use strict";function run(xs){return xs.map(x=>x*2);}',
    entry:'run',args:[[2,3,4]],family:'v8-contract-map',fixture:{calls:[]}},
  {id:'shared-getter',source:'"use strict";function run(x){const a=x+1;const b=a*2;let reads=0;const o={};Object.defineProperty(o,"v",{get:()=>{reads++;return 20;}});const price=o.v;return b+price+reads;}',
    entry:'run',args:[3],family:'v8-contract-getter',fixture:{calls:[]}},
  {...structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0')),id:'causal-counter'}
];}

// The interoperability population includes every declared source-qualified
// protocol golden, not just the original three shared-state examples.
export function regionQualificationPopulation({population='interoperability',allInputs=true}={}){
  if(population!=='interoperability')return expansionCoveragePopulation({population,allInputs});
  const declared=JSON.parse(readFileSync(new URL('../../test/fixtures/semantic-protocol-region-v8.json',import.meta.url),'utf8'));
  if(declared.schema!=='semantic-protocol-region-fixtures/1'||!Array.isArray(declared.cases)||!declared.cases.length)
    throw new TypeError('Missing declared source-qualified protocol fixtures');
  return {scripts:[...regionQualificationFixtures(),...declared.cases.map(row=>{
    if(row.id!==row.fixture?.id)throw new TypeError('Invalid protocol fixture identity');
    return structuredClone(row.fixture);
  })],modules:[]};
}
