import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {SelectedIntentJournal} from '../src/training/intent-journal.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {encodeWitness as w} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

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
    const argument=Object.create(null);argument.later=2;argument.earlier=1;argument.self=argument;
    const sparse=new Array(3);sparse[2]=argument;
    h.admitInvocation({programId:'p',invocationId:'call',realmId:'r',trackId:'worker',triggerId:'outside',
      args:[argument,argument,sparse]});
    const site=analyzeSemanticProgram(source).sites.find(site=>site.operation==='demo.readAsync');
    h.selected('call',w('request',{effect:'effect',operation:'demo.readAsync',arguments:[['str','x']],
      invocation:'call',site:{start:site.start,end:site.end},payload:'["x"]',promise:'p'}));
    const pending=h.dispatch('call','effect');
    // Wait for the adapter to acknowledge observing the persisted intent.
    await nativeStarted;
    h.selected('call',w('await',{promise:'p',continuation:'c',invocation:'call'}));
    const packet=h.checkpoint(),receipt=await journal.putCheckpoint(packet);
    // Both the live object's original key order and canonical durable JSON
    // carry the same lifecycle integrity. Object keys have no authority.
    const canonical=JSON.parse(stableAlgorithmJSON(packet)),canonicalReceipt=await journal.putCheckpoint(canonical);
    const reopened=new SelectedIntentJournal({directory});
    assert.deepEqual(await reopened.readCheckpoint(receipt.key),packet);
    assert.deepEqual(await reopened.readCheckpoint(canonicalReceipt.key),packet);
    const changed=structuredClone(canonical);changed.maxOutstanding++;
    assert.throws(()=>journal.putCheckpoint(changed),/checkpoint integrity mismatch/);
    // A valid outer file digest must not bypass the inner checkpoint check.
    const changedBytes=JSON.stringify(changed)+'\n',changedKey=createHash('sha256').update(changedBytes).digest('hex');
    await writeFile(join(directory,changedKey+'.json'),changedBytes,{flag:'wx'});
    await assert.rejects(reopened.readCheckpoint(changedKey),/checkpoint integrity mismatch/);
    // Conversely, a valid checkpoint under another object's address is refused.
    const wrongKey='0'.repeat(64);
    await writeFile(join(directory,wrongKey+'.json'),JSON.stringify(canonical)+'\n',{flag:'wx'});
    await assert.rejects(reopened.readCheckpoint(wrongKey),/object digest mismatch/);
    const restored=SelectedExecutionHarness.restore(await reopened.readCheckpoint(canonicalReceipt.key),{
      journal:reopened,services:{'demo.readAsync':()=>{throw new Error('must not repeat');}}});
    assert.throws(()=>restored.dispatch('call','effect'),/uncertain/);assert.equal(calls,1);
    restored.reconcile('call','effect',{disposition:'fulfilled',evidenceId:'service-receipt',value:5});
    restored.selected('call',w('resume',{continuation:'c',invocation:'call',status:'fulfilled',result:['num',5]}));
    restored.selected('call',w('return',{value:['num',5]}));restored.selected('call',w('end',{kind:'return'}));
    assert.equal(restored.invocations.get('call').controller.completion.value[1],5);
    const record=await reopened.readIntent('session1','call/effect');
    assert.deepEqual(await reopened.append(record),await reopened.append(record));
    await assert.rejects(reopened.append({...record,witness:'forged bytes'}),/Conflicting/);
    assert.equal(JSON.parse(await readFile(join(directory,receipt.key+'.json'))).schema,'semantic-checkpoint/6');
    resolve(5);await pending;
  }finally{await rm(directory,{recursive:true,force:true});}
});
