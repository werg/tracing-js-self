import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticController} from '../src/training/controller.js';
import {encodeWitness as w} from '../src/training/format.js';

function arrayController(){
  const controller=new SemanticController([
    w('code',{entry:'run',source:'function run(){return 0;}',sites:[]}),
    w('input',{graph:{roots:[],objects:[]}})
  ]);
  controller.commit(w('allocate',{name:'a',kind:'array',length:1,
    properties:[{key:'0',value:['num',7]}]}));
  return controller;
}
const props=controller=>controller.heap.get('a').properties;
const write=(controller,key,value,present=true)=>
  controller.commit(w('write',{object:'a',key,value,present}));

test('deleting an array property never extends its selected length',()=>{
  const controller=arrayController();
  for(const key of ['3','0']){
    write(controller,key,['undefined'],false);
    assert.deepEqual(props(controller).get('length'),['num',1]);
    assert.equal(props(controller).has(key),false);
  }
});

test('selected writes use the ECMAScript array-index boundary',()=>{
  const controller=arrayController();
  for(const key of ['4294967295','4294967296','01','-0','²','١','1'.repeat(100)]){
    write(controller,key,['num',9]);
    assert.deepEqual(props(controller).get(key),['num',9]);
    assert.deepEqual(props(controller).get('length'),['num',1]);
  }
  write(controller,'3',['num',4]);
  assert.deepEqual(props(controller).get('length'),['num',4]);
  write(controller,'length',['num',0]);
  assert.equal(props(controller).has('0'),false);
  assert.equal(props(controller).has('3'),false);
  for(const key of ['4294967295','4294967296','01','-0','²','١','1'.repeat(100)])
    assert.deepEqual(props(controller).get(key),['num',9]);
});
