import {SEMANTIC_GALLERY_FIXTURES} from '../../src/training/semantic-trace-gallery.js';
import {readFileSync} from 'node:fs';
import {expansionCoveragePopulation} from '../../src/semantic/expansion-benchmark.js';
import {HOST_PROTOCOL_FIXTURES_V8} from './host-protocol.js';

export function regionQualificationFixtures(){return [
  {id:'ordered-map',source:'"use strict";function run(xs){return xs.map(x=>x*2);}',
    entry:'run',args:[[2,3,4]],family:'v8-contract-map',fixture:{calls:[]}},
  {id:'shared-getter',source:'"use strict";function run(x){const a=x+1;const b=a*2;let reads=0;const o={};Object.defineProperty(o,"v",{get:()=>{reads++;return 20;}});const price=o.v;return b+price+reads;}',
    entry:'run',args:[3],family:'v8-contract-getter',fixture:{calls:[]}},
  {...structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0')),id:'causal-counter'},
  {id:'number-callback-cleanup',source:'"use strict";function run(){const o={valueOf(){throw 7;}};try{return Number(o);}finally{return 9;}}',
    entry:'run',args:[],family:'v8-contract-number-cleanup',fixture:{calls:[]}},
  {id:'custom-iterator-close',source:'"use strict";function run(){let c=0;const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){c++;return {};}};for(const x of it){break;}return c;}',
    entry:'run',args:[],family:'v8-contract-custom-iterator',fixture:{calls:[]}},
  {id:'iterable-binding-close',source:'"use strict";function run(){let c=0;const it={[Symbol.iterator](){return this;},next(){return {done:false,value:1};},return(){c++;return {};}};const [x]=it;return x+c;}',
    entry:'run',args:[],family:'v8-contract-iterable-binding',fixture:{calls:[]}}
];}

// Recurring cross-family source/native qualification is broader than the
// frozen wire examples. Adding source coverage need not revise wire goldens.
export function sharedProtocolQualificationFixtures(){return [
  {id:'promise-number-proxy-memory-join',source:'"use strict";async function run(){'+
    'const p=new Promise(resolve=>{const bytes=new Uint8Array(2);'+
    'const proxy=new Proxy({x:3},{get:function(object,key){bytes[0]=object[key];return bytes[0]+1;}});'+
    'resolve(Number({valueOf:function(){return proxy.x;}}));});'+
    'const values=await Promise.all([p,Promise.resolve(2)]);return values[0]+values[1];}',
    entry:'run',args:[],family:'v8-contract-shared-protocol-source',fixture:{calls:[]}}
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
  }),...structuredClone(HOST_PROTOCOL_FIXTURES_V8),...sharedProtocolQualificationFixtures()],modules:[]};
}
