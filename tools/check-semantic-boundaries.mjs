#!/usr/bin/env node
// Requalify the resumption audit's semantic boundaries through actual v5 gates.
// Local checks, native admissions and deliberate refusals have separate counts.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {loadNativeSettings,createNativeConsumer} from '../src/corpus/native-admission-client.mjs';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {admissionEnvironment} from '../src/training/admission-identity.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(key==='--local'){flags.set(key,true);continue;}
  if(!['--out','--megatoken','--python','--tokenizer','--native-policy'].includes(key)||
    !process.argv[i+1]||process.argv[i+1].startsWith('--'))
    throw new Error('Usage: check-semantic-boundaries.mjs --out report.json (--local | '+
      '--megatoken PATH --python PATH --tokenizer PATH --native-policy PATH)');
  if(flags.has(key))throw new Error('Duplicate flag '+key);
  flags.set(key,process.argv[++i]);
}
if(!flags.has('--out'))throw new Error('--out is required');
const out=resolve(flags.get('--out')),local=flags.has('--local');
if(local&&['--megatoken','--tokenizer','--native-policy','--python'].some(key=>flags.has(key)))
  throw new Error('--local cannot be combined with native consumer configuration');
if(!local&&!['--megatoken','--tokenizer','--native-policy'].every(key=>flags.has(key)))
  throw new Error('Native qualification requires exact consumer, tokenizer and policy paths');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const producerRevision=git(['rev-parse','HEAD']);
const trackedChanges=git(['status','--porcelain','--untracked-files=no']);
if(!local&&trackedChanges)throw new Error('Native qualification requires a clean pinned producer checkout');
const native=local?null:loadNativeSettings({megatoken:flags.get('--megatoken'),
  python:flags.get('--python')??'python3',tokenizer:flags.get('--tokenizer'),
  policyFile:flags.get('--native-policy'),temporaryDirectory:resolve(root,'.cache/semantic-boundary-native')});
const nativeConsumer=createNativeConsumer(native);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const noCalls={calls:[]};
const rejectedCall={operation:'demo.readNumber',arguments:['bad'],status:'rejected',result:'missing'};
const cases=[
  {id:'slice-undefined',body:'return [1,2,3].slice(0,undefined);'},
  {id:'fill-undefined',body:'const a=[1,2,3];a.fill(9,0,undefined);return a;'},
  {id:'copy-within-undefined',body:'const a=[1,2,3];a.copyWithin(0,1,undefined);return a;'},
  {id:'parameter-outer',code:'const x=7;function run(a=x){var x=3;return a;}'},
  {id:'parameter-closure',code:'const x=7;function run(a=()=>x){var x=3;return a();}'},
  {id:'parameter-tdz',code:'const b=7;function run(a=b,b=3){return a;}'},
  {id:'parameter-typeof-tdz',code:'function run(a=typeof b,b=3){return a;}'},
  {id:'async-helper',code:'async function helper(){return 7;}async function run(){return typeof helper();}'},
  {id:'accessor-update',body:'let x=0;const o={};'+
    'Object.defineProperty(o,"v",{get:()=>1,set:v=>{x=v;},configurable:true});'+
    'Object.defineProperty(o,"v",{get:()=>2});o.v=3;return [o.v,x];'},
  {id:'accessor-idempotent',body:'const o={};const get=()=>1;'+
    'Object.defineProperty(o,"v",{get});Object.defineProperty(o,"v",{get});return o.v;'},
  {id:'primitive-throw',body:'throw 7;'},
  {id:'declared-error',body:'throw new TypeError("declared");'},
  {id:'synchronous-host-throw',body:'return host.readNumber("bad");',fixture:{calls:[rejectedCall]}},
  {id:'async-host-throw-cleanup',code:'async function run(){try{return host.readNumber("bad");}'+
    'finally{host.store("cleanup",1);}}',fixture:{calls:[rejectedCall,
      {operation:'demo.store',arguments:['cleanup',1]}]}},
  {id:'create-descriptors-refused',body:'return Object.create(null,{foo:{value:7}}).foo;',
    refusal:/Object.create property descriptors are outside the bounded profile/},
  {id:'array-accessor-refused',body:'const a=[];Object.defineProperty(a,"0",{get:()=>7});return a.length;',
    refusal:/Array index accessor descriptors are outside the bounded profile/},
  {id:'descriptor-getter-refused',body:'const d={};'+
    'Object.defineProperty(d,"get",{get:()=>{throw new TypeError("blocked");}});'+
    'try{Object.defineProperty({},"x",d);}catch(e){return e.name;}',
    refusal:/Accessor descriptor fields are outside the bounded profile/},
  {id:'callback-failure-refused',body:'queueMicrotask(()=>{throw 7;});return 3;',
    refusalStatus:'reference_callback_failure'},
  {id:'unhandled-rejection-refused',body:'Promise.reject(9);return 3;',
    refusalStatus:'reference_unhandled_rejection'}
];
const report={schema:'semantic-boundary-qualification/1',status:'running',
  producerRevision,trackedProducerClean:!trackedChanges,environment:admissionEnvironment(),
  runnerSha256:hash(readFileSync(fileURLToPath(import.meta.url),'utf8')),
  nativePolicy:native?.policy??null,startedAt:new Date().toISOString(),
  counts:{attempted:0,locallyVerified:0,admitted:0,qualifiedRefusals:0,failures:0},
  cases:[],optimizerSteps:0,learnedSuccess:null};
