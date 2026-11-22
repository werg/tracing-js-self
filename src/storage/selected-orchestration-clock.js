import {createHash} from 'node:crypto';
import {readFile,readlink} from 'node:fs/promises';
import {stableAlgorithmJSON} from '../semantic/ir.js';

const schema='selected-orchestration-clock-receipt/1';
const runtimeClocks=new WeakSet();
const exact=(value,keys,label)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))
    throw new TypeError(`Selected orchestration clock: invalid ${label} fields`);
};
const sha=value=>createHash('sha256').update(stableAlgorithmJSON(value),'utf8').digest('hex');
const fail=message=>{throw new TypeError('Selected orchestration clock: '+message);};
const receiptFields=['schema','bootId','timeNamespace','issuedMonotonicNs','consumedElapsedMs','timeoutMs','digest'];
const bodyFields=receiptFields.slice(0,-1);
const numeric=(value,label)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail(`${label} must be a finite nonnegative number`);
};
function seal(body){return Object.freeze({...body,digest:sha(body)});}
function assertClock(clock){if(!runtimeClocks.has(clock))fail('an original live clock capability is required');}
async function identity(){
  if(process.platform!=='linux')fail('Linux boot and time namespace identities are required');
  const [bootId,timeNamespace]=await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id','utf8'),readlink('/proc/self/ns/time')
  ]);
  const boot=bootId.trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boot)||
    !/^time:\[[1-9][0-9]*\]$/.test(timeNamespace))fail('invalid Linux boot or time namespace identity');
  return {bootId:boot,timeNamespace};
}
function elapsedSince(issued,current){
  const difference=current-issued;
  if(difference<0n)fail('monotonic clock moved backwards');
  const whole=difference/1_000_000n,remainder=difference%1_000_000n;
  return Number(whole)+Number(remainder)/1_000_000;
}
export function validateSelectedOrchestrationClockReceipt(receipt,{timeoutMs}={}){
  exact(receipt,receiptFields,'receipt');
  const {digest,...body}=receipt;
  exact(body,bodyFields,'receipt body');
  if(body.schema!==schema||typeof body.bootId!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.bootId)||
    typeof body.timeNamespace!=='string'||!/^time:\[[1-9][0-9]*\]$/.test(body.timeNamespace)||
    typeof body.issuedMonotonicNs!=='string'||! /^(?:0|[1-9][0-9]{0,39})$/.test(body.issuedMonotonicNs))
    fail('receipt identity or monotonic timestamp is malformed');
  numeric(body.consumedElapsedMs,'consumed elapsed time');
  if(typeof body.timeoutMs!=='number'||!Number.isFinite(body.timeoutMs)||body.timeoutMs<=0)
    fail('timeout must be a finite positive number');
  if(timeoutMs!==undefined&&(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs!==body.timeoutMs))
    fail('timeout changed after the pending fence');
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||digest!==sha(body))
    fail('receipt digest differs');
  if(body.consumedElapsedMs>=body.timeoutMs)fail('orchestration deadline has expired');
  return true;
}

/** A live capability for issuing and checking same-boot monotonic budget receipts. */
export function assertSelectedOrchestrationExecutionClock(clock){
  assertClock(clock);return true;
}

export function createSelectedOrchestrationExecutionClock(){
  const clock=Object.freeze({
    async capture({elapsedMs,timeoutMs}={}){
      assertClock(this);
      if(typeof elapsedMs!=='function')fail('a synchronous elapsed-at-sample callback is required');
      if(typeof timeoutMs!=='number'||!Number.isFinite(timeoutMs)||timeoutMs<=0)
        fail('timeout must be a finite positive number');
      const before=await identity();
      const issued=process.hrtime.bigint();
      const after=await identity();
      if(before.bootId!==after.bootId||before.timeNamespace!==after.timeNamespace)
        fail('boot or time namespace changed around the capture sample');
      // The receipt timestamp precedes the second identity read, so recovery
      // charges that read and all later selection/storage time.
      let consumed=elapsedMs(issued);
      if(consumed&&typeof consumed.then==='function')fail('elapsed callback must be synchronous');
      numeric(consumed,'consumed elapsed time');
      if(consumed>=timeoutMs)fail('orchestration deadline has expired');
      return seal({schema,bootId:before.bootId,timeNamespace:before.timeNamespace,
        issuedMonotonicNs:issued.toString(),consumedElapsedMs:consumed,timeoutMs});
    },
    async elapsed(receipt,options={}){
      assertClock(this);
      // Snapshot every caller-owned value before the first asynchronous read.
      const savedReceipt=structuredClone(receipt),savedOptions=structuredClone(options);
      validateSelectedOrchestrationClockReceipt(savedReceipt,{timeoutMs:savedOptions.timeoutMs});
      const before=await identity(),sample=process.hrtime.bigint(),after=await identity();
      if(before.bootId!==after.bootId||before.timeNamespace!==after.timeNamespace)
        fail('boot or time namespace changed around the resume sample');
      if(before.bootId!==savedReceipt.bootId||before.timeNamespace!==savedReceipt.timeNamespace)
        fail('boot or time namespace changed since the pending fence');
      const completed=process.hrtime.bigint(),issued=BigInt(savedReceipt.issuedMonotonicNs);
      // `completed` is sampled after the second identity read so its duration
      // is charged too; `sample` proves the identity was stable across timing.
      elapsedSince(sample,completed);
      const elapsed=savedReceipt.consumedElapsedMs+elapsedSince(issued,completed);
      if(!Number.isFinite(elapsed)||elapsed>=savedReceipt.timeoutMs)fail('orchestration deadline has expired');
      return elapsed;
    }
  });
  runtimeClocks.add(clock);
  return clock;
}
