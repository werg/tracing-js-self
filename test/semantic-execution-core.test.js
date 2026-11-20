import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {SemanticExecutionController} from '../src/semantic/execution-controller.js';
import {SemanticControllerV8} from '../src/semantic/controller-v8.js';
import {SemanticController} from '../src/training/controller.js';
import {encodeWitness} from '../src/training/format.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const record=(kind,fields)=>({kind,fields});
const num=value=>['num',value];
const context=(source='function run(){return 3;}')=>[
  record('code',{entry:'run',source,sites:analyzeSemanticProgram(source).sites,randomSeed:0}),
  record('input',{graph:{roots:[],objects:[]}})
];
const wire6=record=>encodeWitness(record.kind,record.fields);
const wire8=record=>encodeDetailedRecord(record);
function clients(source,options={}){
  const typed=context(source);
  return [new SemanticExecutionController(typed,options),
    new SemanticController(typed.map(wire6),options),
    new SemanticControllerV8(typed.map(wire8),options)];
}
function state(controller){
  const {schema,history,...rest}=controller.segmentPacket();return rest;
}
function commitAll(controllers,record,options){
  controllers[0].commitRecord(record,options);
  controllers[1].commit(wire6(record),options);
  controllers[2].commit(wire8(record),options);
  assert.deepEqual(state(controllers[1]),state(controllers[0]));
  assert.deepEqual(state(controllers[2]),state(controllers[0]));
}

test('neutral typed state and both wire clients preserve transitions and continuation',()=>{
  let controllers=clients();
  const records=[
    record('compute',{expr:{op:'binary',operator:'+',left:{op:'literal',value:num(1)},
      right:{op:'literal',value:num(2)}},result:num(3),bind:'answer'}),
    record('allocate',{name:'a',kind:'array',length:1,properties:[{key:'0',value:num(3)}]}),
    record('write',{object:'a',key:'2',value:num(5),present:true}),
    record('read',{object:'a',key:'2',value:num(5),present:true}),
    record('return',{value:['ref','a']}),record('end',{kind:'return'})
  ];
  for(const [index,selected] of records.entries()){
    commitAll(controllers,selected);
    if(index===2)controllers=controllers.map(controller=>
      controller.constructor.fromPacket(JSON.parse(JSON.stringify(controller.segmentPacket()))));
  }
  assert.deepEqual(controllers[0].materialize(controllers[0].completion.value),[3,,5]);
  assert.deepEqual(controllers[0].history.map(row=>row.record),records);
  assert.deepEqual(controllers[1].history.map(row=>row.record),records.map(wire6));
  assert.deepEqual(controllers[2].history.map(row=>row.record),records.map(wire8));
  assert.equal(controllers[2].segmentPacket().schema,'semantic-continuation/8');
});

test('typed state preserves broker authority, suspension, delivery, and resumed completion',()=>{
  const source='async function run(){return await host.readAsync("key");}';
  let controllers=clients(source,{capabilities:['demo.readAsync'],observationAuthority:'broker',
    completionPolicy:'await-returned-promise',strictRequests:true});
  const found=analyzeSemanticProgram(source).sites.find(site=>site.operation==='demo.readAsync');
  const site={start:found.start,end:found.end};
  commitAll(controllers,record('promise',{action:'create',promise:'root'}));
  commitAll(controllers,record('request',{effect:'e',operation:'demo.readAsync',arguments:[['str','key']],
    invocation:'i1',site,payload:'["key"]',promise:'p'}));
  commitAll(controllers,record('await',{promise:'p',continuation:'k',invocation:'i1',returnPromise:'root'}));
  controllers=controllers.map(controller=>controller.constructor.fromPacket(controller.segmentPacket()));
  for(const controller of controllers){
    const before=controller.segmentPacket();
    assert.throws(()=>controller.commitRecord(record('promise',{action:'resolve',promise:'p',value:num(99)})),/broker/);
    assert.deepEqual(controller.segmentPacket(),before);
  }
  commitAll(controllers,record('observe',{effect:'e',status:'fulfilled',result:num(7)}),{mode:'observed'});
  commitAll(controllers,record('resume',{continuation:'k',invocation:'i1',status:'fulfilled',result:num(7)}));
  commitAll(controllers,record('return',{value:num(7)}));
  commitAll(controllers,record('end',{kind:'return'}));
  assert.deepEqual(controllers[0].completion.value,num(7));
});

test('neutral failures preserve shared realm identity and cannot execute supplied object hooks',()=>{
  const shared={heap:new Map(),locals:new Map(),scheduler:{registration:0,ready:0}};
  const c=new SemanticExecutionController(context(),{retainedState:shared});
  c.commitRecord(record('allocate',{name:'o',kind:'object',properties:[{key:'x',value:num(1)}]}));
  const before=c.segmentPacket();
  let hooks=0;
  const bad=[
    {kind:'bind',get fields(){hooks++;return {name:'x',value:num(2)};}},
    new Proxy(record('bind',{name:'x',value:num(2)}),{ownKeys(){hooks++;return [];}}),
    record('write',{object:'missing',key:'x',value:num(2),present:true})
  ];
  for(const selected of bad){
    assert.throws(()=>c.commitRecord(selected));assert.deepEqual(c.segmentPacket(),before);
    assert.equal(c.heap,shared.heap);assert.equal(c.locals,shared.locals);assert.equal(c.scheduler,shared.scheduler);
  }
  assert.equal(hooks,0);
});

test('typed input and committed history are snapshots and wrong packet formats fail closed',()=>{
  const input=context(),c=new SemanticExecutionController(input);
  input[0].fields.source='changed';assert.notEqual(c.source.source,'changed');
  const selected=record('bind',{name:'x',value:num(1)});c.commitRecord(selected);
  selected.fields.value[1]=20;
  assert.deepEqual(c.locals.get('x'),num(1));assert.deepEqual(c.history[0].record.fields.value,num(1));
  assert.throws(()=>SemanticControllerV8.fromPacket(c.segmentPacket()),/packet version/);
  assert.throws(()=>c.commitRecord('return 1'),/own data|wrapper/);
});

test('typed controller and direct V8 client run with all legacy codecs blocked',()=>{
  const loader='export async function resolve(specifier,context,next){'+
    'if(/(?:training\\/(?:format|trace-text|harness-v4|controller)|detailed-v7)\\.js/.test(specifier))'+
    'throw new Error("legacy dependency: "+specifier);return next(specifier,context);}';
  const module=new URL('../src/semantic/controller-v8.js',import.meta.url).href;
  const codec=new URL('../src/semantic/detail-v8.js',import.meta.url).href;
  const input=context();
  const source='import {SemanticControllerV8 as C} from '+JSON.stringify(module)+';'+
    'import {encodeDetailedRecord as e} from '+JSON.stringify(codec)+';'+
    'let c=new C('+JSON.stringify(input)+'.map(r=>e(r)));'+
    'c.commit(e({kind:"return",fields:{value:["num",7]}}));'+
    'c=C.fromPacket(c.segmentPacket());c.commit(e({kind:"end",fields:{kind:"return"}}));'+
    'if(c.completion.value[1]!==7)throw new Error("completion");';
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-loader',
    'data:text/javascript,'+encodeURIComponent(loader),'--input-type=module','--eval',source],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
