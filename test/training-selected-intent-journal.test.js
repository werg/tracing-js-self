import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SelectedIntentJournal} from '../src/training/intent-journal.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness as w} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';

test('real fsynced intent and JSON checkpoint survive new journal and harness instances',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.selected-journal-'));
  try{
    const journal=new SelectedIntentJournal({directory});
    let calls=0,resolve,started;
    const nativeStarted=new Promise(done=>{started=done;});
    const source='async function run(){return await host.readAsync("x");}';
    const h=new SelectedExecutionHarness({journal,services:{'demo.readAsync':async()=>{
      const durable=await journal.readIntent('session1','call/effect');
      assert.equal(durable.payload,'["x"]');calls++;
      return new Promise(done=>{resolve=done;started();});
    }}});
    h.publishProgram({programId:'p',source,entry:'run',capabilities:['demo.readAsync']});
    h.admitInvocation({programId:'p',invocationId:'call',realmId:'r',trackId:'worker',triggerId:'outside'});
    const site=analyzeSemanticProgram(source).sites.find(site=>site.operation==='demo.readAsync');
    h.selected('call',w('request',{effect:'effect',operation:'demo.readAsync',arguments:[['str','x']],
      invocation:'call',site:{start:site.start,end:site.end},payload:'["x"]',promise:'p'}));
    const pending=h.dispatch('call','effect');
    // Wait for the adapter to acknowledge observing the persisted intent.
    await nativeStarted;
    h.selected('call',w('await',{promise:'p',continuation:'c',invocation:'call'}));
    const receipt=await journal.putCheckpoint(h.checkpoint());
    const reopened=new SelectedIntentJournal({directory});
    const restored=SelectedExecutionHarness.restore(await reopened.readCheckpoint(receipt.key),{
      journal:reopened,services:{'demo.readAsync':()=>{throw new Error('must not repeat');}}});
    assert.throws(()=>restored.dispatch('call','effect'),/uncertain/);assert.equal(calls,1);
    restored.reconcile('call','effect',{disposition:'fulfilled',evidenceId:'service-receipt',value:5});
    restored.selected('call',w('resume',{continuation:'c',invocation:'call',status:'fulfilled',result:['num',5]}));
    restored.selected('call',w('return',{value:['num',5]}));restored.selected('call',w('end',{kind:'return'}));
    assert.equal(restored.invocations.get('call').controller.completion.value[1],5);
    const record=await reopened.readIntent('session1','call/effect');
    assert.deepEqual(await reopened.append(record),await reopened.append(record));
    await assert.rejects(reopened.append({...record,witness:'forged bytes'}),/Conflicting/);
    assert.equal(JSON.parse(await readFile(join(directory,receipt.key+'.json'))).schema,'semantic-checkpoint/5');
    resolve(5);await pending;
  }finally{await rm(directory,{recursive:true,force:true});}
});
