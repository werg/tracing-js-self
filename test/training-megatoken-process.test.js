import assert from 'node:assert/strict';
import test from 'node:test';
import {createMegatokenProcessSelector} from '../src/training/megatoken-process.js';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';

function mockProcess(script){
  return createMegatokenProcessSelector({
    command:process.execPath,args:['-e',script],maxOutstanding:4,
  });
}
const prefix={schema:'selected-inference-prefix/2',
  invocationId:'call1',trackId:'worker1',committed:[{session:'s1'}]};

test('graceful model shutdown waits for EOF evidence and is idempotent',async()=>{
  const root=await mkdtemp(join(process.cwd(),'.process-shutdown-'));
  const output=join(root,'flushed.json');
  const select=mockProcess(`
    process.stdin.resume();
    process.stdin.on('end',()=>{
      require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({runtimeClosed:true}));
    });
  `);
  try{
    const receipt=await select.shutdown();
    assert.equal(receipt.graceful,true);
    assert.equal((await select.shutdown()).exitCode,0);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),{runtimeClosed:true});
    assert.equal(select.status().closed,true);
    await assert.rejects(select(prefix),/closed/);
  }finally{select.close();await rm(root,{recursive:true,force:true});}
});

test('graceful shutdown reports failure instead of inventing a successful flush',async()=>{
  const select=mockProcess(`process.stdin.resume();process.stdin.on('end',()=>process.exit(7));`);
  await assert.rejects(select.shutdown(),/shutdown failed 7/);
  const hung=mockProcess(`process.stdin.resume();setInterval(()=>{},1000);`);
  await assert.rejects(hung.shutdown({timeoutMs:200}),/deadline exceeded/);
});

test('model initialization attests checkpoint and seed before semantic selection',async()=>{
  const script=`
    let buffer='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',data=>{buffer+=data;for(;;){
      const n=buffer.indexOf('\\n');if(n<0)break;
      const request=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
      const result=request.op==='initialize'?{schema:'semantic-inference-identity/4',
        seed:request.seed,checkpointIdentity:'a'.repeat(64),tokenizerIdentity:'actual-tokenizer'}:
        {schema:'selected-model-output/2',representation:'compact',
          record:'return {"value":["num",7]}',selection:{modelSelected:true,
          ownerTrack:request.prefix.trackId,selectedEventId:'m1'}};
      process.stdout.write(JSON.stringify({id:request.id,ok:true,result})+'\\n');
    }});
  `;
  const select=mockProcess(script);
  try{
    const receipt=await select.initialize({seed:29,checkpointIdentity:'a'.repeat(64)});
    assert.equal(receipt.seed,29);
    assert.equal((await select(prefix)).record,'return {"value":["num",7]}');
    await assert.rejects(select.initialize({seed:29,checkpointIdentity:'b'.repeat(64)}),/attest/);
  }finally{select.close();}
});
test('model process bridge uses stable JSONL action identities and terminal acknowledgement',async()=>{
  const script=`
    let buffer='';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',data=>{
      buffer+=data;
      for(;;){
        const n=buffer.indexOf('\\n');if(n<0)break;
        const line=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
        const result=line.op==='select'?{
          schema:'selected-model-output/2',
          record:'return {"value":["num",7]}',
          selection:{modelSelected:true,modelTrack:'track:0',
            ownerTrack:line.prefix.trackId,selectedEventId:'m1'}
        }:null;
        process.stdout.write(JSON.stringify({id:line.id,ok:true,result})+'\\n');
      }
    });
  `;
  const select=mockProcess(script);
  try{
    const results=await Promise.all([select(prefix),select(prefix)]);
    assert.equal(results[0].record,'return {"value":["num",7]}');
    assert.deepEqual(results[0],results[1]);
    await select.complete(prefix);
    await select.cancel(prefix);
    assert.equal(select.status().pending,0);
  }finally{select.close();}
});

test('model result with forged owner or uncommitted provenance never reaches controller',async()=>{
  const script=`
    let data='';
    process.stdin.on('data',bytes=>{
      data+=bytes.toString();
      const index=data.indexOf('\\n');if(index<0)return;
      const req=JSON.parse(data.slice(0,index));
      process.stdout.write(JSON.stringify({
        id:req.id,ok:true,
        result:{schema:'selected-model-output/2',record:'request {}',
          selection:{modelSelected:false,ownerTrack:'intruder',
            selectedEventId:'wrong'}}
      })+'\\n');
    });
  `;
  const select=mockProcess(script);
  try{
    await assert.rejects(select(prefix),/not tied|original/);
  }finally{select.close();}
});

