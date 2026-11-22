import {SEMANTIC_GALLERY_FIXTURES} from '../../src/training/semantic-trace-gallery.js';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {expansionCoveragePopulation} from '../../src/semantic/expansion-benchmark.js';
import {HOST_PROTOCOL_FIXTURES_V8} from './host-protocol.js';
import {RETURN_CALLBACK_FIXTURES} from './return-callbacks.js';
import {PRIMITIVE_CONVERSION_FIXTURES} from './primitive-conversion.js';
import {PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES} from './primitive-conversion-composition.js';

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
    entry:'run',args:[],family:'v8-contract-shared-protocol-source',fixture:{calls:[]}},
  {id:'promise-map-iterator',source:'"use strict";async function run(){const p=new Promise(resolve=>{'+
    'const bytes=new Uint8Array(1);const proxy=new Proxy({x:3},{get:function(object,key){bytes[0]=object[key];return bytes[0]+1;}});'+
    'const converted=Number({valueOf:function(){return proxy.x;}});'+
    'const result=[converted].map(function(value,index,array){const cursor=[value,index].values();'+
    'return cursor.next().value+1;});resolve(result[0]+bytes[0]);});'+
    'const values=await Promise.all([p,Promise.resolve(2)]);return values[0]+values[1];}',
    entry:'run',args:[],family:'v8-contract-shared-map-iterator',fixture:{calls:[]}},
  {id:'map-callback-finally-throw',source:'"use strict";function run(){let cleaned=0;try{return [2].map(function(value){'+
    'try{throw value;}finally{cleaned+=5;}})[0];}catch(error){return cleaned+error;}}',
    entry:'run',args:[],family:'v8-contract-map-finally',fixture:{calls:[]}},
  {id:'map-generator-yield',source:'"use strict";function run(){const values=[2,3].map(function*(value){yield value+1;});'+
    'return values[0].next().value+values[1].next().value;}',
    entry:'run',args:[],family:'v8-contract-map-generator',fixture:{calls:[]}},
  {id:'map-generator-iterator-close',source:'"use strict";function run(){let closed=0;const iterable={[Symbol.iterator]:function(){return this},'+
    'next:function(){return {value:3,done:false}},return:function(){closed++;throw 2}};const gen=[iterable].map(function*(it){'+
    'try{for(const value of it){yield value;break}}finally{closed+=10}})[0];gen.next();try{gen.return(8)}catch(error){return closed*10+error}return 0;}',
    entry:'run',args:[],family:'v8-contract-map-generator-iterator-close',fixture:{calls:[]}},
  {id:'map-sparse-live-mutation',source:'"use strict";function run(){const input=[1,,3,,];let calls=0;'+
    'const output=input.map(function(value,index,array){calls++;if(index===0){array[1]=7;array[2]=8;array.push(9);}return value+index;});'+
    'return [input,output,calls];}',entry:'run',args:[],family:'v8-contract-map-sparse-live',fixture:{calls:[]}},
  {id:'promise-map-sparse-truncate',source:'"use strict";async function run(){const p=new Promise(resolve=>{'+
    'const input=[1,2,3];const output=input.map(function(value,index,array){if(index===0)array.length=1;return value;});'+
    'resolve(output.length+output[0]);});return await p;}',
    entry:'run',args:[],family:'v8-contract-promise-map-sparse',fixture:{calls:[]}},
  {id:'promise-allsettled-mixed-aliases',source:'"use strict";async function run(){const p=Promise.resolve({x:3});'+
    'const rows=await Promise.allSettled([p,Promise.reject(7),p]);return [rows[0]===rows[2],rows[0].value===rows[2].value,rows];}',
    entry:'run',args:[],family:'v8-contract-promise-allsettled-mixed',fixture:{calls:[]}},
  {id:'promise-allsettled-nested-executor',source:'"use strict";async function run(){const p=new Promise(resolve=>resolve(3));'+
    'return await Promise.all([Promise.allSettled([p,Promise.reject(4)]),Promise.resolve(5)]);}',
    entry:'run',args:[],family:'v8-contract-promise-allsettled-composition',fixture:{calls:[]}},
  {id:'promise-allsettled-empty-mutation',source:'"use strict";async function run(){const rows=await Promise.allSettled([]);rows.push(7);return rows;}',
    entry:'run',args:[],family:'v8-contract-promise-allsettled-empty',fixture:{calls:[]}}
];}

// Original module graphs retain their own source/reference evidence before
// entering the shared public/native qualification path.
export function moduleQualificationFixtures(){return [
  {id:'module-namespace-shadow-live',family:'v8-contract-module-namespace-shadow',
    moduleEntry:'main.js',exportName:'run',args:[],modules:{
      'leaf.js':'export let n=2;export function bump(){n+=3;}',
      'barrel.js':"export * as cells from './leaf.js';",
      'main.js':"import {cells} from './barrel.js';import {bump} from './leaf.js';"+
        'function local(cells){cells.n+=1;return cells.n;}export function run(){const before=cells.n;'+
        'bump();return [before,cells.n,local({n:7}),cells.missing];}'}},
  {id:'module-scoped-var-isolation',family:'v8-contract-module-var-scope',
    moduleEntry:'main.js',exportName:'run',args:[],modules:{
      'leaf.js':'{var shared=3;}export function read(){return shared;}',
      'main.js':"import {read} from './leaf.js';const before=shared;{var shared=9;}"+
        'export function run(){return [before,shared,read()];}'}},
  {id:'module-destructured-live-cells',family:'v8-contract-module-destructured-cells',
    moduleEntry:'main.js',exportName:'run',args:[],modules:{
      'state.js':'export let {value=3}={value:7};export const [step]=[2];'+
        'export function bump(){value+=step;}',
      'main.js':"import {value,bump} from './state.js';"+
        'export function run(){const before=value;bump();return [before,value];}'}}
];}

// The five original source refusals remain in the separate twenty-four-row
// conversion inventory. These nineteen accepted sources extend the recurring
// selected population; they do not replace any earlier family or imply that
// the refused inputs, or the complete language population, qualify.
export function primitiveConversionQualificationFixtures(){
  return [...PRIMITIVE_CONVERSION_FIXTURES,...PRIMITIVE_CONVERSION_COMPOSITION_FIXTURES]
    .filter(fixture=>!fixture.boundary).map(fixture=>structuredClone(fixture));
}

// The interoperability population includes every declared source-qualified
// protocol golden, not just the original three shared-state examples.
export function regionQualificationPopulation({population='interoperability',allInputs=true}={}){
  if(population!=='interoperability')return expansionCoveragePopulation({population,allInputs});
  const declared=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    new URL('../../test/fixtures/semantic-protocol-region-v8.json.gz.b64',import.meta.url),'utf8'),'base64')).toString());
  if(declared.schema!=='semantic-protocol-region-fixtures/1'||!Array.isArray(declared.cases)||!declared.cases.length)
    throw new TypeError('Missing declared source-qualified protocol fixtures');
  return {scripts:[...regionQualificationFixtures(),...declared.cases.map(row=>{
    if(row.id!==row.fixture?.id)throw new TypeError('Invalid protocol fixture identity');
    return structuredClone(row.fixture);
  }),...structuredClone(HOST_PROTOCOL_FIXTURES_V8),...sharedProtocolQualificationFixtures(),
  ...RETURN_CALLBACK_FIXTURES.map(({expected,callbacks,...fixture})=>({
    ...structuredClone(fixture),id:fixture.family.replace(/-source$/,'')})),
  ...primitiveConversionQualificationFixtures()],
    modules:moduleQualificationFixtures()};
}
