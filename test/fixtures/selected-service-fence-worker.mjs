import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DurableFencedSelectedServiceJournal} from '../../src/storage/selected-service-fence-journal.js';
import {createDurableSelectedService,SelectedServiceBoundaryError} from '../../src/host/selected-service.js';

const config=JSON.parse(process.argv[2]),{directory,owner,role,mode}=config;
const pause=async phase=>{const continued=new Promise(resolve=>process.once('message',resolve));
  process.send({phase});await continued;};
class ControlledJournal extends DurableFencedSelectedServiceJournal {
  async _publishEntry(entry){
    this.publishing=entry.command.kind;
    if(mode==='pause-before-publish'&&this.publishing==='claim')await pause('before-publish');
    return super._publishEntry(entry);
  }
  async _synchronize(){
    if(this.publishing==='claim'&&mode==='pause-linked-claim')await pause('linked');
    if(this.publishing==='claim'&&mode==='crash-linked-claim')process.exit(17);
    return super._synchronize();
  }
}
const journal=new ControlledJournal({directory,serviceId:'fenced-store',sessionId:'session'});
try{
  if(mode==='advance'){
    await pause('ready');
    const receipt=await journal.advanceOwner({previous:owner,ownerId:role});
    process.send({phase:'finished',status:'advanced',receipt});
  }else{
    const effectId=config.effectId??'effect',payload=JSON.stringify(['key',7]),
      selectedAction={sessionId:'session',invocationId:'call',effectId,operation:'demo.store',
        idempotencyKey:'session/call/'+effectId,payload,
        payloadDigest:createHash('sha256').update(payload).digest('hex'),taskRevision:1,witness:'request '+effectId},
      adapter=createDurableSelectedService({serviceId:'fenced-store',operation:'demo.store',journal:journal.forOwner(owner),
        service:async()=>{
          await appendFile(join(directory,'effects.jsonl'),role+'\n');
          if(mode==='crash-after-effect')process.exit(17);
          if(mode==='race-claim')await pause('effect-recorded');
          return 7;
        }});
    if(mode==='race-claim')await pause('ready');
    const value=await adapter(['key',7],{...selectedAction,selectedAction});
    process.send({phase:'finished',status:'fulfilled',value});
  }
}catch(error){
  if(!(error instanceof SelectedServiceBoundaryError))throw error;
  process.send({phase:'finished',status:'refused',code:error.code});
}
process.disconnect();
