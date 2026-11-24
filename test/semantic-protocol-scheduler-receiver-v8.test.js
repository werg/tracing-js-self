import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticController} from '../src/training/controller.js';
import {encodeWitness as record} from '../src/training/format.js';
import {applyProtocolRecordV8,restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';

const source='"use strict";function run(){}function reaction(value){}';
function setup(functionKind='arrow',code='reaction'){
  const c=new SemanticController([
    record('code',{source,entry:'run',sites:[]}),
    record('input',{graph:{roots:[],objects:['parent','captured'].map(id=>({id,kind:'object',properties:[]}))}})
  ],{receiver:['ref','parent']});
  applyProtocolRecordV8(c,{kind:'allocate',name:'callback',objectKind:'closure',length:null,properties:[],code,captures:[],
    functionKind,lexicalReceiver:functionKind==='arrow'?['ref','captured']:null});
  for(const promise of ['source','later'])c.commit(record('promise',{action:'create',promise}));
  c.commit(record('promise',{action:'react',promise:'source',job:'reaction',reaction:'then',closure:'callback',target:'result'}));
  c.commit(record('promise',{action:'resolve',promise:'source',value:['num',3]}));
  c.commit(record('return',{value:['num',0]}));
  return c;
}
const dispatch=c=>c.commit(record('job',{action:'dispatch',job:'reaction',owner:'i1'}));
const finish=c=>{
  c.commit(record('return',{invocation:'job:reaction',value:['num',4]}));
  c.commit(record('job',{action:'complete',job:'reaction',owner:'i1'}));
};

test('protocol Promise callbacks install lexical or ordinary receivers and restore their parent',()=>{
  for(const kind of ['arrow','ordinary']){
    const c=setup(kind);dispatch(c);
    assert.deepEqual(c.receiver,kind==='arrow'?['ref','captured']:['undefined']);
    assert.deepEqual(c.jobs.get('reaction').priorReceiver,['ref','parent']);
    finish(c);assert.deepEqual(c.receiver,['ref','parent']);
  }
});

test('suspended protocol reactions preserve their receiver across a serialized continuation',()=>{
  const c=setup();dispatch(c);
  const parameterCell=c.captureAliases.get('value');
  c.setLocal('value',['num',8]);
  c.commit(record('await',{invocation:'job:reaction',promise:'later',continuation:'c1'}));
  assert.deepEqual(c.receiver,['ref','parent']);
  assert.deepEqual(c.continuations.get('c1').receiver,['ref','captured']);
  const suspended=c.segmentPacket();
  assert.throws(()=>c.commit(record('job',{action:'complete',job:'reaction',owner:'i1'})),/suspended callback/);
  assert.deepEqual(c.segmentPacket(),suspended);
  const restored=SemanticController.fromPacket(JSON.parse(JSON.stringify(c.segmentPacket())));
  restoreProtocolStateV8(restored,structuredClone(c.protocol));
  assert.deepEqual(restored.locals.get(parameterCell),['num',8]);
  const forgedAliases=SemanticController.fromPacket(JSON.parse(JSON.stringify(c.segmentPacket())));
  forgedAliases.continuations.get('c1').captureAliases[0][1]='forged-cell';
  assert.throws(()=>restoreProtocolStateV8(forgedAliases,structuredClone(c.protocol)),/parameter aliases/);
  const forgedBinding=SemanticController.fromPacket(JSON.parse(JSON.stringify(c.segmentPacket())));
  forgedBinding.jobs.get('reaction').parameterBindings[0].index=4;
  assert.throws(()=>restoreProtocolStateV8(forgedBinding,structuredClone(c.protocol)),/parameter binding receipt/);
  for(const current of [c,restored]){
    current.commit(record('promise',{action:'resolve',promise:'later',value:['num',5]}));
    const ready=current.segmentPacket();
    assert.throws(()=>current.commit(record('job',{action:'complete',job:'reaction',owner:'i1'})),/suspended callback/);
    assert.deepEqual(current.segmentPacket(),ready);
    current.commit(record('resume',{invocation:'job:reaction',continuation:'c1',status:'fulfilled',result:['num',5]}));
    assert.deepEqual(current.receiver,['ref','captured']);
    assert.deepEqual(current.locals.get(parameterCell),['num',8]);
    finish(current);assert.deepEqual(current.receiver,['ref','parent']);
  }
  assert.deepEqual(restored.segmentPacket(),c.segmentPacket());
});

test('failed protocol callback dispatch restores the receiver and queued state atomically',()=>{
  const c=setup('arrow','missing');
  const before=c.segmentPacket();
  assert.throws(()=>dispatch(c),/no source site/);
  assert.deepEqual(c.segmentPacket(),before);
});
