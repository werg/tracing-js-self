import assert from 'node:assert/strict';
import test from 'node:test';
import {createNatlangSelectedEnvironment} from '../src/natlang-selected.js';
import {encodeWitness} from '../src/training/format.js';

const returnValue=value=>encodeWitness('return',{value});
const terminal=encodeWitness('end',{kind:'return'});

test('Natlang uses selected execution for real compiled JS and TypeScript expressions',async()=>{
  const selected=[];
  const adapter=prefix=>{
    selected.push({entry:prefix.entry,source:prefix.source});
    assert.equal(prefix.entry,'run');
    const semantic=prefix.committed.filter(x=>x.kind==='semantic');
    if(semantic.length===0)return encodeWitness('compute',{
      expr:{op:'binary',operator:'+',
        left:{op:'literal',value:['num',2]},
        right:{op:'literal',value:['num',3]}},
      result:['num',5]});
    if(semantic.length===1)return returnValue(['num',5]);
    if(semantic.length===2)return terminal;
    throw new Error('Unexpected selected context');
  };
  const env=createNatlangSelectedEnvironment({select:adapter});
  assert.throws(()=>env.execute({code:'2+3',body:false,path:'t.ts',scope:{}}),
    /asynchronous/);
  const result=await env.executeAsync({code:'2 as number + 3',body:false,
    path:'t.ts',scope:{n:1}});
  assert.equal(result.result,5);
  assert(selected.some(x=>x.source.includes('2 + 3')));
  assert(result.events.some(x=>x.operation==='selected.observation'));
  env.close();
  await assert.rejects(env.executeAsync({code:'3',body:false,path:'t.ts',scope:{}}),
    /closed/);
});

test('selected module initializer exports an owned function trampoline with retained calls',async()=>{
  const selections=[];
  const selector=prefix=>{
    const semantic=prefix.committed.filter(x=>x.kind==='semantic');
    selections.push([prefix.entry,semantic.length]);
    if(prefix.entry==='initialize'){
      if(semantic.length===0)return encodeWitness('allocate',{
        name:'o2',kind:'closure',code:'answer',properties:[],captures:[]});
      if(semantic.length===1)return encodeWitness('write',{object:'o0',
        key:'answer',value:['ref','o2'],present:true});
      if(semantic.length===2)return returnValue(['ref','o0']);
      if(semantic.length===3)return terminal;
    }
    if(prefix.entry==='answer'){
      if(semantic.length===0)return returnValue(['num',42]);
      if(semantic.length===1)return terminal;
    }
    throw new Error('Unexpected execution selection '+prefix.entry+' '+semantic.length);
  };
  const env=createNatlangSelectedEnvironment({mode:'retained',select:selector});
  const exports={};const bindings={exports,module:{exports}};
  const compiled='function answer(){return 42;} exports.answer=answer;';
  const result=await env.evaluateModuleAsync(compiled,bindings);
  assert.equal(result,exports);
  assert.equal(typeof exports.answer,'function');
  assert.equal(await exports.answer(),42);
  assert.equal(await exports.answer(),42);
  assert.equal(selections.filter(x=>x[0]==='initialize').length,4);
  assert.equal(selections.filter(x=>x[0]==='answer').length,4);
  const h=env.selectedHarness();
  const invocations=h.timeline.filter(x=>x.kind==='invocation');
  assert.equal(invocations.length,3);
  assert.equal(new Set(invocations.map(x=>x.realmId)).size,1);
  assert.deepEqual(invocations.map(x=>x.entry),['initialize','answer','answer']);
  assert.throws(()=>env.evaluateModule(compiled,bindings),/requires/);
  await assert.rejects(env.evaluateModuleAsync(compiled,bindings),/already initialized/);
  env.close();
});
