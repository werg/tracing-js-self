#!/usr/bin/env node
// Fresh, explicitly selected regression qualification. This does not rewrite
// an earlier campaign or claim the selected cases measure a whole corpus.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {trustedRealSourceCases} from '../src/corpus/trusted-source-candidates.mjs';
import {runGenerationProcess,encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {loadNativeSettings} from '../src/corpus/native-admission-client.mjs';
import {atomicWrite} from '../src/corpus/campaign-store.mjs';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {admissionEnvironment} from '../src/training/admission-identity.js';
import {recheckEffectfulAdmission} from '../src/training/effectful-admit.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flags=new Map(),valueFlags=new Set(['--out','--cases','--per-family','--megatoken','--python','--tokenizer','--native-policy']);
for(let index=2;index<process.argv.length;index++){
  const key=process.argv[index];
  if(flags.has(key)||key!=='--local'&&!valueFlags.has(key))throw new Error('Unknown or repeated option '+key);
  if(key==='--local'){flags.set(key,true);continue;}
  const value=process.argv[++index];
  if(!value||value.startsWith('--'))throw new Error('Missing option value '+key);
  flags.set(key,value);
}
if(!flags.has('--out')||!flags.has('--cases'))
  throw new Error('Usage: check-real-source-cases.mjs --out NEW_DIRECTORY --cases ID,ID [--per-family N] '+
    '(--local | --megatoken DIR --python PYTHON --tokenizer FILE --native-policy FILE)');
const perFamily=Number(flags.get('--per-family')??2),selected=flags.get('--cases').split(',');
if(!Number.isSafeInteger(perFamily)||perFamily<1||perFamily>100||!selected.length||
  selected.length>256||new Set(selected).size!==selected.length)
  throw new Error('Select unique real-source IDs and a per-family bound of 1..100');
const catalog=trustedRealSourceCases({root,perFamily});
if(selected.some(id=>!catalog.some(row=>row.id===id)))throw new Error('Unknown selected real-source ID');
const fixtures=selected.map(id=>catalog.find(row=>row.id===id));
const local=flags.has('--local'),nativeKeys=['--megatoken','--python','--tokenizer','--native-policy'];
if(local&&nativeKeys.some(key=>flags.has(key)))throw new Error('--local cannot use native consumer options');
if(!local&&!['--megatoken','--tokenizer','--native-policy'].every(key=>flags.has(key)))
  throw new Error('Native qualification requires the exact consumer, tokenizer, and policy');
const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const producerRevision=git(['rev-parse','HEAD']),trackedProducerClean=!git(['status','--porcelain','--untracked-files=no']);
if(!local&&!trackedProducerClean)throw new Error('Native qualification requires a clean producer checkout');
const out=resolve(flags.get('--out'));
if(existsSync(out))throw new Error('Qualification directories are immutable; choose a new destination');
const native=local?null:loadNativeSettings({megatoken:flags.get('--megatoken'),
  python:flags.get('--python')??'python3',tokenizer:flags.get('--tokenizer'),policyFile:flags.get('--native-policy'),
  temporaryDirectory:join(out,'.native')});
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
mkdirSync(join(out,'cases'),{recursive:true});
const report={schema:'selected-real-source-qualification/1',status:'running',producerRevision,trackedProducerClean,
  runnerSha256:sha(readFileSync(fileURLToPath(import.meta.url))),environment:admissionEnvironment(),
  nativePolicy:native?.policy??null,selection:{kind:'explicit-regression-ids',perFamily,ids:selected,
    selected:fixtures.length,available:catalog.length,wholeCorpus:false},
  counts:{attempted:0,admitted:0,locallyVerified:0,failed:0},cases:[],optimizerSteps:0,learnedSuccess:null};
const save=()=>atomicWrite(join(out,'report.json'),json(report));
save();
try{
  for(const fixture of fixtures){
    const run=await runGenerationProcess({kind:'source',fixture,producerRevision,native},
      {outputDirectory:join(out,'.workers'),timeoutMs:120000,memoryMb:768});
    const {result}=run,expected=local?'locally_verified':'admitted';
    let sourceRecheck=null;
    if(result.status===expected)sourceRecheck=await recheckEffectfulAdmission(result.exported,
      {requireAdmitted:!local,expectedIdentityDigest:result.exported.sidecar.identityDigest});
    const passed=result.status===expected&&sourceRecheck?.sourceValidated&&sourceRecheck?.replayValidated&&
      sourceRecheck?.journalValidated&&sourceRecheck?.effectsValidated;
    const evidence=gzipSync(Buffer.from(json({task:encodeGenerationTask({kind:'source',fixture,producerRevision}),
      result,sourceRecheck})),{mtime:0});
    const evidencePath='cases/'+fixture.id+'.json.gz';
    writeFileSync(join(out,evidencePath),evidence,{flag:'wx'});
    const provenance=fixture.provenance,sidecar=result.exported?.sidecar;
    report.cases.push({id:fixture.id,family:fixture.family,status:result.status,passed:!!passed,
      reason:result.reason??null,durationMs:run.durationMs,peakRssBytes:run.peakRssBytes,
      inputGraph:encodeNativeGraph(fixture.args),upstream:provenance.upstream,
      canonical:provenance.canonical??null,canonicalInput:provenance.canonicalInput??null,
      canonicalNotice:provenance.canonicalNotice?{...provenance.canonicalNotice,text:undefined}:null,
      canonicalArgumentBinding:provenance.canonicalArgumentBinding??null,
      canonicalExpected:provenance.canonicalExpected??null,canonicalExpectedBinding:provenance.canonicalExpectedBinding??null,
      originalSourceSha256:provenance.originalSourceSha256,transformedSourceSha256:provenance.transformedSourceSha256,
      license:provenance.license,noticePath:provenance.noticePath,
      noticeSha256:typeof provenance.notice==='string'?sha(provenance.notice):null,
      sourceRecheck,originalSourceCheck:sidecar?.sourceProvenance?.upstream?.originalSourceCheck??null,
      identityDigest:sidecar?.identityDigest??null,nativeAdmission:sidecar?.nativeAdmission??null,
      evidence:{path:evidencePath,bytes:evidence.length,sha256:sha(evidence)}});
    report.counts.attempted++;
    report.counts[passed?(local?'locallyVerified':'admitted'):'failed']++;
    save();console.log(fixture.id+': '+result.status+(passed?'':' [FAILED]'));
  }
  report.status=report.counts.failed?'failed':'passed';save();
  if(report.counts.failed)process.exitCode=1;
}catch(error){
  report.status='failed';report.error={name:error.name,message:String(error.message)};save();throw error;
}