test('native model error is surfaced without synthesizing a reference selection',async()=>{
  const script=`
    let data='';
    process.stdin.on('data',bytes=>{
      data+=bytes.toString();
      const index=data.indexOf('\\n');if(index<0)return;
      const req=JSON.parse(data.slice(0,index));
      process.stdout.write(JSON.stringify({id:req.id,ok:false,
        error:{category:'InvalidModelSelection',message:'bad witness',
          evidence:{payloadHex:'626164',selectedEventId:'rejected1'}}})+'\\n');
    });
  `;
  const select=mockProcess(script);
  try{await assert.rejects(select(prefix),error=>{
    assert.match(error.message,/bad witness/);
    assert.equal(error.category,'InvalidModelSelection');
    assert.equal(error.evidence.payloadHex,'626164');return true;
  });}
  finally{select.close();}
});

test('compact inference sends its declared representation to the actual process',async()=>{
  const script=`
    process.stdin.once('data',data=>{
      const request=JSON.parse(data.toString());
      process.stdout.write(JSON.stringify({id:request.id,ok:true,result:{
        schema:'selected-model-output/2',representation:request.representation,
        record:'return {"value":["num",7]}',selection:{modelSelected:true,
          ownerTrack:request.prefix.trackId,selectedEventId:'compact1'}}})+'\\n');
    });
  `;
  const select=createMegatokenProcessSelector({command:process.execPath,args:['-e',script],representation:'compact'});
  try{assert.equal((await select(prefix)).representation,'compact');}
  finally{select.close();}
});

test('UTF-8 response fragments preserve original selected witness bytes',async()=>{
  const record='return {"value":["str","🙂 café"]}';
  const script=`
    process.stdin.once('data',data=>{
      const request=JSON.parse(data.toString());
      const bytes=Buffer.from(JSON.stringify({id:request.id,ok:true,result:{schema:'selected-model-output/2',
        record:${JSON.stringify(record)},selection:{modelSelected:true,ownerTrack:'worker1',selectedEventId:'event1'}}})+'\\n');
      const at=bytes.indexOf(Buffer.from('🙂'))+1;
      process.stdout.write(bytes.subarray(0,at));
      setTimeout(()=>process.stdout.write(bytes.subarray(at)),5);
    });`;
  const select=mockProcess(script);
  try{assert.equal((await select(prefix)).record,record);}finally{select.close();}
});

test('native request commitment binds original selected bytes and fragments without a second model selection',async()=>{
  const script=`
    const {createHash}=require('node:crypto');
    process.stdin.once('data',data=>{
      const request=JSON.parse(data.toString());
      if(request.op!=='commit-request'||request.selection.fragments.length!==2)process.exit(2);
      const result={schema:'semantic-native-action/4',invocationId:request.invocation,
        effectId:request.validation.effectId,recordDigest:createHash('sha256').update(request.record).digest('hex'),
        actionKey:'m1:event2',ownerTrack:request.selection.ownerTrack,modelTrack:request.selection.modelTrack};
      process.stdout.write(JSON.stringify({id:request.id,ok:true,result})+'\\n');
    });`;
  const record='request {"effect":"read","operation":"demo.readAsync","arguments":[["str","key"]],"invocation":"call1","site":{"start":0,"end":20},"payload":"[\\"key\\"]","promise":"p"}';
  const select=mockProcess(script);
  try{
    const result=await select.commitRequest(prefix,{record,selection:{ownerTrack:'worker1',modelTrack:'track:1',
      selectedEventId:'event2',fragments:[{selectedEventId:'event1'},{selectedEventId:'event2'}]},
      validation:{effectId:'read',payloadDigest:createHash('sha256').update(record).digest('hex')}});
    assert.equal(result.actionKey,'m1:event2');assert.equal(select.status().pending,0);
  }finally{select.close();}
});

test('a nonresponsive inference process times out and clears all pending RPCs',async()=>{
  const select=createMegatokenProcessSelector({command:process.execPath,
    args:['-e',"process.stdin.resume();"],timeoutMs:50});
  try{await assert.rejects(select(prefix),/deadline exceeded/);
    assert.equal(select.status().closed,true);assert.equal(select.status().pending,0);
  }finally{select.close();}
});

