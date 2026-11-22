// Independent actual-I/O fault probe. No repository source or schema changes.
// Intercept only fsync of the outcome directory after the outcome's hard link.
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DurableSelectedServiceJournal} from '../../../src/storage/selected-service-journal.js';
import {DurableFencedSelectedServiceJournal} from '../../../src/storage/selected-service-fence-journal.js';
import {selectedServiceActionDigest} from '../../../src/host/selected-service.js';

const originalOpen=promises.open;
async function probe(fenced){
  const directory=await promises.mkdtemp(join(tmpdir(),'read-fsync-probe-'));
  const payload='["key",7]',action={schema:'semantic-service-action/8',serviceId:'probe-store',sessionId:'probe-session',
    invocationId:'call',effectId:'effect',operation:'demo.store',idempotencyKey:'key',payload,
    payloadDigest:createHash('sha256').update(payload).digest('hex'),taskRevision:1,witness:'request effect'};
  const journal=fenced?new DurableFencedSelectedServiceJournal({directory,serviceId:action.serviceId,sessionId:action.sessionId}):
    new DurableSelectedServiceJournal({directory});
  const owner=fenced?await journal.advanceOwner({ownerId:'owner'}):null,
    receipt=fenced?await journal.claim(action,{owner}):await journal.claim(action),
    loser=fenced?await journal.claim(action,{owner}):await journal.claim(action);
  const outcome={schema:'semantic-service-outcome/8',actionDigest:selectedServiceActionDigest(action),
    status:'fulfilled',result:['num',7],errorOrigin:null};
  if(!receipt.claimed||loser.claimed)throw Error('Unexpected preparation');
  const target=fenced?join(journal.scopeDirectory,'outcomes'):directory;
  let phase='armed',readerSynchronizations=0,linkedResolve,releaseResolve;
  const linked=new Promise(resolve=>{linkedResolve=resolve;}),release=new Promise(resolve=>{releaseResolve=resolve;});
  promises.open=async function(...args){
    const handle=await originalOpen(...args);
    if(args[0]===target){
      const nativeSync=handle.sync.bind(handle);
      handle.sync=async()=>{
        if(phase==='armed'){
          phase='linked';linkedResolve();await release;
          throw Object.assign(new Error('Injected outcome directory fsync failure'),{code:'EIO'});
        }
        if(phase==='linked'){
          readerSynchronizations++;
          throw Object.assign(new Error('Injected recovered outcome directory fsync failure'),{code:'EIO'});
        }
        return nativeSync();
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const completion=journal.complete(action,outcome,receipt).then(()=>({status:'acknowledged'}),
    error=>({status:'unacknowledged',code:error.code,message:error.message}));
  let result;
  try{
    const deadline=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('No outcome link intercepted')),5000);timer.unref();});
    await Promise.race([linked,deadline]);
    let readReturned=false,readError=null;
    try{const read=await journal.read(action);readReturned=read.outcome?.result?.[1]===7;}
    catch(error){readError={code:error.code,message:error.message};}
    releaseResolve();
    result={journal:fenced?'fenced':'basic',readReturned,readError,readerSynchronizations,publisher:await completion};
  }finally{
    releaseResolve();await completion;
    promises.open=originalOpen;syncBuiltinESMExports();await promises.rm(directory,{recursive:true,force:true});
  }
  return result;
}
const results=[await probe(false),await probe(true)];
console.log(JSON.stringify(results,null,2));
