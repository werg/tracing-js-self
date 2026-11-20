import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNativeV8ProcessSelector} from '../src/semantic/native-process-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {commitCausalLmV8Selection} from '../src/semantic/causal-lm-v8.js';

const artifact=JSON.parse(readFileSync(new URL('./fixtures/semantic-regions-v8.json',import.meta.url))).examples
  .find(row=>row.id==='ordered-map');
const row=artifact.public.timeline.find(row=>row.mode==='generated');
const identity={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),seed:17};
const programModule=new URL('../src/semantic/program.js',import.meta.url).href;
function fakeServer({alter='',initializeAlter='',commitAlter='',raw=false,hang=false}={}){
  return `import {createInterface} from 'node:readline';
    import {hashAlgorithmData} from ${JSON.stringify(programModule)};
    const record=${JSON.stringify(row.fields.line)};
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);let result;
      if(request.op==='initialize'){
        result={schema:'semantic-inference-identity/8',checkpointIdentity:request.checkpointIdentity,
          tokenizerIdentity:request.tokenizerIdentity,seed:request.seed};${initializeAlter}
      }else if(request.op==='select'){
        ${hang?'continue;':''}
        const payloadHex=Buffer.from(record).toString('hex');
        result={schema:'semantic-model-output/8',record,selection:{modelSelected:true,selectionId:'selection:'+request.id,
          origin:'actual-model-selected',checkpointIdentity:${JSON.stringify(identity.checkpointIdentity)},
          tokenizerIdentity:${JSON.stringify(identity.tokenizerIdentity)},prefixDigest:request.context.prefixDigest,
          contextDigest:hashAlgorithmData(request.context),payloadHex,
          fragments:[{tokenIds:[...Buffer.from(record)],payloadHex}]}};${alter}
      }else if(request.op==='commit'){result={committed:true};${commitAlter}}
      else if(request.op==='reject')result={rejected:true};
      else result={closed:true};
      ${raw?"process.stdout.write(Buffer.from([0xff,10]));":`
        const output=JSON.stringify({id:request.id,ok:true,result})+'\\n';
        process.stdout.write(output.slice(0,7));
        await new Promise(resolve=>setTimeout(resolve,1));
        process.stdout.write(output.slice(7));`}
    }`;
}
function boundary(){
  const harness=RegionExecutionHarness.replay({...artifact.public,
    timeline:artifact.public.timeline.slice(0,row.sequence-1)},{requireTerminal:false});
  return {harness,input:{session:harness.inner.sessionId,public:harness.exportEpisode(),contexts:[],
    context:harness.modelContext(row.fields.invocationId)}};
}
function selector(options={}){return createNativeV8ProcessSelector({command:process.execPath,
  args:['--input-type=module','-e',fakeServer(options)],timeoutMs:options.timeoutMs??5000});}

test('native v8 transport preserves fragmented original output and waits for semantic acknowledgement',async()=>{
  const select=selector(),{harness,input}=boundary();
  try{
    await select.initialize(identity);
    const output=await select(input);
    assert.equal(output.record,row.fields.line);
    await assert.rejects(select(input),/commit or cancellation/);
    assert.equal(select.metrics().semanticallyAccepted,0);
    commitCausalLmV8Selection(harness,row.fields.invocationId,output.record,{context:input.context});
    const committed=await select.commit({session:input.session,public:harness.exportEpisode(),
      contexts:[input.context],invocationId:row.fields.invocationId,...output});
    assert.equal(committed.committed,true);
    assert.equal(select.metrics().semanticallyAccepted,1);
    assert.equal(select.metrics().sourceAdmissionClaim,false);
    assert.equal(select.metrics().nativeAdmissionClaim,false);
    assert.equal((await select.shutdown()).graceful,true);
  }finally{select.close();}
});

test('native v8 output cannot change checkpoint, causal boundary or original bytes',async()=>{
  for(const alter of [
    "result.selection.checkpointIdentity='f'.repeat(64);",
    "result.selection.contextDigest='f'.repeat(64);",
    "result.selection.prefixDigest='f'.repeat(64);",
    "result.selection.payloadHex='00';",
    "result.selection.fragments[0].payloadHex='00';",
    "result.selection.fragments[0].tokenIds=[];",
    "result.selection.modelSelected=false;"
  ]){
    const select=selector({alter});
    try{
      await select.initialize(identity);
      await assert.rejects(select(boundary().input),/bound|bytes|evidence/);
      const metrics=select.metrics();
      assert.equal(metrics.predictionAttempts,1);assert.equal(metrics.failedAttempts,1);
      assert(metrics.attempts[0].selection,'failed original response is retained');
    }finally{select.close();}
  }
});

test('native v8 transport rejects current-context leakage, stale prefixes and changed commit bytes',async()=>{
  const select=selector(),{input}=boundary();
  try{
    await select.initialize(identity);
    await assert.rejects(select({...input,contexts:[input.context]}),/prior contexts/);
    const changed=structuredClone(input);changed.public.timeline[0].fields.source+=' ';
    await assert.rejects(select(changed),/cutoff/);
    assert.equal(select.metrics().predictionAttempts,0);
    const output=await select(input);
    await assert.rejects(select.commit({session:input.session,...output,record:output.record+' '}),/original/);
    await select.cancel({session:input.session,reason:'controlled rejection'});
    assert.equal(select.metrics().failedAttempts,1);
  }finally{select.close();}
});

test('native v8 failed initialization cannot leave an earlier checkpoint active',async()=>{
  const select=selector({initializeAlter:"if(request.seed===2)result.tokenizerIdentity='f'.repeat(64);"});
  try{
    await select.initialize(identity);
    await assert.rejects(select.initialize({...identity,seed:2}),/identity/);
    await assert.rejects(select(boundary().input),/not attested/);
  }finally{select.close();}
});

test('native v8 malformed UTF-8 and deadlines terminate the transport',async()=>{
  const malformed=selector({raw:true});
  try{await assert.rejects(malformed.initialize(identity),/UTF-8/);assert.equal(malformed.status().closed,true);}
  finally{malformed.close();}
  const stalled=selector({hang:true,timeoutMs:500});
  try{
    await stalled.initialize(identity);
    await assert.rejects(stalled(boundary().input),/deadline/);
    assert.equal(stalled.status().closed,true);
    assert.equal(stalled.metrics().failedAttempts,1);
  }finally{stalled.close();}
});

test('native acknowledgement failure does not count an execution as accepted',async()=>{
  const select=selector({commitAlter:'result.committed=false;'}),{input}=boundary();
  try{
    await select.initialize(identity);const output=await select(input);
    await assert.rejects(select.commit({session:input.session,...output}),/acknowledge/);
    assert.equal(select.metrics().semanticallyAccepted,0);
    assert.equal(select.metrics().failedAttempts,1);
  }finally{select.close();}
});

test('stale native candidates can be rejected without closing the session or losing their costs',async()=>{
  const select=selector(),{input}=boundary();
  try{
    await select.initialize(identity);const first=await select(input);
    await assert.rejects(select.reject({session:input.session,selectionId:'wrong',reason:'stale'}),/original/);
    await select.reject({session:input.session,selectionId:first.selection.selectionId,reason:'stale'});
    const second=await select(input);
    assert.notEqual(first.selection.selectionId,second.selection.selectionId);
    assert.equal(select.metrics().predictionAttempts,2);assert.equal(select.metrics().failedAttempts,1);
    assert.deepEqual(select.metrics().attempts[0].selection.fragments,first.selection.fragments);
  }finally{select.close();}
});
