import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('../tools/module-region-reference-worker.mjs',import.meta.url));
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
function plan(modules,sourceDigestOverride){
 const files=Object.keys(modules).sort();
 const body={schema:'semantic-module-namespace-plan/1',entryModule:'entry.mjs',
   modules:files.map(file=>({file,sourceDigest:file==='dep.mjs'&&sourceDigestOverride?
     sourceDigestOverride:hash(modules[file])})),
   cells:[{id:'state.mjs#value',file:'state.mjs',local:'value',kind:'let',mutable:true,
     loweredName:'__traced_eval_m1_value'}],
   namespaces:[{file:'dep.mjs',namespaceName:'__traced_eval_namespace_0',
     exports:[{name:'value',cell:'state.mjs#value'}]}]};
 return {...body,digest:hash(body)};
}
function run(request){
 return spawnSync(process.execPath,['--no-warnings','--experimental-vm-modules',worker],{
   input:JSON.stringify(request),encoding:'utf8',timeout:10000,
   env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('NODE_TEST')))});
}
const modules={
 'state.mjs':'export let value=1; value=2;',
 'dep.mjs':"export {value} from './state.mjs';",
 'entry.mjs':"import * as view from './dep.mjs'; const key='value'; export function inspect(){ return [Object.keys(view),view[key],Object.getOwnPropertyDescriptor(view,'value').value]; }"
};
const inputGraph={
 objects:[
  {id:'o0',kind:'object',properties:[{key:'args',value:['ref','o1']}]},
  {id:'o1',kind:'array',properties:[{key:'length',value:['num',0]}]}
 ],roots:[['ref','o0']]
};
const base={entryModule:'entry.mjs',modules,inputGraph,
 exportName:'inspect',moduleNamespacePlan:plan(modules)};

test('original ESM namespace worker observes real link identity, cells, keys, reads and descriptors in order',()=>{
 const result=run(base);
 assert.equal(result.status,0,String(result.error??'')+'\n'+result.stdout+'\n'+result.stderr);
 const output=JSON.parse(result.stdout);
 assert.equal(output.status,'passed');
 assert.equal(output.outcome.kind,'return');
 assert.deepEqual(output.namespaceObservations,{
  schema:'semantic-module-namespace-observations/1',
  rows:[
   {kind:'namespace.create',moduleFile:'dep.mjs'},
   {kind:'cell.initialize',cell:'state.mjs#value',loweredName:'__traced_eval_m1_value',value:['num',1]},
   {kind:'cell.write',cell:'state.mjs#value',loweredName:'__traced_eval_m1_value',value:['num',2]},
   {kind:'namespace.keys',moduleFile:'dep.mjs',names:['value']},
   {kind:'namespace.read',moduleFile:'dep.mjs',exportName:'value',value:['num',2]},
   {kind:'namespace.descriptor',moduleFile:'dep.mjs',exportName:'value',
    value:{value:['num',2],writable:true,enumerable:true,configurable:false}}
  ]
 });
});

test('original ESM namespace worker rejects source digest substitution',()=>{
 const tampered={...base,moduleNamespacePlan:plan(modules,'0'.repeat(64))};
 const result=run(tampered);
 assert.equal(result.status,0,String(result.error??'')+'\n'+result.stdout+'\n'+result.stderr);
 assert.equal(JSON.parse(result.stdout).status,'unsupported');
 assert.match(JSON.parse(result.stdout).reason,/source/i);
});

test('original ESM namespace worker refuses namespace escapes and non-scalar cells',()=>{
 const escaped={...base,modules:{...modules,'entry.mjs':"import * as view from './dep.mjs'; export function inspect(){return view;}"},
  moduleNamespacePlan:plan({...modules,'entry.mjs':"import * as view from './dep.mjs'; export function inspect(){return view;}"})};
 const escapeResult=run(escaped);
 assert.equal(JSON.parse(escapeResult.stdout).status,'unsupported');
 const nonscalar={...base,modules:{...modules,'state.mjs':"export let value={x:1};"},
  moduleNamespacePlan:plan({...modules,'state.mjs':"export let value={x:1};"})};
 const scalarResult=run(nonscalar);
 assert.equal(JSON.parse(scalarResult.stdout).status,'unsupported');
 assert.match(JSON.parse(scalarResult.stdout).reason,/scalar/i);
});
