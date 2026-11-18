#!/usr/bin/env node
// Fresh local diagnostic for the canonical/teacher refusals in an immutable
// real-source campaign. It never copies an admission or fabricates a native
// receipt, and it leaves the original campaign untouched.
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {deserialize} from 'node:v8';
import {gzipSync,gunzipSync} from 'node:zlib';
import {atomicWrite,sha256,identityHash} from '../src/corpus/campaign-store.mjs';
import {trustedRealSourceCases} from '../src/corpus/trusted-source-candidates.mjs';
import {loadPinnedPairs,extractCanonicalCases} from '../src/corpus/owned-exercism.mjs';
import {runGenerationProcess} from '../src/corpus/generation-process.mjs';
import {admissionEnvironment} from '../src/training/admission-identity.js';

const {values}=parseArgs({options:{campaign:{type:'string'},out:{type:'string'}}});
if(!values.campaign||!values.out)throw new Error('Usage: recheck-real-source-refusals.mjs --campaign DIR --out NEW_DIR');
const root=fileURLToPath(new URL('..',import.meta.url)),campaign=resolve(values.campaign),out=resolve(values.out);
if(existsSync(out))throw new Error('Use a new output directory; historical evidence is immutable');
const manifestBytes=readFileSync(join(campaign,'manifest.json')),manifest=JSON.parse(manifestBytes);
const header=JSON.parse(readFileSync(join(campaign,'campaign.json')));
if(header.identityDigest!==identityHash(header.identity))throw new Error('Historical campaign identity changed');
const entries=new Map();let previous=null;
for(const line of readFileSync(join(campaign,'campaign.jsonl'),'utf8').split('\n').filter(Boolean)){
  const entry=JSON.parse(line),{entryDigest,...payload}=entry;
  if(entry.previous!==previous||entry.campaignDigest!==header.identityDigest||entryDigest!==identityHash(payload))
    throw new Error('Historical campaign log changed');
  previous=entryDigest;entries.set(entry.id,entry);
}
const readObject=ref=>{
  if(!/^objects\/(candidates|results)\/[0-9a-f]{64}\.json(?:\.gz)?$/.test(ref?.path??''))
    throw new Error('Invalid historical evidence path');
  const bytes=readFileSync(join(campaign,ref.path));
  if(bytes.length!==ref.bytes||sha256(bytes)!==ref.sha256)throw new Error('Historical evidence bytes changed');
  const raw=ref.encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:268435456}):bytes;
  if(raw.length!==ref.uncompressedBytes||sha256(raw)!==ref.contentSha256)throw new Error('Historical content changed');
  return JSON.parse(raw);
};
const writeObject=value=>{
  const raw=Buffer.from(JSON.stringify(value)+'\n'),bytes=gzipSync(raw,{level:6,mtime:0});
  const path='objects/'+sha256(raw)+'.json.gz';atomicWrite(join(out,path),bytes);
  return {path,sha256:sha256(bytes),contentSha256:sha256(raw),bytes:bytes.length,
    uncompressedBytes:raw.length,encoding:'gzip'};
};
const fresh=new Map(trustedRealSourceCases({root,streams:['exercism'],perFamily:100}).map(row=>[row.id,row]));
const canonical=new Map(loadPinnedPairs(root).flatMap(pair=>extractCanonicalCases(pair,{includeSuperseded:true}))
  .map(row=>[row.caseId,row]));
const producerRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const environment=admissionEnvironment(),environmentDigest=identityHash(environment);
const receipt={schema:'real-source-refusal-triage/1',scope:'fresh-local-verification-only',
  historical:{producerRevision:manifest.producerRevision,manifestSha256:sha256(manifestBytes),
    campaignIdentity:header.identityDigest,logHead:previous},producerRevision,environment,environmentDigest,
  nativeAdmission:false,optimizerSteps:0,learnedSuccess:null,completed:false,cases:[]};
mkdirSync(out,{recursive:true});
const save=()=>atomicWrite(join(out,'manifest.json'),JSON.stringify(receipt,null,2)+'\n');save();
for(const row of manifest.cases.filter(row=>['canonical_mismatch','teacher_failed'].includes(row.status))){
  const entry=entries.get(row.id);
  if(!entry||entry.status!==row.status)throw new Error('Historical manifest/log disagreement');
  const stored=readObject(entry.candidate),oldResult=readObject(entry.result);
  if(stored.fixtureEncoding!=='node-v8-serialized/base64')throw new Error('Unknown historical fixture encoding');
  const original=deserialize(Buffer.from(stored.fixtureBytes,'base64'));
  const detail={id:row.id,family:row.family,caseId:original.provenance.inputIndex,
    historicalStatus:row.status,historicalReason:oldResult.reason,
    historicalEvidence:entry.result,historicalCandidate:entry.candidate};
  let fixture=fresh.get(row.id);
  if(!fixture){
    const retired=canonical.get(detail.caseId);
    if(retired?.status!=='superseded_canonical_case')throw new Error('Current pinned candidate missing without canonical supersession');
    Object.assign(detail,{status:'superseded_canonical_case',replacedBy:retired.replacedBy,
      executed:false,reason:'Pinned canonical data explicitly reimplements this case'});
  }else{
    if(fixture.source!==original.source||fixture.originalReferenceSource!==original.originalReferenceSource)
      throw new Error('A source change needs a separately declared comparison');
    // The same pinned source retains its original frozen global component.
    // Input/expected bindings are rebuilt from the pinned canonical source.
    fixture={...fixture,seed:original.seed,splitIdentity:original.splitIdentity};
    const run=await runGenerationProcess({kind:'source',fixture,producerRevision},
      {outputDirectory:join(out,'workers'),timeoutMs:120000});
    const provenance=run.result.exported?.sidecar?.sourceProvenance?.upstream??run.result.failure?.original?.provenance;
    Object.assign(detail,{status:run.result.status,reason:run.result.reason??null,executed:true,
      canonicalCheck:provenance?.canonicalCheck??run.result.failure?.canonicalCheck??null,
      canonicalInputBinding:fixture.provenance.canonicalInputBinding,
      canonicalExpectedBinding:fixture.provenance.canonicalExpectedBinding,
      result:writeObject(run.result),durationMs:run.durationMs,peakRssBytes:run.peakRssBytes});
  }
  receipt.cases.push(detail);save();
  process.stdout.write(JSON.stringify({id:detail.id,before:detail.historicalStatus,after:detail.status})+'\n');
}
if(identityHash(admissionEnvironment())!==environmentDigest||
    execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==producerRevision)
  throw new Error('Producer changed during the diagnostic');
receipt.counts=Object.fromEntries([...new Set(receipt.cases.map(row=>row.status))]
  .map(status=>[status,receipt.cases.filter(row=>row.status===status).length]));
receipt.completed=true;save();
