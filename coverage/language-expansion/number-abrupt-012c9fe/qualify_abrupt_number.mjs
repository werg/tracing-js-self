import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [producerPath,outputPath,producerRevision,consumerRevision]=process.argv.slice(2);
if(!producerPath||!outputPath||!producerRevision||!consumerRevision)
  throw new Error('Usage: node qualify_abrupt_number.mjs PRODUCER NEW_OUTPUT PRODUCER_SHA CONSUMER_SHA');
const producer=resolve(producerPath),output=resolve(outputPath),consumer=resolve(process.env.MEGATOKEN_ROOT);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const identity=root=>({revision:git(root,'rev-parse','HEAD'),tree:git(root,'rev-parse','HEAD^{tree}'),
  status:git(root,'status','--porcelain=v1','--untracked-files=all')});
const before={producer:identity(producer),consumer:identity(consumer)};
assert.equal(before.producer.revision,producerRevision);assert.equal(before.consumer.revision,consumerRevision);
assert.equal(before.producer.status,'');assert.equal(before.consumer.status,'');
const load=path=>import(pathToFileURL(join(producer,path)));
const {verifyProtocolRegionTrainingCase}=await load('src/semantic/protocol-source-v8.js');
const {admitRegionEvidence}=await load('src/semantic/compiler-v8.js');
const {RegionExecutionHarness}=await load('src/semantic/region-harness.js');
const {auditRegionServingCosts}=await load('src/semantic/causal-lm-v8.js');
const {loadNativeV8Settings,createNativeV8Consumer}=await load('src/corpus/native-admission-v8.mjs');
const nativeTransportDirectory=join(output,'native-transports');
const nativeSettings=loadNativeV8Settings({megatoken:consumer,
  tokenizer:process.env.MEGATOKEN_TOKENIZER_JSON,python:process.env.MEGATOKEN_PYTHON,
  policyFile:join(producer,'contracts/semantic-native-policy-v8.json'),temporaryDirectory:nativeTransportDirectory,timeoutMs:120000});
const native={nativePolicy:nativeSettings.policy,nativeConsumer:createNativeV8Consumer(nativeSettings),
  close:()=>rmSync(nativeTransportDirectory,{recursive:true,force:true})};
const meter=await load('tools/semantic-v8-tokenizer-adapter.mjs');
const testPath='test/semantic-protocol-number-source-v8.test.js',testBytes=readFileSync(join(producer,testPath));
const cases=[
  {id:'number-abrupt-direct',body:'const o={valueOf:function(){throw 7;},toString:function(){throw 99;}};return Number(o);',value:7,operations:1},
  {id:'number-abrupt-nested',body:'const inner={valueOf:function(){throw 5;}};const outer={valueOf:function(){return Number(inner);}};return Number(outer);',value:5,operations:2}
].map(row=>{assert(testBytes.toString().includes(row.body),'Case must be retained in the frozen source suite');
  return {...row,fixture:{id:row.id,family:'number-source-abrupt',source:'"use strict";function run(){'+row.body+'}',
    entry:'run',args:[],fixture:{calls:[]},timeoutMs:30000}};});
mkdirSync(output);
const artifacts={},rows=[],report={schema:'semantic-v8-supplementary-regression/1',status:'running',
  startedAt:new Date().toISOString(),producerRevision,consumerRevision,pinsBefore:before,
  sourceSuite:{path:testPath,sha256:sha(testBytes)},nativePolicy:native.nativePolicy,
  tokenizerEvidence:meter.tokenizerEvidence,declared:cases.length,cases,
  scope:'Two new synchronous Number callback-abrupt source cases. Separate supplementary regression; not added to the frozen expansion, gallery or interoperability denominators.',
  nativeDeadlineMs:120000,optimizerSteps:0,modelExecution:'unmeasured',nativeServing:'unmeasured',defaultPromotion:'not-qualified',rows,artifacts};
const save=(name,value,compact=false)=>{const bytes=JSON.stringify(value,null,compact?undefined:2)+'\n';
  writeFileSync(join(output,name),bytes,{flag:'wx'});artifacts[name]=sha(bytes);return name;};
const progress=()=>writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
progress();
try{
  for(const item of cases){
    const row={id:item.id,source:'untested',native:'untested',cost:'untested',startedAt:new Date().toISOString()};rows.push(row);progress();
    const result=await verifyProtocolRegionTrainingCase(item.fixture);
    row.sourceResult=save(item.id+'.result.json',result);
    assert(result.exported,result.reason);
    row.source='passed';row.sourceArtifact=save(item.id+'.source.json',result.exported);
    const replay=RegionExecutionHarness.replay(result.exported),operations=replay.controller.protocol.numberConversions.operations;
    assert.deepEqual(replay.controller.completion,{kind:'throw',value:['num',item.value]});
    assert.equal(operations.length,item.operations);
    assert(operations.every(operation=>operation.phase==='abrupt'&&operation.primitive===null&&operation.result[1]===item.value));
    const admission=await admitRegionEvidence(result.exported,{nativePolicy:native.nativePolicy,nativeConsumer:native.nativeConsumer});
    row.nativeReceipt=save(item.id+'.native.json',admission.native);
    row.admittedArtifact=save(item.id+'.admitted.json',admission.exported);
    row.nativeInput=save(item.id+'.native-input.json',result.exported,true);
    assert.equal(artifacts[row.nativeInput],admission.native.sourceVerification.artifactSha256);
    row.native='passed';row.nativeChecks=admission.native.checks;row.nativeCounts=admission.native.counts;row.nativeFraming=admission.native.framing;
    const costs=await auditRegionServingCosts(result.exported,{tokenizer:meter.tokenizer,eosTokenId:meter.eosTokenId,maxContextTokens:1048576});
    row.costArtifact=save(item.id+'.costs.json',costs);row.cost='passed';row.flatTokens=costs.tokens;
    row.completion=replay.controller.completion;row.abruptOperations=operations.length;row.finishedAt=new Date().toISOString();progress();
    console.log(JSON.stringify({id:row.id,source:row.source,native:row.native,cost:row.cost}));
  }
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack??String(error);throw error;}
finally{
  native.close();await meter.tokenizer.close();
  report.finishedAt=new Date().toISOString();report.pinsAfter={producer:identity(producer),consumer:identity(consumer)};
  report.sourceQualified=rows.filter(row=>row.source==='passed').length;report.nativeAdmitted=rows.filter(row=>row.native==='passed').length;
  report.tokenMeasured=rows.filter(row=>row.cost==='passed').length;
  report.identityUnchanged=JSON.stringify(report.pinsAfter)===JSON.stringify(before);
  if(!report.identityUnchanged)report.status='failed';
  progress();
}
assert.equal(report.status,'passed');
