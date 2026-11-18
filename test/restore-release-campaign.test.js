import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {replayRestoredCampaign,originalProducer} from '../tools/restore-release-campaign.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
let temporary,producer,revision,CampaignStore,verifyReleaseCampaign,verifyEffectfulTrainingCase,bindNativeAdmission,hostOperationContract;
const priorTZ=process.env.TZ;
test.before(async()=>{
  process.env.TZ='UTC';
  temporary=mkdtempSync(join(tmpdir(),'release-restore-'));
  producer=join(temporary,'producer');revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  // A real immutable original checkout keeps this test independent of local
  // uncommitted implementation work and prevents relabeling a newer producer.
  execFileSync('git',['clone','--quiet','--shared','--no-checkout',root,producer]);
  execFileSync('git',['-C',producer,'checkout','--quiet','--detach',revision]);
  // The unit matrix deliberately runs several Node versions. Pin this
  // isolated fixture's actual runtime before generating its original evidence;
  // production locks and previously generated archives remain untouched.
  const lockPath=join(producer,'profiles/release-environment.lock.json');
  const lock={...JSON.parse(readFileSync(lockPath)),node:process.versions.node,v8:process.versions.v8,
    npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,
    python:execFileSync('python3',['-c','import platform;print(platform.python_version())'],{encoding:'utf8'}).trim()};
  const locked=JSON.stringify(lock,null,2)+'\n';
  if(readFileSync(lockPath,'utf8')!==locked){
    writeFileSync(lockPath,locked);
    execFileSync('git',['-C',producer,'add','--','profiles/release-environment.lock.json']);
    execFileSync('git',['-C',producer,'-c','user.name=Restore Test','-c','user.email=restore@example.invalid',
      'commit','--quiet','-m','Pin isolated restore fixture runtime']);
    revision=execFileSync('git',['-C',producer,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  }
  symlinkSync(realpathSync(join(root,'node_modules')),join(producer,'node_modules'),'dir');
  const load=name=>import(pathToFileURL(join(producer,name)).href);
  ({CampaignStore}=await load('src/corpus/campaign-store.mjs'));
  ({verifyReleaseCampaign}=await load('tools/verify-release-campaign.mjs'));
  ({verifyEffectfulTrainingCase,bindNativeAdmission}=await load('src/training/effectful-admit.js'));
  ({hostOperationContract}=await load('src/host/operations.js'));
});
test.after(()=>{rmSync(temporary,{recursive:true,force:true});
  if(priorTZ===undefined)delete process.env.TZ;else process.env.TZ=priorTZ;});

function restoreFailure(error,output){
  const details=[error.message,error.stderr?.toString(),error.stdout?.toString()];
  for(const name of ['restore.json','checks/original-source-replay.stderr.log',
    'checks/original-source-replay.stdout.log','checks/replay/attempts.jsonl']){
    try{details.push(name+'\n'+readFileSync(join(output,name),'utf8'));}
    catch(readError){if(readError.code!=='ENOENT')details.push(name+': '+readError.message);}
  }
  return new Error(details.filter(Boolean).join('\n'),{cause:error});
}

async function fixture({corruptAdmission=false}={}){
  const directory=mkdtempSync(join(temporary,'fixture-')),corpus=join(directory,'corpus');
  mkdirSync(corpus);
  const policy=JSON.parse(readFileSync(join(producer,'contracts/native-admission-policy-v5.json')));
  const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(x){return x+1;}',
    entry:'run',args:[3],fixture:{calls:[]},family:'restore-regression',producerRevision:revision,nativePolicy:policy});
  assert.equal(result.status,'locally_verified',result.reason);
  const local=result.exported,admitted=structuredClone(local);
  const contract=JSON.parse(readFileSync(join(producer,'contracts/semantic-harness-v5.json')));
  // Shape-only original admission fixture: this exercises receipt preservation
  // and source replay. No native consumer/model execution is claimed.
  bindNativeAdmission(admitted,{schema:'semantic-native-admission/4',componentGate:'native-consumer-only',admitted:true,
    episodeDigest:sha(admitted.public),contractDigest:sha(JSON.stringify(hostOperationContract(),null,2)+'\n'),
    schemaDigest:contract.digest,fixtureDigest:contract.fixtureDigest,
    lossMaskValidated:true,visibilityValidated:true,fragmentationValidated:true,optimizerSteps:0,
    generatedTokens:10,observedTokens:10,...policy},policy);
  if(corruptAdmission)admitted.sidecar.nativeBinding.identityDigest='0'.repeat(64);
  const store=new CampaignStore(corpus,{producerRevision:revision}),cases=new Map();
  function record(id,status,document=null){
    const candidate={id,family:'restore-regression'};
    const details=document?{split:document.sidecar.split,episodeDigest:sha(document.public),
      identityDigest:document.sidecar.identityDigest,metrics:{},difficulty:{},
      sourceCluster:document.sidecar.splitIdentity.componentId}:null;
    const entry=store.record(id,candidate,document?{status,exported:document,campaignSummary:details}:
      {status,reason:'Original refused disposition must remain refused'});
    cases.set(id,{id,family:candidate.family,status,candidateDigest:entry.candidateDigest,
      durationMs:entry.durationMs,peakRssBytes:entry.peakRssBytes,...(document?{...details,
        representation:document.sidecar.representation,publicShard:entry.public,privateEvidence:entry.private}:
        {reason:'Original refused disposition must remain refused'})});
  }
  record('superseded','locally_verified',local);record('superseded','unsupported');
  record('admitted','admitted',admitted);record('local','locally_verified',local);record('refused','unsupported');
  const manifest={schema:'semantic-corpus-manifest/4',producerRevision:revision,cases:[...cases.values()],
    campaign:{identityDigest:store.identityDigest,completed:cases.size},
    counts:{attempted:4,admitted:1,locally_verified:1,unsupported:2}};
  store.close();writeFileSync(join(corpus,'manifest.json'),JSON.stringify(manifest));
  const verified=await verifyReleaseCampaign(corpus);
  const release={schema:'semantic-private-release/1',producerRevision:revision,
    campaignManifestSha256:verified.manifestSha256,attempted:verified.attempted,counts:verified.counts};
  writeFileSync(join(directory,'release-manifest.json'),JSON.stringify(release));
  return {directory,corpus,manifest,release};
}