function orchestrationProcess({substituteRecord=false,forgeAuthority=false}={}){
  return mockProcess(`
    const states=new Map();let buffer='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',data=>{buffer+=data;for(;;){
      const n=buffer.indexOf('\\n');if(n<0)break;
      const req=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);let result;
      if(req.op==='open-orchestration'){
        result={schema:'semantic-orchestration-state/4',session:req.session,track:'native:'+req.session,
          representation:req.representation,origin:req.origin,status:'active',steps:0,
          children:[],tracks:[],receipts:[],observations:[],decisions:[]};states.set(req.session,result);
      }else if(req.op==='select-controlled'){
        result={schema:'selected-model-output/2',record:req.record,representation:req.representation,
          selection:{modelSelected:${forgeAuthority},origin:'controlled-test-injected',
            ownerTrack:req.prefix.trackId,modelTrack:'native:child',selectedEventId:'native:semantic'}};
      }else{
        result=states.get(req.session);
        if(req.op==='step-orchestration'){
          result.steps++;
          result.decision={record:${substituteRecord}?'{}':req.controlledRecord??'{"name":"track_complete","arguments":{}}',
            outcomes:[],selection:{modelSelected:result.origin==='model',origin:result.origin,
              modelTrack:result.track,selectedEventId:'native:lifecycle'+result.steps}};
          result.decisions.push(result.decision);
        }else if(req.op==='cancel-orchestration')result.status='cancelled';
      }
      process.stdout.write(JSON.stringify({id:req.id,ok:true,result})+'\\n');
    }});
  `);
}

test('orchestration transport preserves explicit fixture authority within one native process',async()=>{
  const select=orchestrationProcess(),record='{"name":"track_complete","arguments":{"address":"native:fixture"}}';
  try{
    const state=await select.openOrchestration({session:'fixture',proposals:[],origin:'controlled'});
    const decision=await select.stepOrchestration({session:'fixture',track:state.track,controlledRecord:record});
    assert.equal(decision.decision.record,record);assert.equal(decision.decision.selection.modelSelected,false);
    const actual=await select.selectControlled({...prefix,committed:[{session:'fixture'}]},'return {"value":["num",7]}');
    assert.equal(actual.selection.origin,'controlled-test-injected');assert.equal(actual.selection.modelSelected,false);
    assert.equal((await select.statusOrchestration({session:'fixture',track:state.track})).steps,1);
    assert.equal((await select.cancelOrchestration({session:'fixture',track:state.track,reason:'done'})).status,'cancelled');
    await assert.rejects(select.openOrchestration({session:'fixture',proposals:[],origin:'controlled'}),/fresh session/);
  }finally{select.close();}
});

test('actual-model orchestration refuses fixture injection before any native RPC',async()=>{
  const select=orchestrationProcess();
  try{
    const state=await select.openOrchestration({session:'actual',proposals:[],origin:'model'});
    await assert.rejects(select.stepOrchestration({session:'actual',track:state.track,controlledRecord:'{}'}),/cannot enter actual model/);
    await assert.rejects(select.selectControlled({...prefix,committed:[{session:'actual'}]},'return {}'),/explicitly opened fixture/);
    assert.equal((await select.statusOrchestration({session:'actual',track:state.track})).steps,0);
    const output=await select.stepOrchestration({session:'actual',track:state.track});
    assert.equal(output.decision.selection.modelSelected,true);
    await assert.rejects(select.stepOrchestration({session:'actual',track:'wrong'}),/Unknown orchestration owner/);
  }finally{select.close();}
});

test('orchestration rejects replaced lifecycle bytes and relabeled controlled child actions',async()=>{
  for(const options of [{substituteRecord:true},{forgeAuthority:true}]){
    const select=orchestrationProcess(options);
    try{
      const state=await select.openOrchestration({session:'fixture',proposals:[],origin:'controlled'});
      if(options.substituteRecord)await assert.rejects(select.stepOrchestration({session:'fixture',track:state.track,
        controlledRecord:'{"name":"track_complete","arguments":{}}'}),/original committed native/);
      else await assert.rejects(select.selectControlled({...prefix,committed:[{session:'fixture'}]},
        'return {"value":["num",7]}'),/original native fixture/);
    }finally{select.close();}
  }
});
