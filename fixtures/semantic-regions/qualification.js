import {SEMANTIC_GALLERY_FIXTURES} from '../../src/training/semantic-trace-gallery.js';

export function regionQualificationFixtures(){return [
  {id:'ordered-map',source:'"use strict";function run(xs){return xs.map(x=>x*2);}',
    entry:'run',args:[[2,3,4]],family:'v8-contract-map',fixture:{calls:[]}},
  {id:'shared-getter',source:'"use strict";function run(x){const a=x+1;const b=a*2;let reads=0;const o={};Object.defineProperty(o,"v",{get:()=>{reads++;return 20;}});const price=o.v;return b+price+reads;}',
    entry:'run',args:[3],family:'v8-contract-getter',fixture:{calls:[]}},
  {...structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0')),id:'causal-counter'}
];}
