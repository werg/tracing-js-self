import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [producerPath,outputPath,producerRevision,consumerRevision]=process.argv.slice(2);
if(!producerPath||!outputPath||!producerRevision||!consumerRevision)
  throw new Error('Usage: node qualify_iterable_bindings.mjs PRODUCER NEW_OUTPUT PRODUCER_SHA CONSUMER_SHA');
const producer=resolve(producerPath),output=resolve(outputPath),consumer=resolve(process.env.MEGATOKEN_ROOT);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const identity=root=>({revision:git(root,'rev-parse','HEAD'),tree:git(root,'rev-parse','HEAD^{tree}'),
  status:git(root,'status','--porcelain=v1','--untracked-files=all')});
const before={producer:identity(producer),consumer:identity(consumer)};
assert.equal(before.producer.revision,producerRevision);assert.equal(before.consumer.revision,consumerRevision);
assert.equal(before.producer.status,'');assert.equal(before.consumer.status,'');
const contractBytes=readFileSync(join(producer,'contracts/semantic-execution-v8.json'));
assert.deepEqual(JSON.parse(contractBytes),JSON.parse(readFileSync(join(consumer,'src/megatoken/data/contracts/semantic-execution-v8.json'))));
mkdirSync(output);
const contract=JSON.parse(contractBytes),sourcePolicy=JSON.parse(readFileSync(join(producer,'contracts/semantic-native-policy-v8.json')));
const policy={...sourcePolicy,consumerRevision,contractDigest:contract.digest,
  fixtureDigest:contract.fixtureDigest,interoperabilityDigest:contract.interoperabilityDigest};
const policyPath=join(output,'native-policy.json');writeFileSync(policyPath,JSON.stringify(policy,null,2)+'\n');
process.env.SEMANTIC_V8_NATIVE_POLICY=policyPath;
const load=path=>import(pathToFileURL(join(producer,path)));
const {verifyProtocolRegionTrainingCase}=await load('src/semantic/protocol-source-v8.js');
const {admitRegionEvidence}=await load('src/semantic/compiler-v8.js');
const {RegionExecutionHarness}=await load('src/semantic/region-harness.js');
const {auditRegionServingCosts}=await load('src/semantic/causal-lm-v8.js');
const {loadNativeV8Settings,createNativeV8Consumer}=await load('src/corpus/native-admission-v8.mjs');
const nativeTimeoutMs=300000,temporaryDirectory=join(output,'native-transport');
const settings=loadNativeV8Settings({megatoken:consumer,tokenizer:process.env.MEGATOKEN_TOKENIZER_JSON,
  python:process.env.MEGATOKEN_PYTHON,policyFile:policyPath,timeoutMs:nativeTimeoutMs,temporaryDirectory});
const native={nativePolicy:settings.policy,nativeConsumer:createNativeV8Consumer(settings),
  close:()=>rmSync(temporaryDirectory,{recursive:true,force:true})};
const meter=await load('tools/semantic-v8-tokenizer-adapter.mjs');
const testPath='test/semantic-protocol-iterable-binding-source-v8.test.js',testBytes=readFileSync(join(producer,testPath));
const {parse}=createRequire(join(producer,'package.json'))('acorn');
const tree=parse(testBytes.toString(),{ecmaVersion:'latest',sourceType:'module'});
const declaration=tree.body.flatMap(row=>row.type==='VariableDeclaration'?row.declarations:[]).find(row=>row.id.name==='cases');
assert(declaration,'Frozen source suite case declaration');
function literals(node){
  if(node.type==='ArrayExpression')return node.elements.map(literals);
  assert.equal(node.type,'Literal','Case data must consist only of literal arrays');return node.value;
}
const positives=literals(declaration.init).map(([id,body,expected])=>({id,body,expected,expectedSource:'passed'}));
assert.equal(positives.length,14);
const refusalTest=tree.body.find(node=>node.type==='ExpressionStatement'&&node.expression.type==='CallExpression'&&
  node.expression.callee.name==='test'&&node.expression.arguments[0].value===
  'nested patterns, assignment patterns and captured builtin methods retain explicit source refusals');
assert(refusalTest,'Frozen refusal test');
const refusalLoop=refusalTest.expression.arguments[1].body.body.find(node=>node.type==='ForOfStatement');
assert(refusalLoop,'Frozen refusal inventory');
const refusalBodies=literals(refusalLoop.right);
assert.equal(refusalBodies.length,3);
const refusalIds=['nested-binding-refusal','assignment-binding-refusal','string-builtin-binding-refusal'];
const extra=refusalBodies.map((body,index)=>({id:refusalIds[index],body,expectedSource:'unsupported'}));
const cases=[...positives,...extra].map(row=>{assert(testBytes.toString().includes(row.body),'Case must occur in the frozen source suite');
  return {...row,fixture:{id:row.id,family:'iterable-binding-source:'+row.id,
    source:'"use strict";function run(){'+row.body+'}',entry:'run',args:[],fixture:{calls:[]},timeoutMs:30000}};});
