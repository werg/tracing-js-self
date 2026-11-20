import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {validateNumberConversionState} from '../src/number-conversion-validation.js';

const source='"use strict";function run(){let log="";const o={get [Symbol.toPrimitive](){log+="g";return function(h){log+=h;return "7";};}};return [Number(o),log];}';
const json=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw new Error(message);};

test('Number retains getter-selected methods with the original receiver and number hint',()=>{
  runtimeDifferential('',{source});
  runtimeDifferential('let log="";const proto={get valueOf(){log+=this.x;return function(){return this.x;};}};const o=Object.create(proto);o.x=6;return [Number(o),log];');
  runtimeDifferential('let log="";const o={get [Symbol.toPrimitive](){log+="g";Object.defineProperty(this,Symbol.toPrimitive,{value(){log+="wrong";return 8;}});return function(h){log+=h;return 7;};}};return [Number(o),log];');
  runtimeDifferential('const o={get [Symbol.toPrimitive](){return function(...args){return args.length===1&&args[0]==="number"?5:6;};}};return Number(o);');
});

test('Number getter fallback selects each live property once and preserves thrown identities',()=>{
  for(const body of [
    'let log="";const o={get [Symbol.toPrimitive](){log+="s";return null;},get valueOf(){log+="v";return ()=>({});},get toString(){log+="t";return ()=>"9";}};return [Number(o),log];',
    'let log="";const o={get valueOf(){log+="v";return 1;},get toString(){log+="t";return ()=>"9";}};return [Number(o),log];',
    'const o={set [Symbol.toPrimitive](v){},get valueOf(){return ()=>4;}};return Number(o);',
    'const error={x:1};let log="";const o={get valueOf(){log+="g";throw error;}};try{try{Number(o);}finally{log+="f";}}catch(e){return [e===error,log];}',
    'const inner={get valueOf(){return ()=>3;}};const outer={get valueOf(){const n=Number(inner);return ()=>n+1;}};return Number(outer);',
    'const o={get [Symbol.toPrimitive](){return 1;}};try{Number(o);}catch(e){return e.name;}',
    'const o={get [Symbol.toPrimitive](){return Promise.resolve(1);}};try{Number(o);}catch(e){return e.name;}',
    'const o={get valueOf(){return ()=>({});},get toString(){return ()=>({});}};try{Number(o);}catch(e){return e.name;}'
  ])runtimeDifferential(body);
});

test('every Number getter and method boundary restores from plain JSON without duplicated lookup',()=>{
  for(const phase of ['getter-waiting','getter-returned','waiting','returned']){
    const original=createRuntime().startEntry({text:source,functionName:'run',args:[]});
    while(!Object.values(original.state.frames).some(frame=>frame.pendingNumberConversion?.phase===phase)){
      assert(original.step(),'Missing retained '+phase+' boundary');
    }
    const snapshot=json(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))),
      restored=Object.assign(createRuntime(),snapshot);
    original.drive();restored.drive();
    assert.deepEqual(json(restored.exportRun()),json(original.exportRun()));
    assert.equal(validateBundle(restored.exportRun()).valid,true);
    assert.equal(replayExact(restored.exportRun()).valid,true);
    for(const mutate of [
      pending=>pending.waitingFrameId='missing',
      pending=>pending.method=['ref',pending.input[1]],
      pending=>pending.phase=phase.includes('getter')?phase.replace('getter-',''):'getter-'+phase,
      pending=>pending.result=['num',99]
    ]){
      const changed=structuredClone(snapshot.state),frame=Object.values(changed.frames).find(frame=>frame.pendingNumberConversion);
      mutate(frame.pendingNumberConversion);
      // Swapping getter/method phases has the same physical callback shape,
      // but the event validator below rejects its semantic selection.
      if(frame.pendingNumberConversion.phase!==phase)continue;
      assert.throws(()=>validateNumberConversionState(changed,snapshot.programs,new Set(snapshot.sites.map(site=>site.siteId)),fail));
    }
  }
});

test('independent Number archive checks reject wrong lookup, fallback, hint and return decisions',()=>{
  const {bundle}=runtimeDifferential('',{source});
  const mutateEvent=(predicate,mutate)=>{
    const changed=structuredClone(bundle),event=changed.events.find(predicate);
    assert(event);mutate(event);assert.throws(()=>validateBundle(changed),/Number|conversion|Mutation precondition/);
  };
  mutateEvent(event=>event.stateChanges.some(change=>change.after?.pendingNumberConversion?.phase==='getter-waiting'),event=>{
    event.stateChanges.find(change=>change.after?.pendingNumberConversion).after.pendingNumberConversion.phase='waiting';
  });
  mutateEvent(event=>event.operation==='intrinsic.number.resume'&&event.causes.length,event=>{
    const pending=event.stateChanges.find(change=>change.after?.pendingNumberConversion)?.after.pendingNumberConversion;
    pending.index=0;
  });
  mutateEvent(event=>event.operation==='intrinsic.number.resume'&&event.causes.length,event=>{
    const frameId=event.causes.find(cause=>cause.kind==='invocation').frameId,
      child=event.stateChanges.find(change=>change.table==='frames'&&change.id===frameId).after,
      environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId).after;
    environment.bindings.h.token.value=['str','string'];
  });
  mutateEvent(event=>event.operation==='intrinsic.number.resume'&&event.result?.[0]==='num',event=>event.result=['num',8]);
});
