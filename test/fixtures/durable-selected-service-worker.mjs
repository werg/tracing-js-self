// Isolated controlled service used by the two-owner/restart tests. The file
// append is the external effect; service journal publication is separate.
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SelectedExecutionLifecycleV8 as Lifecycle} from '../../src/semantic/lifecycle-v8.js';
import {SelectedIntentJournal} from '../../src/training/intent-journal.js';
import {DurableSelectedServiceJournal} from '../../src/storage/selected-service-journal.js';
import {createDurableSelectedService,SelectedServiceBoundaryError} from '../../src/host/selected-service.js';
import {encodeDetailedRecord} from '../../src/semantic/detail-v8.js';

const {directory,role,mode,packetName='before.json'}=JSON.parse(process.argv[2]);
const pause=async phase=>{
  const continued=new Promise(resolve=>process.once('message',resolve));
  process.send({phase});await continued;
};
const intentJournal=new SelectedIntentJournal({directory:join(directory,'producer')}),
  serviceJournal=new DurableSelectedServiceJournal({directory:join(directory,'service')});
const journal={append:intentJournal.append.bind(intentJournal),readIntent:intentJournal.readIntent.bind(intentJournal),
  claim:async record=>{
    const receipt=await intentJournal.claim(record);
    if(mode==='pause-producer-claim')await pause('producer-claimed');
    return receipt;
  }};
const gatedJournal={read:serviceJournal.read.bind(serviceJournal),complete:serviceJournal.complete.bind(serviceJournal),
  claim:async action=>{
    const receipt=await serviceJournal.claim(action);
    if(mode==='pause-service-claim')await pause('service-claimed');
    return receipt;
  }};
const adapter=createDurableSelectedService({serviceId:'controlled-store',operation:'demo.store',journal:gatedJournal,
  service:async()=>{
    await appendFile(join(directory,'effects.jsonl'),role+'\n');
    if(mode==='crash-after-effect')process.exit(17);
    if(mode==='race-service')await pause('effect-recorded');
    return 7;
  }});
const h=Lifecycle.restore(JSON.parse(await readFile(join(directory,packetName),'utf8')),
  {journal:mode==='race-service'?null:journal,services:{'demo.store':adapter}});
if(mode==='race-service')await pause('ready');
try{
  if(mode==='recover'){
    if(h.intents.get('call/e').status==='committed'){
      try{await h.dispatch('call','e');throw Error('Expected prior durable producer intent');}
      catch(error){if(!/Durable intent already exists/.test(error.message))throw error;}
    }
    h.reconcile('call','e',{disposition:'not-dispatched',evidenceId:'controlled-successor-reconciliation'});
  }
  await h.dispatch('call','e');
  h.selected('call',encodeDetailedRecord({kind:'return',fields:{value:['num',7]}}));
  h.selected('call',encodeDetailedRecord({kind:'end',fields:{kind:'return'}}));
  await writeFile(join(directory,role+'.json'),JSON.stringify(h.checkpoint()));
  process.send({phase:'finished',status:h.intents.get('call/e').status,
    results:h.timeline.filter(row=>row.kind==='result').length,
    replay:JSON.stringify(Lifecycle.replay(h.exportEpisode()).timeline)===JSON.stringify(h.timeline)});
}catch(error){
  if(!(error instanceof SelectedServiceBoundaryError))throw error;
  await writeFile(join(directory,role+'.json'),JSON.stringify(h.checkpoint()));
  process.send({phase:'finished',status:h.intents.get('call/e').status,code:error.code,
    results:h.timeline.filter(row=>row.kind==='result').length});
}
process.disconnect();