const artifacts={},rows=[],report={schema:'semantic-v8-supplementary-iterable-binding-regression/1',status:'running',
  startedAt:new Date().toISOString(),producerRevision,consumerRevision,pinsBefore:before,
  sourceSuite:{path:testPath,sha256:sha(testBytes)},sourcePolicy,
  nativePolicy:native.nativePolicy,externalPolicy:{file:'native-policy.json',sha256:sha(readFileSync(policyPath)),
    reason:'Bind the synchronized clean producer/consumer pair without modifying the committed producer policy or source files.'},
  contractBytesSha256:sha(contractBytes),tokenizerEvidence:meter.tokenizerEvidence,declared:cases.length,cases,
  scope:'Fourteen positive flat iterable-binding cases and three explicit source refusals from the declared focused suite. Supplementary only; frozen broad-population results retain their original producer/consumer pins and denominators.',
  nativeTimeoutMs,optimizerSteps:0,modelExecution:'unmeasured',nativeServing:'unmeasured',defaultPromotion:'not-qualified',rows,artifacts};
const save=(name,value,compact=false)=>{const bytes=JSON.stringify(value,null,compact?undefined:2)+'\n';
  writeFileSync(join(output,name),bytes,{flag:'wx'});artifacts[name]=sha(bytes);return name;};
const progress=()=>writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
progress();
try{
  for(const item of cases){
    const row={id:item.id,expectedSource:item.expectedSource,source:'untested',native:'untested',cost:'untested',startedAt:new Date().toISOString()};rows.push(row);progress();
    const result=await verifyProtocolRegionTrainingCase(item.fixture);
    row.sourceResult=save(item.id+'.result.json',result);
    if(item.expectedSource==='unsupported'){
      assert.equal(result.status,'unsupported');assert(!result.exported);
      row.source='unsupported';row.reason=result.reason;row.expectedRefusal=true;row.finishedAt=new Date().toISOString();progress();
      console.log(JSON.stringify({id:row.id,source:row.source,expectedRefusal:true}));continue;
    }
    assert(result.exported,result.reason);row.source='passed';row.sourceArtifact=save(item.id+'.source.json',result.exported);
    const replay=RegionExecutionHarness.replay(result.exported);
    assert.deepEqual(replay.controller.completion,{kind:'return',value:item.expected});
    const reference=result.exported.sidecar.sourceArtifact.sidecar.reference;
    assert.equal(reference.completionAudit.status,'agreed');
    if(!item.id.includes('array-')&&!item.id.includes('-array-'))assert.equal(reference.extensionAudit.status,'agreed');
    const observations=reference.observations.extensions?.find(value=>value.profile==='custom-iterator-observations/1')?.rows??[];
    if(item.id==='empty-pattern')assert.equal(observations.filter(value=>value.kind==='call'&&value.operation==='next').length,0);
    if(item.id==='elision')assert.equal(observations.filter(value=>value.kind==='read'&&value.operation==='value').length,1);
    if(item.id==='rest-exhaustion'||item.id.endsWith('-failure'))assert.equal(observations.filter(value=>value.operation==='return').length,0);
    row.observationRows=observations.length;row.protocolExtensions=result.exported.sidecar.protocolExtensions??[];
    const admission=await admitRegionEvidence(result.exported,{nativePolicy:native.nativePolicy,nativeConsumer:native.nativeConsumer});
    row.nativeReceipt=save(item.id+'.native.json',admission.native);row.admittedArtifact=save(item.id+'.admitted.json',admission.exported);
    row.nativeInput=save(item.id+'.native-input.json',result.exported,true);
    assert.equal(artifacts[row.nativeInput],admission.native.sourceVerification.artifactSha256);
    row.native='passed';row.nativeChecks=admission.native.checks;row.nativeCounts=admission.native.counts;row.nativeFraming=admission.native.framing;
    const costs=await auditRegionServingCosts(result.exported,{tokenizer:meter.tokenizer,eosTokenId:meter.eosTokenId,maxContextTokens:1048576});
    row.costArtifact=save(item.id+'.costs.json',costs);row.cost='passed';row.flatTokens=costs.tokens;
    row.completion=replay.controller.completion;row.finishedAt=new Date().toISOString();progress();
    console.log(JSON.stringify({id:row.id,source:row.source,native:row.native,cost:row.cost}));
  }
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack??String(error);throw error;}
finally{
  native.close();await meter.tokenizer.close();
  report.finishedAt=new Date().toISOString();report.pinsAfter={producer:identity(producer),consumer:identity(consumer)};
  report.sourceQualified=rows.filter(row=>row.source==='passed').length;report.nativeAdmitted=rows.filter(row=>row.native==='passed').length;
  report.expectedSourceRefusals=rows.filter(row=>row.expectedRefusal===true).length;report.tokenMeasured=rows.filter(row=>row.cost==='passed').length;
  report.identityUnchanged=JSON.stringify(report.pinsAfter)===JSON.stringify(before);if(!report.identityUnchanged)report.status='failed';progress();
}
assert.equal(report.status,'passed');
