import test from 'node:test';
import assert from 'node:assert/strict';
import {createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';

const bind=(h,value)=>h.selected('root',encodeDetailedRecord({kind:'bind',fields:{name:'n',value:['num',value]}}));
function fixture(){
  const h=createEffectfulRegionAdapterV8().createHarness({sessionId:'source-context-staging',automaticDelivery:false});
  h.publishProgram({programId:'p',source:'"use strict";function run(){let n=1;return n;}',entry:'run',capabilities:[]});
  h.admitInvocation({programId:'p',invocationId:'root',trackId:'t',realmId:'r',triggerId:'root'});
  h.prepareModelContext('root');bind(h,1);return h;
}

test('stored source contexts remain isolated from returned contexts and both exported branches',()=>{
  const live=fixture(),before=live.exportEpisode(),staged=live.fork();
  const returned=staged.prepareModelContext('root');returned.state.locals.push(['forged',['num',9]]);
  bind(staged,2);
  const published=staged.exportEpisode();published.contexts[0].state.locals.push(['changed',['num',8]]);
  published.public.timeline[0].fields.source='changed';
  const liveExport=live.exportEpisode();liveExport.contexts.length=0;
  assert.deepEqual(live.exportEpisode(),before);
  const candidate=staged.exportEpisode();
  assert.deepEqual(candidate.contexts[0],before.contexts[0]);
  assert(!candidate.contexts[1].state.locals.some(([name])=>name==='forged'));
  live.commitPrepared(staged);
  assert.deepEqual(live.exportEpisode(),candidate);
  const after=live.exportEpisode();after.contexts[0].state.locals.push(['late',['num',7]]);
  assert.deepEqual(live.exportEpisode(),candidate);
});

test('discarded source context branches cannot publish future contexts or state',()=>{
  const live=fixture(),before=live.exportEpisode(),discarded=live.fork(),accepted=live.fork();
  discarded.prepareModelContext('root');bind(discarded,99);
  accepted.prepareModelContext('root');bind(accepted,3);
  assert.deepEqual(live.exportEpisode(),before);
  live.commitPrepared(accepted);
  const committed=live.exportEpisode();
  assert.equal(committed.contexts.length,before.contexts.length+1);
  assert.equal(live.invocations.get('root').controller.locals.get('n')[1],3);
  discarded.prepareModelContext('root');bind(discarded,100);
  assert.deepEqual(live.exportEpisode(),committed);
});
