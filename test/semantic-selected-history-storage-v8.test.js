// Storage controls use structural checkpoint vectors. The coordinated driver
// tests separately validate complete source/host/model cuts before restoration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DurableSelectedHistoryJournal} from '../src/storage/selected-history.js';
import {validateSelectedHistoryChain} from '../src/semantic/selected-history-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const seal=body=>({...body,digest:hashAlgorithmData(body)});
function cut(rows=0){
  return seal({schema:'semantic-selected-driver-checkpoint/8',policy:{maxSelections:4},
    bridge:{schema:'semantic-region-continuation/8',profile:'storage-vector',ingressCursor:1,
      public:{schema:'semantic-execution/8',timeline:Array.from({length:rows},(_,sequence)=>({sequence}))}},
    contexts:[],attempts:[],staleRetries:0,native:{schema:'semantic-native-transport-checkpoint/8',
      identity:{seed:17},attempts:[],runtimeMetrics:{rpcCalls:0,computeSeconds:0,peakMemoryBytes:0},
      native:{schema:'semantic-model-checkpoint/8',initialization:{seed:17},attempts:[],sessions:{}}}});
}
async function fixture(t,options={}){
  const directory=await mkdtemp(join(tmpdir(),'v8-selected-history-storage-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return new DurableSelectedHistoryJournal({directory,streamId:'cuts',...options});
}

test('fsynced complete cuts survive a new reader process and read only the retained head',async t=>{
  const journal=await fixture(t),first=cut(),second=cut(1),third=cut(2);
  const earlier=await journal.append(first),head=await journal.append(second,{previous:earlier});
  await journal.append(third,{previous:head}); // Its receipt is deliberately not retained by this reader.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {DurableSelectedHistoryJournal} from './src/storage/selected-history.js';
    const journal=new DurableSelectedHistoryJournal({directory:process.argv[1],streamId:'cuts'});
    process.stdout.write(JSON.stringify(await journal.readAll(JSON.parse(process.argv[2]))));
  `,journal.directory,JSON.stringify(head)],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).map(entry=>entry.checkpoint),[first,second]);
  assert.deepEqual((await new DurableSelectedHistoryJournal({directory:journal.directory,streamId:'cuts'})
    .readAll(earlier)).map(entry=>entry.checkpoint),[first]);
});

test('competing writers can reacknowledge identical bytes but cannot replace a position',async t=>{
  const journal=await fixture(t),other=new DurableSelectedHistoryJournal({directory:journal.directory,streamId:'cuts'});
  const [left,right]=await Promise.all([journal.append(cut()),other.append(cut())]);
  assert.deepEqual(left,right);
  const attempts=await Promise.allSettled([journal.append(cut(1),{previous:left}),other.append(cut(2),{previous:right})]);
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(attempts.filter(row=>row.status==='rejected').length,1);
  const winner=attempts.find(row=>row.status==='fulfilled').value;
  const saved=(await journal.readAll(winner)).at(-1).checkpoint;
  assert.deepEqual(await other.append(saved,{previous:left}),winner);
  assert.deepEqual(await readdir(join(journal.directory,'selected-checkpoint-history','cuts')),['1.json','2.json']);
});

test('append captures caller bytes synchronously and does not change their checkpoint',async t=>{
  const journal=await fixture(t),packet=cut(),expected=structuredClone(packet);
  const saving=journal.append(packet);packet.policy.maxSelections=999;
  const receipt=await saving;
  assert.deepEqual((await journal.read(receipt)).checkpoint,expected);
});

test('changed files, omitted entries and reordered chains cannot match the retained receipt',async t=>{
  const journal=await fixture(t),first=await journal.append(cut()),head=await journal.append(cut(1),{previous:first});
  const rows=await journal.readAll(head);
  assert.throws(()=>validateSelectedHistoryChain(rows.slice(1),head),/incomplete/);
  assert.throws(()=>validateSelectedHistoryChain([...rows].reverse(),head),/reordered/);
  const changed=structuredClone(rows);changed[0].checkpoint.policy.maxSelections++;
  assert.throws(()=>validateSelectedHistoryChain(changed,head),/integrity/);
  const bytes=await readFile(journal.entryPath(1),'utf8');
  await writeFile(journal.entryPath(1),bytes.replace('storage-vector','storage-forged'));
  await assert.rejects(journal.readAll(head),/digest mismatch|file or size/);
});

test('history bounds refuse the append before publishing another immutable position',async t=>{
  const journal=await fixture(t,{maxEntries:1});
  const first=await journal.append(cut());
  await assert.rejects(journal.append(cut(1),{previous:first}),/position exceeds bound/);
  const bounded=new DurableSelectedHistoryJournal({directory:journal.directory,streamId:'cuts',maxBytes:first.bytes+1});
  await assert.rejects(bounded.append(cut(1),{previous:first}),/byte bound/);
  assert.deepEqual(await readdir(join(journal.directory,'selected-checkpoint-history','cuts')),['1.json']);
});

test('a branch or an older public checkpoint cannot extend an already retained cut',async t=>{
  const journal=await fixture(t),first=await journal.append(cut(2));
  await assert.rejects(journal.append(cut(1),{previous:first}),/public history.*exact extension/);
  const changed=cut(3);changed.bridge.public.timeline[0].sequence=91;
  const {digest,...body}=changed;
  await assert.rejects(journal.append(seal(body),{previous:first}),/public history.*exact extension/);
  assert.deepEqual(await journal.readAll(first),[await journal.read(first)]);
});
