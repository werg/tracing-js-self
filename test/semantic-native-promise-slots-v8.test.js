import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {referenceCommand,referenceEnvironment} from '../src/corpus/reference-isolation.mjs';
import {independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {createNativeProtocolMetadata} from '../src/semantic/protocol-metadata-v8.js';

const observer=new URL('../src/semantic/native-promise-result-v8.js',import.meta.url).href;
const worker=fileURLToPath(new URL('../tools/protocol-reference-v8.mjs',import.meta.url));
function child(source,{nativeSlots=true}={}){
  const result=spawnSync(process.execPath,[...(nativeSlots?['--expose-internals']:[]),'--input-type=module','--eval',
    `import assert from 'node:assert/strict';import {inspectNativePromiseSettlementV8 as observe} from ${JSON.stringify(observer)};\n`+source],
  {env:referenceEnvironment(),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}

test('native Promise slots retain pending, primitive, object and Error identities without guest hooks',()=>{
  const receipt=child(`
    process.on('unhandledRejection',()=>{});
    const calls={stack:0,then:0,constructor:0,species:0};
    Object.defineProperty(Promise,Symbol.species,{get(){calls.species++;return Promise;},configurable:true});
    const object={n:0},error=new Error('result'),unrelated=new Error('unrelated');
    for(const value of [error,unrelated])Object.defineProperty(value,'stack',{
      get(){calls.stack++;object.n++;return 'observed stack';},configurable:true});
    const values=[object,error,undefined,-0,NaN,17n];
    let checked=0;
    for(const rejected of [false,true])for(const value of values){
      const promise=rejected?Promise.reject(value):Promise.resolve(value);
      Object.defineProperties(promise,{unrelated:{value:unrelated},
        constructor:{get(){calls.constructor++;return Promise;}},
        then:{get(){calls.then++;return Promise.prototype.then;}}});
      const result=await observe(promise);
      assert.equal(result.status,rejected?'rejected':'fulfilled');
      assert.equal(result.kind,rejected?'throw':'return');assert(Object.is(result.value,value));checked++;
    }
    assert.deepEqual(await observe(new Promise(()=>{})),{status:'pending'});
    await assert.rejects(observe(new Proxy(Promise.resolve(1),{get(){throw 91;}})),/branded Promise/);
    assert.deepEqual(calls,{stack:0,then:0,constructor:0,species:0});assert.equal(object.n,0);
    console.log(JSON.stringify({checked,calls,n:object.n,node:process.version}));
  `);
  assert.equal(receipt.checked,12);assert.deepEqual(receipt.calls,{stack:0,then:0,constructor:0,species:0});
});

test('native Promise observation refuses unavailable slot access without an inspector fallback',()=>{
  const receipt=child(`
    let calls=0;const p=Promise.resolve(1);
    Object.defineProperty(p,'constructor',{get(){calls++;throw 3;}});
    await assert.rejects(observe(p),error=>error.category==='unsupported.native-promise-observer'&&
      /requires native Promise slot access/.test(error.message));
    assert.equal(calls,0);console.log(JSON.stringify({calls}));
  `,{nativeSlots:false});
  assert.equal(receipt.calls,0);
  const result=spawnSync(process.execPath,[worker],{env:referenceEnvironment(),encoding:'utf8',timeout:10000,
    input:JSON.stringify({source:'function run(){try{return Promise.resolve(1);}catch(error){return 99;}}',
      entry:'run',inputGraph:encodeNativeGraph([]),awaitReturnedPromise:true,mode:'original'})});
  assert.equal(result.status,1,result.stderr||String(result.error));
  const failure=JSON.parse(result.stdout);assert.equal(failure.category,'unsupported.native-promise-observer');
  assert.equal(failure.phase,'execute');assert.match(failure.error,/requires native Promise slot access/);
});

test('only the trusted protocol reference worker receives native slot access',()=>{
  const original=referenceCommand(worker,{timeoutMs:100,isolation:'trusted-process'});
  const selected=referenceCommand(worker,{timeoutMs:100,isolation:'trusted-process',nativePromiseSlots:true});
  assert.deepEqual(original.args,[worker]);assert.deepEqual(selected.args,['--expose-internals',worker]);
  assert.equal(selected.env.NODE_OPTIONS,undefined);
  assert.throws(()=>referenceCommand(fileURLToPath(import.meta.url),{timeoutMs:100,nativePromiseSlots:true}),/restricted/);
  if(process.platform==='linux'){
    const isolated=referenceCommand(worker,{timeoutMs:100,isolation:'linux-namespace',nativePromiseSlots:true});
    try{assert(isolated.args.includes('--native-promise-slots'));assert.equal(isolated.env.NODE_OPTIONS,undefined);}
    finally{isolated.cleanup();}
  }else assert.throws(()=>referenceCommand(worker,{timeoutMs:100,isolation:'linux-namespace',nativePromiseSlots:true}),/unavailable/);
});

test('independent original completion ignores unrelated Error stack hooks on returned Promises',async()=>{
  const source=`function run(){const result=[];const p=Promise.resolve(result);const error=new Error('unrelated');
    Object.defineProperty(error,'stack',{get(){result.push('stack');return 'changed';}});
    Object.defineProperty(p,'unrelated',{value:error});
    Object.defineProperty(p,'constructor',{get(){result.push('constructor');throw 4;}});
    Object.defineProperty(p,'then',{get(){result.push('then');throw 5;}});return p;}`;
  for(const mode of ['original','operations','branches','completions']){
    const result=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([]),
      awaitReturnedPromise:true,mode});
    assert.deepEqual(result.outcome,{kind:'return',graph:{roots:[['ref','o0']],objects:[
      {id:'o0',kind:'array',properties:[['length',['num',0]]]}]}});
  }
});

test('full reference completion preserves a genuine rejected Error without reading its stack',async()=>{
  const source=`function run(input){const error=new TypeError('expected');
    Object.defineProperty(error,'stack',{get(){input.push('stack');throw 99;}});
    const p=Promise.reject(error);Object.defineProperty(p,'constructor',{get(){input.push('constructor');throw 98;}});return p;}`;
  for(const mode of ['original','operations','branches','completions']){
    const result=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([[]]),
      awaitReturnedPromise:true,mode});
    assert.equal(result.outcome.kind,'throw');
    assert.deepEqual(result.outcome.graph.objects[0].properties,[['length',['num',0]]]);
    assert.deepEqual(result.outcome.graph.objects[1].properties,[['name',['str','TypeError']],['message',['str','expected']]]);
  }
});

