import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

const json=value=>JSON.parse(JSON.stringify(value));
const snapshot=runtime=>json(Object.fromEntries(Object.entries(runtime).filter(([key])=>key!=='adapters')));

test('literal accessor metadata uses own names and preserves insertion order through conversion and restore',()=>{
  const body=`let calls='';const key={
    get [Symbol.toPrimitive](){calls+='s';return undefined;},
    get toString(){calls+='t';return ()=>({});},
    valueOf(){calls+='v';return 'x';},
    get constructor(){return 3;},get hasOwnProperty(){return 4;}
  };return [{x:9}[key],calls,Object.keys(key),key.constructor,key.hasOwnProperty];`;
  runtimeDifferential(body);
  const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run',args:[]});
  const cuts=[];
  while(runtime.state.control.a0.activeFrameId){
    const event=runtime.step();if(!event)break;
    if(event.instruction?.op==='DEFINE_LITERAL_PROP'||event.operation.startsWith('property.key.'))cuts.push(snapshot(runtime));
  }
  runtime.drive();
  const object=Object.values(runtime.state.heap).find(obj=>Object.hasOwn(obj.accessors??{},'toString'));
  assert.deepEqual(object.propertyOrder,['\u0000symbol:well-known:toPrimitive','toString','valueOf','constructor','hasOwnProperty']);
  for(const name of object.propertyOrder)assert.equal(object.propertyVersions[name],1,name);
  const expected=json(runtime.exportRun());
  assert.equal(validateBundle(expected).valid,true);
  assert.equal(replayExact(expected).valid,true);
  assert.ok(cuts.length>=5);
  for(const cut of cuts){
    const restored=Object.assign(createRuntime(),cut);restored.drive();
    assert.deepEqual(json(restored.exportRun()),expected);
  }
});

test('literal __proto__ data and accessors retain own metadata without mutating metadata prototypes',()=>{
  for(const body of [
    `const o={['__proto__']:1};o['__proto__'];return [Object.keys(o),o['__proto__']];`,
    `let value=1;const o={get __proto__(){return value;},set __proto__(v){value=v;}};o.__proto__=7;return [Object.keys(o),o.__proto__];`,
    `const o={get toString(){return 1;},toString:2,get valueOf(){return 3;},valueOf:4};return [Object.keys(o),o.toString,o.valueOf];`
  ]){
    runtimeDifferential(body);
    const r=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run',args:[]});
    r.drive();
    const bundle=json(r.exportRun());
    assert.equal(validateBundle(bundle).valid,true);
    assert.equal(replayExact(bundle).valid,true);
    for(const object of Object.values(r.state.heap)){
      for(const table of ['properties','accessors','propertyVersions','dataAttributes'])
        if(object[table])assert.equal(Object.getPrototypeOf(object[table]),Object.prototype);
      if(Object.hasOwn(object.properties??{},'__proto__')||Object.hasOwn(object.accessors??{},'__proto__')){
        assert.equal(Object.hasOwn(object.propertyVersions,'__proto__'),true);
        assert.equal(Number.isSafeInteger(object.propertyVersions.__proto__),true);
      }
    }
  }
});