test('original recheck covers superseded positives and preserves every non-admission',async()=>{
  const original=await fixture(),logBefore=readFileSync(join(original.corpus,'campaign.jsonl'));
  const output=join(original.directory,'checks');
  const report=await replayRestoredCampaign({tracerRoot:producer,releaseRoot:original.directory,
    producerRevision:revision,output});
  assert.equal(report.status,'verified');assert.equal(report.attemptedCandidates,4);assert.equal(report.attempts,5);
  assert.equal(report.positiveAttempts,3);assert.equal(report.originalAdmittedAttempts,1);
  assert.equal(report.originalLocallyVerifiedAttempts,2);assert.equal(report.replayVerified,3);
  assert.equal(report.preservedNonpositiveAttempts,2);assert.equal(report.nativeRequalification,'untested');
  assert.equal(report.admissionChanged,false);assert.equal(report.freshMachineQualification,false);
  const rows=readFileSync(join(output,'attempts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].latest,false);assert.equal(rows[0].source.sourceValidated,true);
  assert(rows.filter(row=>row.originalDisposition==='unsupported').every(row=>row.status==='preserved-without-admission'&&!row.source));
  assert.deepEqual(readFileSync(join(original.corpus,'campaign.jsonl')),logBefore);
});

test('a changed original admission is retained as a failed replay without relabeling it',async()=>{
  const original=await fixture({corruptAdmission:true}),output=join(original.directory,'checks');
  const report=await replayRestoredCampaign({tracerRoot:producer,releaseRoot:original.directory,
    producerRevision:revision,output});
  assert.equal(report.status,'failed');assert.equal(report.replayFailed,1);assert.equal(report.replayVerified,2);
  assert.equal(report.originalAdmittedAttempts,1);assert.equal(report.preservedNonpositiveAttempts,2);
  const rows=readFileSync(join(output,'attempts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.match(rows.find(row=>row.id==='admitted').reason,/bind|identity/i);
  assert.equal(JSON.parse(readFileSync(join(original.corpus,'manifest.json'))).cases.find(row=>row.id==='admitted').status,'admitted');
});

test('wrong revision, dirty producer and missing original refusal are hard failures',async()=>{
  assert.throws(()=>originalProducer(producer,'b'.repeat(40)),/exact original producer/);
  const path=join(producer,'package.json'),before=readFileSync(path);
  try{writeFileSync(path,Buffer.concat([before,Buffer.from('\n')]));
    assert.throws(()=>originalProducer(producer,revision),/exact original producer/);
  }finally{writeFileSync(path,before);}
  const original=await fixture();original.manifest.cases.pop();original.manifest.counts.unsupported--;
  original.manifest.counts.attempted--;original.manifest.campaign.completed--;
  writeFileSync(join(original.corpus,'manifest.json'),JSON.stringify(original.manifest));
  original.release.campaignManifestSha256=sha(readFileSync(join(original.corpus,'manifest.json')));
  writeFileSync(join(original.directory,'release-manifest.json'),JSON.stringify(original.release));
  await assert.rejects(replayRestoredCampaign({tracerRoot:producer,releaseRoot:original.directory,
    producerRevision:revision,output:join(original.directory,'checks')}),/complete campaign/);
});

test('archive drill extracts to a new tree, runs the original producer, and preserves source-only limits',async()=>{
  const original=await fixture(),archive=join(temporary,'full-release.tar.gz');
  const code=`import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('release',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root,producer,archive=map(Path,sys.argv[2:])
locks={'locks/environment.json':'profiles/release-environment.lock.json','locks/native-policy.json':'contracts/native-admission-policy-v5.json','locks/requirements.lock':'tools/native-consumer/requirements.lock','locks/producer-package-lock.json':'package-lock.json','locks/oracle-package-lock.json':'tools/spec-oracle/package-lock.json'}
rows,sources=m.inventory({'corpus':root/'corpus',**{name:producer/path for name,path in locks.items()}})
payload=json.loads((root/'release-manifest.json').read_text());payload['files']=rows
m.write_archive(archive,payload,sources)
`;
  execFileSync('python3',['-c',code,join(root,'tools/package-semantic-release.py'),original.directory,producer,archive]);
  const rejectedOutput=join(temporary,'rejected-before-extraction');
  assert.throws(()=>{
    try{execFileSync('python3',[join(root,'tools/restore-semantic-release.py'),'--archive',archive,
      '--archive-sha256','0'.repeat(64),'--tracer-root',producer,'--out',rejectedOutput],{encoding:'utf8',stdio:'pipe'});}
    catch(error){throw restoreFailure(error,rejectedOutput);}
  },/Archive differs from the expected SHA-256/);
  const output=join(temporary,'whole-drill');
  try{execFileSync('python3',[join(root,'tools/restore-semantic-release.py'),'--archive',archive,
    '--archive-sha256',sha(readFileSync(archive)),'--tracer-root',producer,'--out',output],
    {encoding:'utf8',timeout:120000,maxBuffer:1024*1024,stdio:'pipe'});
  }catch(error){throw restoreFailure(error,output);}
  const report=JSON.parse(readFileSync(join(output,'restore.json')));
  assert.equal(report.status,'verified');assert.equal(report.producer.revision,revision);
  assert.equal(report.replay.replayVerified,3);assert.equal(report.nativeRequalification,'untested');
  assert.equal(report.freshMachineQualification,false);assert.equal(report.preparedData,'inventory-only');
  assert.deepEqual(readFileSync(join(output,'release/corpus/campaign.jsonl')),readFileSync(join(original.corpus,'campaign.jsonl')));
  assert.throws(()=>execFileSync('python3',[join(root,'tools/restore-semantic-release.py'),'--archive',archive,
    '--archive-sha256',sha(readFileSync(archive)),'--tracer-root',producer,'--out',output],{stdio:'pipe'}),/new with an existing parent/);
});