mkdirSync(dirname(out),{recursive:true});
const save=()=>atomicWrite(out,JSON.stringify(report,null,2)+'\n');
save();
try{
  for(const fixture of cases){
    const source='"use strict";'+(fixture.code??'function run(){'+fixture.body+'}');
    const input={source,entry:'run',args:[],fixture:fixture.fixture??noCalls,
      family:'semantic-boundary-'+fixture.id,producerRevision,
      ...(native?{nativeConsumer,nativePolicy:native.policy}:{})};
    const result=await verifyEffectfulTrainingCase(input);
    const refused=!!(fixture.refusal||fixture.refusalStatus);
    const row={id:fixture.id,source,sourceSha256:hash(source),args:[],fixture:input.fixture,
      fixtureSha256:hash(input.fixture),
      expected:refused?'refused':native?'admitted':'locally_verified',status:result.status,
      category:result.category??null,reason:result.reason??null,passed:false};
    report.counts.attempted++;
    if(refused){
      row.passed=!['admitted','locally_verified'].includes(result.status)&&
        (fixture.refusalStatus?result.status===fixture.refusalStatus:fixture.refusal.test(result.reason??''));
      if(row.passed)report.counts.qualifiedRefusals++;
      row.failureEvidenceDigest=result.failure?.failureDigest??null;
    }else if(result.status===row.expected){
      row.identityDigest=result.exported.sidecar.identityDigest;
      row.publicDigest=hash(result.exported.public);
      row.referenceOutcome=result.exported.sidecar.reference.outcome;
      row.sourceRecheck=await recheckEffectfulAdmission(result.exported,{requireAdmitted:!!native,
        expectedIdentityDigest:row.identityDigest});
      row.nativeAdmission=result.exported.sidecar.nativeAdmission??null;
      row.passed=row.sourceRecheck.sourceValidated&&row.sourceRecheck.replayValidated&&
        row.sourceRecheck.journalValidated&&row.sourceRecheck.effectsValidated;
      if(row.passed)report.counts[native?'admitted':'locallyVerified']++;
    }
    if(!row.passed)report.counts.failures++;
    report.cases.push(row);save();
    console.log(fixture.id+': '+result.status+(row.passed?'':' [FAILED]'));
  }
  report.status=report.counts.failures?'failed':'passed';
  report.completedAt=new Date().toISOString();save();
  if(report.counts.failures)process.exitCode=1;
}catch(error){
  report.status='failed';report.error={name:error.name,message:String(error.message)};
  report.completedAt=new Date().toISOString();save();throw error;
}