test('metadata and final Error boundaries never invoke name, tag or stack getters',async()=>{
  let calls=0;const error=new Error('expected');
  for(const key of ['name','stack',Symbol.toStringTag])Object.defineProperty(error,key,{
    get(){calls++;throw 99;},configurable:true});
  createNativeProtocolMetadata().observe('error','return',error);assert.equal(calls,0);
  for(const [resolution,reason]of [['resolve',/custom prototype/],['reject',/Error extensions/]]){
    const source=`function run(){const error=new Error('expected');
      for(const key of ['name','stack',Symbol.toStringTag])Object.defineProperty(error,key,{get(){throw 'getter invoked';}});
      return Promise.${resolution}(error);}`;
    await assert.rejects(independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([]),
      awaitReturnedPromise:true,mode:'original'}),failure=>failure.category==='unsupported.protocol-reference'&&reason.test(failure.message));
  }
});

test('native slot access adds no process, require or internal binding to the guest realm',async()=>{
  const source='async function run(){return [typeof process,typeof require,typeof internalBinding];}';
  const result=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([]),
    awaitReturnedPromise:true,mode:'original'});
  assert.deepEqual(result.outcome.graph.objects[0].properties,[['0',['str','undefined']],['1',['str','undefined']],
    ['2',['str','undefined']],['length',['num',3]]]);
});

test('the confined protocol worker reads native slots under its existing namespace restrictions',async t=>{
  if(process.platform!=='linux'){t.skip('Linux namespaces are required');return;}
  const probe=spawnSync('/usr/bin/unshare',['--user','--map-root-user','--mount','--net','--pid','--fork','true'],
    {encoding:'utf8',timeout:5000});
  if(probe.status!==0){t.skip('Unprivileged namespaces unavailable: '+(probe.error?.message??probe.stderr.trim()));return;}
  const source=`function run(){const error=new Error('unrelated');
    Object.defineProperty(error,'stack',{get(){throw 'stack getter invoked';}});
    const p=Promise.resolve(7);Object.defineProperty(p,'extra',{value:error});return p;}`;
  for(const mode of ['original','completions']){
    const result=await independentProtocolSourceReference({source,entry:'run',inputGraph:encodeNativeGraph([]),
      awaitReturnedPromise:true,mode},{isolation:'linux-namespace',timeoutMs:15000});
    assert.deepEqual(result.outcome,{kind:'return',graph:{roots:[['num',7]],objects:[]}});
  }
});
