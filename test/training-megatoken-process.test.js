import assert from 'node:assert/strict';
import test from 'node:test';
import {createMegatokenProcessSelector} from '../src/training/megatoken-process.js';

function mockProcess(script){
  return createMegatokenProcessSelector({
    command:process.execPath,args:['-e',script],maxOutstanding:4,
  });
}
const prefix={schema:'selected-inference-prefix/1',
  invocationId:'call1',trackId:'worker1',committed:[{session:'s1'}]};

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
          schema:'selected-model-output/1',
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
        result:{schema:'selected-model-output/1',record:'request {}',
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
        error:{category:'InvalidModelSelection',message:'bad witness'}})+'\\n');
    });
  `;
  const select=mockProcess(script);
  try{await assert.rejects(select(prefix),/bad witness/);}
  finally{select.close();}
});
