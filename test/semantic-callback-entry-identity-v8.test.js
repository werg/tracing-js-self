import test from 'node:test';
import assert from 'node:assert/strict';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

const source='"use strict";function run(){return 1;}function handler(value){return value;}';
const copy=structuredClone;
function ready({programSource=source,closureCode='handler'}={}){
  const h=new RegionExecutionHarness({sessionId:'closure-binding'});
  h.publishProgram({programId:'program',source:programSource,entry:'run'});
  h.admitInvocation({programId:'program',invocationId:'root',trackId:'worker',realmId:'realm',
    triggerId:'root',realmPolicy:'retained'});
  h.select('root',{kind:'allocate',fields:{name:'fn',kind:'closure',code:closureCode,captures:[],properties:[]}});
  h.select('root',{kind:'return',fields:{value:['num',1]}});
  h.select('root',{kind:'end',fields:{kind:'return'}});
  return h;
}
const child={programId:'program',invocationId:'child',trackId:'worker',realmId:'realm',
  triggerId:'callback',realmPolicy:'retained',activation:'callback',closureId:'fn',
  parentInvocationId:'root',args:[7]};
const handler={subscriptionId:'events',programId:'program',realmId:'realm',trackId:'worker',closureId:'fn'};

test('callback entry cannot substitute another function before any retained-state mutation',()=>{
  const h=ready(),before=copy(h.checkpoint()),ingress=copy([...h.inner.ingress]);
  const other='function:'+analyzeSemanticProgram(source).functions.find(fn=>fn.name==='run').start;
  for(const entry of ['run',other,'missing']){
    assert.throws(()=>h.admitInvocation({...child,entry,args:[{newInput:9}]}),/same unique static function site/);
    assert.deepEqual(h.checkpoint(),before);
    assert.deepEqual([...h.inner.ingress],ingress);
  }
  h.admitInvocation(child);
  assert.equal(h.invocations.get('child').entry,'handler');
});

test('callback name and function-site aliases preserve the same function across public replay and JSON restore',()=>{
  const code='function:'+analyzeSemanticProgram(source).functions.find(fn=>fn.name==='handler').start;
  for(const [closureCode,entry]of [[code,'handler'],['handler',code]]){
    const h=ready({closureCode});h.admitInvocation({...child,entry});
    const controller=h.invocations.get('child').controller;
    assert.deepEqual(controller.locals.get(controller.captureAliases.get('value')),['num',7]);
    assert.deepEqual(RegionExecutionHarness.replay(h.exportEpisode(),{requireTerminal:false}).timeline,h.timeline);
    assert.deepEqual(RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint()))).timeline,h.timeline);
    const changed=copy(h.exportEpisode());changed.timeline.find(row=>row.kind==='invocation'&&row.fields.invocationId==='child').fields.entry='run';
    assert.throws(()=>RegionExecutionHarness.replay(changed,{requireTerminal:false}),/same unique static function site/);
  }
});

test('ambiguous function names cannot identify a retained closure even when one spelling is precise',()=>{
  const programSource='"use strict";function run(){function handler(value){return value;}return 1;}function handler(value){return value+1;}',
    sites=analyzeSemanticProgram(programSource).functions.filter(fn=>fn.name==='handler');
  assert.equal(sites.length,2);
  for(const [closureCode,entry]of [['handler','function:'+sites[0].start],['function:'+sites[0].start,'handler']]){
    const h=ready({programSource,closureCode}),before=copy(h.checkpoint());
    assert.throws(()=>h.admitInvocation({...child,entry}),/same unique static function site/);
    assert.deepEqual(h.checkpoint(),before);
  }
});

test('closure-backed event handlers bind the same function before registration and default to retained code',()=>{
  const h=ready(),before=copy(h.checkpoint());
  assert.throws(()=>h.registerEventHandler({...handler,entry:'run'}),/same unique static function site/);
  assert.deepEqual(h.checkpoint(),before);assert.equal(h.handlers.size,0);
  h.registerEventHandler(handler);
  assert.equal(h.handlers.get('events').entry,'handler');
  const exported=h.exportEpisode();
  assert.deepEqual(RegionExecutionHarness.replay(exported).timeline,h.timeline);
  const changed=copy(exported);changed.timeline.find(row=>row.kind==='handler').fields.entry='run';
  assert.throws(()=>RegionExecutionHarness.replay(changed),/same unique static function site/);
});
