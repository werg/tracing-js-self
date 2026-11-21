// Actual-I/O race: the duplicate's claim is durable BEFORE the winner links its
// outcome. Only then intercept directory fsync, including the duplicate's read.
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {DurableSelectedServiceJournal} from '../../src/storage/selected-service-journal.js';
import {DurableFencedSelectedServiceJournal} from '../../src/storage/selected-service-fence-journal.js';
import {createDurableSelectedService} from '../../src/host/selected-service.js';

const {directory,fenced}=JSON.parse(process.argv[2]);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const started=deferred(),serviceContinues=deferred(),duplicateClaimed=deferred(),readerContinues=deferred(),
  linked=deferred(),publisherContinues=deferred();
const make=()=>fenced?new DurableFencedSelectedServiceJournal({directory,serviceId:'controlled-store',sessionId:'session'}):
  new DurableSelectedServiceJournal({directory});
const journal=make(),owner=fenced?await journal.advanceOwner({ownerId:'owner'}):null,
  bind=value=>fenced?value.forOwner(owner):value,duplicate=bind(make()),
  target=fenced?join(journal.scopeDirectory,'outcomes'):directory;
const payload='["key",7]',selectedAction={sessionId:'session',invocationId:'call',effectId:'effect',operation:'demo.store',
  idempotencyKey:'session/call/effect',payload,payloadDigest:createHash('sha256').update(payload).digest('hex'),
  taskRevision:1,witness:'request effect'},context={...selectedAction,selectedAction};
let calls=0,readerSynchronizations=0,phase='armed';
const service=(bound,implementation)=>createDurableSelectedService({serviceId:'controlled-store',operation:'demo.store',
  journal:bound,service:implementation}),
  result=promise=>promise.then(value=>({status:'fulfilled',value}),
    error=>({status:'refused',code:error.code,causeCode:error.cause?.code}));
const winner=result(service(bind(journal),async()=>{calls++;started.resolve();await serviceContinues.promise;return 7;})
  (['key',7],context));
await started.promise;
const loser=result(service({read:duplicate.read.bind(duplicate),complete:duplicate.complete.bind(duplicate),
  claim:async action=>{const receipt=await duplicate.claim(action);
    if(receipt.claimed)throw Error('Duplicate unexpectedly won');duplicateClaimed.resolve();await readerContinues.promise;return receipt;}},
  ()=>{calls++;return 8;})(['key',7],context));
await duplicateClaimed.promise;

const originalOpen=promises.open;
promises.open=async(...args)=>{
  const handle=await originalOpen(...args);
  if(args[0]===target){
    const nativeSync=handle.sync.bind(handle);
    handle.sync=async()=>{
      if(phase==='armed'){
        phase='linked';linked.resolve();await publisherContinues.promise;
        throw Object.assign(Error('Injected publisher directory fsync failure'),{code:'EIO'});
      }
      if(phase==='linked'){
        readerSynchronizations++;
        throw Object.assign(Error('Injected reader directory fsync failure'),{code:'EIO'});
      }
      return nativeSync();
    };
  }
  return handle;
};
syncBuiltinESMExports();
const deadline=setTimeout(()=>{throw Error('Outcome synchronization race did not settle');},10000);deadline.unref();
let observed,published;
try{
  serviceContinues.resolve();await linked.promise;readerContinues.resolve();observed=await loser;
  publisherContinues.resolve();published=await winner;
}finally{
  readerContinues.resolve();publisherContinues.resolve();
  await Promise.all([winner,loser]);
  promises.open=originalOpen;syncBuiltinESMExports();clearTimeout(deadline);
}
const recovered=await service(bind(make()),()=>{calls++;return 8;})(['key',7],context);
process.send({phase:'finished',observed,published,readerSynchronizations,recovered,calls});
process.disconnect();
