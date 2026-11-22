import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readlinkSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createSelectedOrchestrationExecutionClock,validateSelectedOrchestrationClockReceipt}
  from '../src/storage/selected-orchestration-clock.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const modulePath=fileURLToPath(new URL('../src/storage/selected-orchestration-clock.js',import.meta.url));
let timeNamespaceAvailable=false;
try{timeNamespaceAvailable=/^time:\[[1-9][0-9]*\]$/.test(readlinkSync('/proc/self/ns/time'));}
catch{}
function fixtureReceipt({consumedElapsedMs=100,timeoutMs=1000,issuedMonotonicNs=process.hrtime.bigint().toString()}={}){
  const body={schema:'selected-orchestration-clock-receipt/1',
    bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
    timeNamespace:timeNamespaceAvailable?readlinkSync('/proc/self/ns/time'):'time:[1]',
    issuedMonotonicNs,consumedElapsedMs,timeoutMs};
  return {...body,digest:createHash('sha256').update(stableAlgorithmJSON(body),'utf8').digest('hex')};
}
const reseal=receipt=>{
  const {digest,...body}=receipt;
  return {...body,digest:createHash('sha256').update(stableAlgorithmJSON(body),'utf8').digest('hex')};
};

test('same-boot clock receipt carries monotonic elapsed time across a fresh process',{
  skip:timeNamespaceAvailable?false:'Linux time namespace link is unavailable in this runtime'
},async()=>{
  const clock=createSelectedOrchestrationExecutionClock(),started=process.hrtime.bigint(),base=12.5;
  const receipt=await clock.capture({timeoutMs:5000,elapsedMs:sample=>
    base+Number(sample-started)/1_000_000});
  assert.equal(validateSelectedOrchestrationClockReceipt(receipt,{timeoutMs:5000}),true);
  const canonicalReceipt=JSON.parse(stableAlgorithmJSON(receipt));
  assert.equal(validateSelectedOrchestrationClockReceipt(canonicalReceipt,{timeoutMs:5000}),true,
    'history key sorting must preserve receipt validation');
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {createSelectedOrchestrationExecutionClock} from ${JSON.stringify(modulePath)};
    const receipt=${JSON.stringify(canonicalReceipt)};
    await new Promise(resolve=>setTimeout(resolve,35));
    const elapsedMs=await createSelectedOrchestrationExecutionClock().elapsed(receipt,{timeoutMs:5000});
    process.stdout.write(JSON.stringify({elapsedMs}));
  `],{encoding:'utf8',timeout:5000});
  assert.equal(child.status,0,child.stderr);
  const resumed=JSON.parse(child.stdout);
  assert(resumed.elapsedMs>=receipt.consumedElapsedMs+25,resumed.elapsedMs);
  assert(resumed.elapsedMs<5000);
});

test('clock receipt rejects altered fields, timeout changes, expiry and forged live objects',async()=>{
  const clock=createSelectedOrchestrationExecutionClock(),receipt=fixtureReceipt();
  for(const mutate of [
    value=>{value.consumedElapsedMs=101;},
    value=>{value.issuedMonotonicNs='01';},
    value=>{value.extra=true;}
  ]){
    const changed=structuredClone(receipt);mutate(changed);
    assert.throws(()=>validateSelectedOrchestrationClockReceipt(changed),/digest|timestamp|fields/);
    await assert.rejects(clock.elapsed(changed),/digest|timestamp|fields/);
  }
  await assert.rejects(clock.elapsed(receipt,{timeoutMs:1001}),/timeout changed/);
  await assert.rejects(clock.elapsed.call({},receipt),/original live clock capability/);
  const expired=fixtureReceipt({consumedElapsedMs:1000,timeoutMs:1000});
  assert.throws(()=>validateSelectedOrchestrationClockReceipt(expired),/deadline has expired/);
});

test('capture explicitly succeeds or refuses according to the observed namespace capability',async()=>{
  const clock=createSelectedOrchestrationExecutionClock();
  if(timeNamespaceAvailable){
    const started=process.hrtime.bigint(),receipt=await clock.capture({timeoutMs:5000,
      elapsedMs:sample=>Number(sample-started)/1_000_000});
    assert.equal(validateSelectedOrchestrationClockReceipt(receipt),true);
  }else await assert.rejects(clock.capture({timeoutMs:1000,elapsedMs:()=>0}),
    /ENOENT|time namespace identity/);
});

test('elapsed snapshots caller data before async reads and rejects rehashed authority substitutions',{
  skip:timeNamespaceAvailable?false:'Linux time namespace link is unavailable in this runtime'
},async()=>{
  const clock=createSelectedOrchestrationExecutionClock(),started=process.hrtime.bigint(),receipt=await clock.capture({
    timeoutMs:5000,elapsedMs:sample=>Number(sample-started)/1_000_000});
  const callerReceipt=structuredClone(receipt),inFlight=clock.elapsed(callerReceipt,{timeoutMs:5000});
  callerReceipt.consumedElapsedMs=4000;callerReceipt.digest='0'.repeat(64);
  const consumed=await inFlight;
  assert(consumed<1000,'receipt mutations after invocation must not alter the snapshotted authority');

  for(const mutate of [
    value=>{value.bootId='00000000-0000-0000-0000-000000000000';},
    value=>{value.timeNamespace=value.timeNamespace==='time:[1]'?'time:[2]':'time:[1]';},
    value=>{value.issuedMonotonicNs=(BigInt(value.issuedMonotonicNs)+10_000_000_000n).toString();}
  ]){
    const altered=structuredClone(await clock.capture({timeoutMs:5000,
      elapsedMs:sample=>Number(sample-started)/1_000_000}));
    mutate(altered);const changed=reseal(altered);
    await assert.rejects(clock.elapsed(changed),/boot or time namespace changed|moved backwards/);
  }
});

test('same-boot elapsed checks include time after capture',{
  skip:timeNamespaceAvailable?false:'Linux time namespace link is unavailable in this runtime'
},async()=>{
  const clock=createSelectedOrchestrationExecutionClock(),started=process.hrtime.bigint(),receipt=await clock.capture({
    timeoutMs:35,elapsedMs:sample=>Number(sample-started)/1_000_000});
  await new Promise(resolve=>setTimeout(resolve,45));
  await assert.rejects(clock.elapsed(receipt),/deadline has expired/);
});
