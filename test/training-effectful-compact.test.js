import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from '../src/training/effectful-compiler.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {decodeWitness,validateExpression} from '../src/training/format.js';

const lines=episode=>episode.public.timeline.filter(item=>item.kind==='semantic').map(item=>decodeWitness(item.line));
const computations=episode=>lines(episode).filter(item=>item.kind==='compute');
async function sourceBundle(text,args=[]){
  return (await executeWithNativeServices({entry:{text:'"use strict";'+text,functionName:'run',args}})).bundle;
}

test('pure and effectful compact teachers are source-certified, shorter and executable through actual serving',async()=>{
  for(const family of ['compound-pure','compound-effectful']){
    const episodes=[];
    for(const representation of ['explicit','compact']){
      const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id===family+'-'+representation);
      const result=await verifyEffectfulTrainingCase(fixture);
      assert.equal(result.status,'locally_verified',result.reason);
      assert.equal(result.exported.sidecar.representation,representation);
      assert.equal((await recheckEffectfulAdmission(result.exported,{requireAdmitted:false})).sourceValidated,true);
      const cohort=controlledEvaluationCase(result.exported,{id:fixture.id});
      const selected=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
        caseId:fixture.id,seed:17,representation,request:cohort.request});
      assert.equal(selected.failure,null);assert.deepEqual(selected.outcome,cohort.expected);
      episodes.push(result.exported);
    }
    const [explicit,compact]=episodes;
    assert.deepEqual(compact.sidecar.reference,explicit.sidecar.reference);
    assert.deepEqual(compact.sidecar.effects,explicit.sidecar.effects);
    assert.equal(compact.sidecar.split,explicit.sidecar.split);
    assert(compact.sidecar.compiler.generatedRecords<explicit.sidecar.compiler.generatedRecords);
    assert.equal(computations(explicit).length,4);assert.equal(computations(compact).length,1);
    assert.equal(validateExpression(computations(compact)[0].fields.expr).operatorCount,4);
    const certificate=compact.sidecar.compiler.certificates.find(item=>item.rule==='owned-compact-compute/4');
    assert.equal(certificate.journalEvents.length,4);assert.equal(certificate.dependencies.length,3);
    const damaged=structuredClone(compact);damaged.sidecar.representation='explicit';
    await assert.rejects(recheckEffectfulAdmission(damaged,{requireAdmitted:false}),/bytes changed/);
    const forged=structuredClone(compact);
    forged.sidecar.compiler.certificates.find(item=>item.dependencies).dependencies[0].producer='a0:e999999';
    assert.throws(()=>verifyEffectfulProjection(compact.sidecar.archive,forged,compact.sidecar.projectionOptions),/certificates/);
  }
});

test('fusion requires exact source child and operand dependency instead of coincidentally equal results',async()=>{
  const bundle=await sourceBundle('function run(a,b){return ((a+b),(a+b))*2;}',[2,3]);
  const explicit=compileEffectfulWitness(bundle).exported;
  const compact=compileEffectfulWitness(bundle,{representation:'compact'}).exported;
  assert.deepEqual(compact.public,explicit.public,'sequence-discarded sibling computations cannot become an AST child');
  assert.equal(compact.sidecar.compiler.compaction.removedComputations,0);
  const source='function run(a,b){const previous=a+b;return previous*2;}';
  const bound=await sourceBundle(source,[2,3]);
  const out=compileEffectfulWitness(bound,{representation:'compact'}).exported;
  assert.equal(computations(out).length,2,'a binding is a mandatory compaction boundary');
  assert.equal(out.sidecar.compiler.compaction.removedComputations,0);
});

test('bounded compaction retains computations beyond eight operators and the thirty-two node ceiling',async()=>{
  const bundle=await sourceBundle('function run(value){return ((((((((((value+1)+2)+3)+4)+5)+6)+7)+8)+9)+10);}',[1]);
  const explicit=compileEffectfulWitness(bundle).exported;
  const compact=compileEffectfulWitness(bundle,{representation:'compact'}).exported;
  assert.equal(computations(explicit).length,10);assert.equal(computations(compact).length,2);
  const sizes=computations(compact).map(item=>validateExpression(item.fields.expr));
  assert.deepEqual(sizes.map(item=>item.operatorCount),[8,2]);
  assert(sizes.every(item=>item.nodeCount<=32));
  const one=compileEffectfulWitness(bundle,{representation:'compact',maxOperators:1}).exported;
  assert.deepEqual(one.public,explicit.public);
  assert.throws(()=>compileEffectfulWitness(bundle,{representation:'compact',maxOperators:9}),/bound/);
});

test('mutations, branches, calls, async observations and cleanup remain separate compact boundaries',async()=>{
  const fixture={family:'compact-barriers',entry:'run',args:['x',{n:1}],
    source:'"use strict";async function run(key,state){const value=(2+3)*4;state.n=value;try{const x=await host.readAsync(key);if(x>0){host.store(key,(x+2)*3);return (x+4)*5;}return 0;}finally{host.store("cleanup",(1+2)*3);}}',
    fixture:{calls:[{operation:'demo.readAsync',arguments:['x'],result:2},
      {operation:'demo.store',arguments:['x',12]},{operation:'demo.store',arguments:['cleanup',9]}]}};
  const explicit=await verifyEffectfulTrainingCase(fixture);
  const compact=await verifyEffectfulTrainingCase({...fixture,projectionOptions:{representation:'compact'}});
  assert.equal(explicit.status,'locally_verified',explicit.reason);assert.equal(compact.status,'locally_verified',compact.reason);
  const boundaries=episode=>episode.public.timeline.filter(item=>item.kind!=='semantic'||
    decodeWitness(item.line).kind!=='compute').map(({sequence,ownerSequence,...item})=>item);
  assert.deepEqual(boundaries(compact.exported),boundaries(explicit.exported));
  assert.deepEqual(compact.exported.sidecar.reference,explicit.exported.sidecar.reference);
  assert.deepEqual(compact.exported.sidecar.effects,explicit.exported.sidecar.effects);
  for(const certificate of compact.exported.sidecar.compiler.certificates.filter(item=>item.dependencies)){
    const events=certificate.journalEvents.map(id=>compact.exported.sidecar.archive.events.find(item=>item.eventId===id));
    assert(events.every(item=>item.operation==='spec.operation.complete'));
    const first=events[0].sequence,last=events.at(-1).sequence;
    assert(!compact.exported.sidecar.archive.events.some(item=>item.sequence>first&&item.sequence<last&&
      /^(external\.|effect\.|async\.|job\.|property\.write|binding\.write|binding\.initialize|control\.|completion\.)/.test(item.operation)));
  }
});
