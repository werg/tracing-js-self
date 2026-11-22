import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {normalizeJournal} from '../src/semantic/normalize.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {PROTOCOL_SOURCE_ADAPTERS_V8} from '../src/semantic/protocol-source-extensions-v8.js';
import {protocolSourceClaimsV8} from '../src/semantic/protocol-source-claims-v8.js';
import {immutableSourceDataV8} from '../src/semantic/source-claim-coordinator-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';

function archive(source){const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();return runtime.exportRun();}
const adaptersFor=(source,bundle)=>PROTOCOL_SOURCE_ADAPTERS_V8.map(adapter=>typeof adapter==='function'?adapter({source,bundle}):adapter).filter(Boolean);
const isNumber=event=>event.operation==='call.enter'&&event.operands[0]?.[0]==='intrinsic'&&event.operands[0][1]==='Number';
const current=ctx=>structuredClone({claims:ctx.claims,public:sharedRegionState(ctx.controller),
  state:ctx.state,published:[...ctx.published],accessors:[...ctx.pendingAccessors]});
function afterEvent(ctx,event){
  const result=current(ctx);
  for(const change of event.stateChanges)if(result.state[change.table]){
    if(change.after===null)delete result.state[change.table][change.id];
    else if(change.after!==undefined)result.state[change.table][change.id]=structuredClone(change.after);
  }
  return result;
}

test('all protocol event and completion owners produce identical claims in either registry order',()=>{
  for(const source of [
    '"use strict";function run(){class Unused{};if(false){return new Uint8Array(2);}return 1;}',
    '"use strict";function run(){class Box{#x;constructor(x){this.#x=x;}get(){return this.#x;}}'+
      'const bytes=new Uint8Array(2);const proxy=new Proxy({x:3},{get:function(o,k){bytes[0]=o[k];return bytes[0]+1;}});'+
      'const n=Number({valueOf:function(){return new Box(proxy.x).get();}});'+
      'const mapped=[n,2].map(function(x){const iterator=[x].values();return iterator.next().value+1;});return mapped[0]+mapped[1]+bytes[0];}',
    '"use strict";function run(){function* g(){try{yield* [1,2];}finally{yield 3;}}'+
      'const iterator=g();const a=iterator.next();const b=iterator.return(7);return a.value+b.value+iterator.next().value;}',
    '"use strict";function run(){const value={valueOf:function(){throw 7;}};let n=0;try{Number(value);}catch(e){n=e;}finally{n++;}return n;}'
  ]){
    const bundle=archive(source),first=compileProtocolSourceV8(bundle),
      reversed=compileProtocolSourceV8(bundle,{adapters:[...PROTOCOL_SOURCE_ADAPTERS_V8].reverse()});
    assert.deepEqual(reversed,first);
  }
});

test('missing and ambiguous direct protocol owners refuse before any preparation or public mutation',()=>{
  const source='"use strict";function run(){const value={valueOf:function(){return 4;}};return Number(value);}',bundle=archive(source);
  for(const ambiguous of [false,true]){
    let context,before,preparations=0;
    const adapters=adaptersFor(source,bundle),number=adapters.find(adapter=>adapter.id==='primitive-conversion-source/1'),
      claims=protocolSourceClaimsV8(number.id);
    number.prepare={event:(_view,{event})=>{if(isNumber(event))preparations++;return {kind:'number-event'};}};
    if(ambiguous)adapters.push({id:'duplicate-number/1',stateless:true,claims:{event:claims.event},
      prepare:{event:()=>{preparations++;return {kind:'duplicate'};}},event(){throw Error('must not execute');}});
    else adapters.splice(adapters.indexOf(number),1);
    adapters.push({id:'ownership-audit/1',stateless:true,setup(ctx){context=ctx;},
      afterEvent(ctx,event){before=afterEvent(ctx,event);}});
    assert.throws(()=>compileProtocolSourceV8(bundle,{adapters}),ambiguous?/ambiguous owner/:/missing owner/);
    assert.equal(preparations,0);assert(before);assert.deepEqual(current(context),before);
  }
});

test('a selected direct protocol handler cannot decline after writing a staged transition',()=>{
  const source='"use strict";function run(){const value={valueOf:function(){return 4;}};return Number(value);}',bundle=archive(source),
    adapters=adaptersFor(source,bundle),number=adapters.find(adapter=>adapter.id==='primitive-conversion-source/1'),event=number.event;
  let context,before,privateBefore,attempted=false;
  number.event=(ctx,owned,row)=>{const result=event(ctx,owned,row);if(isNumber(owned)){attempted=true;return false;}return result;};
  adapters.push({id:'decline-audit/1',stateless:true,setup(ctx){context=ctx;},beforeEvent(ctx,owned){
    if(isNumber(owned)){before=current(ctx);privateBefore=structuredClone(number.captureState());}
  }});
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters}),/claimed source event handler declined/);
  assert(attempted);assert.deepEqual(current(context),before);assert.deepEqual(number.captureState(),privateBefore);
});

test('semantic normalization never inherits prototype names as property data or version counters',()=>{
  const bundle=archive('"use strict";function run(){const object={};object.valueOf=1;object.toString=2;object.constructor=3;return object.valueOf;}'),
    semantic=normalizeJournal(bundle),writes=semantic.events.flatMap(row=>row.writes).filter(write=>write.kind==='property');
  for(const key of ['valueOf','toString','constructor']){
    const write=writes.find(row=>row.key===key);assert(write,key);
    assert.equal(write.oldVersion,0,key);assert.equal(typeof write.version,'number',key);assert.equal(write.present,true);
  }
  assert.doesNotThrow(()=>immutableSourceDataV8(semantic));
});
