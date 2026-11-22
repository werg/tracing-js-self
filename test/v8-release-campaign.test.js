import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,appendFileSync,copyFileSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {openQualificationProgress} from '../src/corpus/qualification-progress.mjs';
import {CampaignStore} from '../src/corpus/campaign-store.mjs';
import {verifyV8ReleaseCampaign} from '../tools/verify-v8-release-campaign.mjs';
import {buildRegionFamilyRegistry,regionSplitIdentity,regionDatasetBinding} from '../src/semantic/family-registry-v8.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),REVISION='a'.repeat(40);
const CONTRACT='1'.repeat(64),FIXTURE='2'.repeat(64),INTEROP='3'.repeat(64);
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');

function fixture(t,{overwriteHistory=false,admitUnselected=false,mismatchedNativeFile=false,wrongTaskSource=false,
  nativeMutation=null,admittedMutation=null,withRegistry=false}={}){
  const parent=mkdtempSync(join(tmpdir(),'v8-release-campaign-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const directory=join(parent,'campaign'),ids=['accepted','refused','unselected'];
  const tasks=ids.map(id=>({kind:'source',traceVersion:8,producerRevision:REVISION,
    fixture:{id,family:'controlled:'+id,source:'function run(){return 1;}',entry:'run',
      argsGraph:{schema:'owned-graph/1',roots:[],objects:[]}}}));
  const registry=withRegistry?buildRegionFamilyRegistry(tasks.map(task=>({...task.fixture,ancestors:[]})),{seed:17}):null;
  const inventory={schema:'semantic-v8-qualification-population/1',producerRevision:REVISION,
    population:'controlled-release-test',inputs:'all',declared:3,selectedCaseIds:ids.slice(0,2),tasks,
    ...(registry?{registryDigest:registry.digest}:{})};
  const populationDigest=hashAlgorithmData(inventory),nativePolicy={schema:'semantic-native-policy/8',
    consumerRepository:'werg/megatoken',consumerRevision:'b'.repeat(40),contractDigest:CONTRACT,
    fixtureDigest:FIXTURE,interoperabilityDigest:INTEROP,tokenizerIdentity:'4'.repeat(64),tokenizerSha256:'5'.repeat(64)};
  const authority={schema:'semantic-v8-qualification-progress/1',producerRevision:REVISION,populationDigest,
    contractDigest:CONTRACT,fixtureDigest:FIXTURE,interoperabilityDigest:INTEROP,
    prepareOnly:false,nativePolicy,workers:1,bounds:{timeoutMs:1000,memoryMb:128},nativeTimeoutMs:1000,
    environment:{node:process.version,controlledFixture:true}};
  const progress=openQualificationProgress(directory,authority),artifacts={};
  const save=(name,value)=>{artifacts[name]=progress.save(name,value);};
  save('population.json',{...inventory,digest:populationDigest});
  if(registry)save('family-registry.json',registry);
  const historical=overwriteHistory?'accepted.source.json':'accepted.first-failure.json';
  progress.save(historical,{status:'failed',reason:'original failed attempt'});
  progress.complete('accepted',tasks[0],{id:'accepted',status:'failed',source:'failed',native:'untested',
    durationMs:1,peakRssBytes:null},[historical]);
  const rows=ids.map((id,index)=>{
    const admitted=index===0||index===2&&admitUnselected;
    const status=admitted?'admitted':index===1?'unsupported':'untested';
    const row={id,family:tasks[index].fixture.family,status,source:admitted?'passed':status,native:admitted?'passed':'untested',
      durationMs:admitted?2:0,peakRssBytes:null};
    const names=[];
    if(admitted){
      row.sourceArtifact=id+'.source.json';
      const source={public:{schema:'semantic-execution/8'},contexts:[],qualifiedRealSource:false,
        sidecar:{family:tasks[index].fixture.family,sourceFamily:tasks[index].fixture.family,
          sourceArtifact:{sidecar:{schema:'semantic-supervision/8',producerRevision:REVISION,
            sourceFamily:tasks[index].fixture.family,ancestorIds:[],taskId:id,
            license:'repository-fixture',trustTier:'repository-fixture',
            projectionOptions:{sourceLineage:tasks[index].fixture.family,semanticRegions:false,localStateCompaction:false},
            executionLimits:{maxSteps:100000,timeoutMs:10000,maxGenerated:16384,maxOperators:8},
            seeds:{generation:null,input:null,schedule:null,optimizer:null,guestRng:null,split:17},
            referenceInput:{source:wrongTaskSource&&id==='accepted'?'function run(){return 2;}':tasks[index].fixture.source,entry:'run',
              inputGraph:tasks[index].fixture.argsGraph,fixture:{calls:[],settlementOrder:null},randomSeed:null}}}}};
      if(registry){
        const identity=regionSplitIdentity(registry,{...tasks[index].fixture,ancestors:[]});
        Object.assign(source.sidecar,{splitIdentity:identity,split:identity.split,sourceComponent:identity.componentId,
          familyRegistryDigest:registry.digest,datasetBinding:regionDatasetBinding(source,identity)});
        Object.assign(row,{sourceId:id,split:identity.split});
      }
      row.nativeReceipt={schema:'semantic-native-admission/8',qualifiedRealSource:false,
        publicDigest:hashAlgorithmData(source.public),contextsDigest:hashAlgorithmData(source.contexts),
        sourceArtifactDigest:hashAlgorithmData(source.sidecar.sourceArtifact),
        datasetBindingDigest:source.sidecar.datasetBinding?hashAlgorithmData(source.sidecar.datasetBinding):null,
        consumerRevision:nativePolicy.consumerRevision,contractDigest:CONTRACT,fixtureDigest:FIXTURE,
        interoperabilityDigest:INTEROP,tokenizer:{status:'passed',identity:nativePolicy.tokenizerIdentity,sha256:nativePolicy.tokenizerSha256},
        admitted:true,optimizerSteps:0,learningClaim:null,sourceVerification:{schema:'semantic-native-source-recheck/1',
          producerRevision:REVISION,producerTreeClean:true,sourceValidated:true,projectionValidated:true,replayValidated:true,
          artifactSha256:hashAlgorithmData(JSON.stringify(source)+'\n'),publicDigest:hashAlgorithmData(source.public),
          contextDigest:hashAlgorithmData(source.contexts),sourceArtifactDigest:hashAlgorithmData(source.sidecar.sourceArtifact)}};
      if(nativeMutation)nativeMutation(row.nativeReceipt);
      const admittedSource=structuredClone({...source,sidecar:{...source.sidecar,admission:'admitted',nativeAdmission:row.nativeReceipt}});
      if(admittedMutation)admittedMutation(admittedSource);
      for(const kind of ['source','admitted','native']){
        const name=id+'.'+kind+'.json';names.push(name);
        save(name,kind==='native'?{...row.nativeReceipt,...(mismatchedNativeFile?{changed:true}:{})}:
          kind==='source'?source:admittedSource);
      }
    }else{const name=id+'.result.json';names.push(name);save(name,{status});}
    progress.complete(id,tasks[index],row,names);return row;
  });
  const report={schema:'semantic-v8-qualification/1',producerRevision:REVISION,
    population:inventory.population,inputs:'all',populationDigest,declared:3,selectedCaseIds:inventory.selectedCaseIds,
    ...(registry?{registryDigest:registry.digest,familyRegistryArtifact:'family-registry.json'}:{}),
    contractDigest:CONTRACT,fixtureDigest:FIXTURE,interoperabilityDigest:INTEROP,nativePolicy,
    progressDigest:progress.digest,workers:1,workerBounds:authority.bounds,nativeTimeoutMs:1000,
    preparationOnly:false,rows,artifacts,sourceQualified:rows.filter(row=>row.source==='passed').length,
    nativeAdmitted:rows.filter(row=>row.native==='passed').length,model:'untested',optimizerSteps:0,
    defaultPromotion:'not-qualified',scope:'Controlled journal fixture; no real source/native execution'};
  progress.save('report.json',report);progress.close();
  return {parent,directory,authority,tasks,report};
}

test('V8 release snapshot retains complete population, selection, failures and every committed attempt',async t=>{
  const {directory}=fixture(t),before=readFileSync(join(directory,'progress/campaign.jsonl'));
  const result=await verifyV8ReleaseCampaign(directory);
  assert.equal(result.declared,3);assert.deepEqual(result.selectedCaseIds,['accepted','refused']);
  assert.equal(result.sourceQualified,1);assert.equal(result.nativeAdmitted,1);
  assert.deepEqual(result.counts,{admitted:1,unsupported:1,untested:1});
  assert.deepEqual(result.attemptCounts,{admitted:1,failed:1,unsupported:1,untested:1});
  assert.equal(result.attempts.length,4);assert.equal(result.cases[0].attempt,2);
  assert.equal(result.cases[2].selected,false);
  assert.equal(result.cases[0].admittedArtifact,'accepted.admitted.json');
  assert.equal(result.freshSourceReplays,0);assert.equal(result.freshNativeAdmissions,0);
  assert.equal(result.optimizerUpdates,0);assert.equal(result.learnedSuccess,null);
  assert.ok(result.files.some(row=>row.path==='accepted.first-failure.json'));
  assert.deepEqual(readFileSync(join(directory,'progress/campaign.jsonl')),before);
  const {identityDigest,...body}=result;
  assert.equal(identityDigest,hashAlgorithmData(body));
});

test('V8 release snapshot refuses changed, omitted and forged report authority',async t=>{
  for(const mutation of ['row','count','omitted','revision','selected','contract','candidate'])await t.test(mutation,async t=>{
    const {directory}=fixture(t),path=join(directory,'report.json'),report=read(path);
    if(mutation==='row')report.rows[0].durationMs+=1;
    if(mutation==='count')report.nativeAdmitted+=1;
    if(mutation==='omitted')report.rows.pop();
    if(mutation==='revision')report.producerRevision='c'.repeat(40);
    if(mutation==='selected')report.selectedCaseIds=['accepted'];
    if(mutation==='contract')report.contractDigest='f'.repeat(64);
    if(mutation==='candidate'){
      const populationPath=join(directory,'population.json'),population=read(populationPath);
      population.tasks[0].fixture.source='function run(){return 2;}';write(populationPath,population);
    }
    write(path,report);
    await assert.rejects(verifyV8ReleaseCampaign(directory),/V8 release campaign:/);
  });
});

test('V8 release snapshot refuses changed completed bytes and missing original failures',async t=>{
  for(const mutation of ['changed','changed-source','missing'])await t.test(mutation,async t=>{
    const {directory}=fixture(t);
    if(mutation==='changed')appendFileSync(join(directory,'accepted.admitted.json'),' ');
    else if(mutation==='changed-source')appendFileSync(join(directory,'accepted.source.json'),' ');
    else rmSync(join(directory,'accepted.first-failure.json'));
    await assert.rejects(verifyV8ReleaseCampaign(directory),/artifact bytes changed|ENOENT/);
  });
});

test('V8 release snapshot binds every interpreted artifact to its original read bytes',async t=>{
  for(const name of ['accepted.source.json','accepted.admitted.json','accepted.native.json','family-registry.json'])
    await t.test(name,async t=>{
      const {directory}=fixture(t,{withRegistry:name==='family-registry.json'});
      const before=await verifyV8ReleaseCampaign(directory);
      assert.equal(before.nativeAdmitted,1);
      const path=join(directory,name),value=read(path);
      appendFileSync(path,' ');
      assert.deepEqual(read(path),value,'JSON meaning is unchanged; the recorded bytes are different');
      await assert.rejects(verifyV8ReleaseCampaign(directory),error=>
        error.message==='V8 release campaign: completed artifact bytes changed before interpretation: '+name);
    });
});

test('V8 release snapshot refuses torn and reordered logs without repairing their bytes',async t=>{
  for(const mutation of ['torn','reordered'])await t.test(mutation,async t=>{
    const {directory}=fixture(t),path=join(directory,'progress/campaign.jsonl');
    if(mutation==='torn')appendFileSync(path,'{"unfinished":');
    else{const lines=readFileSync(path,'utf8').trimEnd().split('\n');
      [lines[0],lines[1]]=[lines[1],lines[0]];writeFileSync(path,lines.join('\n')+'\n');}
    const before=readFileSync(path);
    await assert.rejects(verifyV8ReleaseCampaign(directory),/incomplete log tail|Corrupt or reordered/);
    assert.deepEqual(readFileSync(path),before);
    assert.equal(readdirSync(join(directory,'progress')).includes('recovery'),false);
  });
});

test('V8 release snapshot verifies journal CAS bytes and refuses an active writer',async t=>{
  for(const mutation of ['cas','writer'])await t.test(mutation,async t=>{
    const {directory,authority}=fixture(t);
    if(mutation==='cas'){
      const first=JSON.parse(readFileSync(join(directory,'progress/campaign.jsonl'),'utf8').split('\n')[0]);
      appendFileSync(join(directory,'progress',first.result.path),'changed');
      await assert.rejects(verifyV8ReleaseCampaign(directory));
    }else{
      const writer=new CampaignStore(join(directory,'progress'),authority,{resume:true});
      try{await assert.rejects(verifyV8ReleaseCampaign(directory),/another writer/);}
      finally{writer.close();}
    }
  });
});

test('V8 release snapshot refuses a coherent journal that qualifies an unselected source',async t=>{
  const {directory}=fixture(t,{admitUnselected:true});
  await assert.rejects(verifyV8ReleaseCampaign(directory),/unselected source gained qualification/);
});

test('V8 release snapshot cannot hide overwritten historical artifact bytes',async t=>{
  const {directory}=fixture(t,{overwriteHistory:true});
  await assert.rejects(verifyV8ReleaseCampaign(directory),/historical artifact was overwritten/);
});

test('V8 release snapshot binds native artifact bytes to the exact committed receipt',async t=>{
  const {directory}=fixture(t,{mismatchedNativeFile:true});
  await assert.rejects(verifyV8ReleaseCampaign(directory),/native.*differs/);
});

test('V8 release snapshot refuses a coherently resealed journal returning another source for the original task',async t=>{
  const {directory}=fixture(t,{wrongTaskSource:true}),before=readFileSync(join(directory,'progress/campaign.jsonl'));
  await assert.rejects(verifyV8ReleaseCampaign(directory),/V8 release task binding: source, entry, argument graph/);
  assert.deepEqual(readFileSync(join(directory,'progress/campaign.jsonl')),before);
});

test('V8 release snapshot refuses a resealed admitted copy from another source',async t=>{
  const {directory}=fixture(t,{admittedMutation:artifact=>{
    artifact.sidecar.sourceArtifact.sidecar.referenceInput.source='function run(){return 900;}';}});
  await assert.rejects(verifyV8ReleaseCampaign(directory),/recorded admitted artifact differs/);
});

test('V8 release snapshot binds historical native receipt claims to exact original input and policy',async t=>{
  const mutations={
    public:receipt=>{receipt.publicDigest='9'.repeat(64);},
    source:receipt=>{receipt.sourceArtifactDigest='9'.repeat(64);},
    dataset:receipt=>{receipt.datasetBindingDigest='9'.repeat(64);},
    'source-input-bytes':receipt=>{receipt.sourceVerification.artifactSha256='9'.repeat(64);},
    producer:receipt=>{receipt.sourceVerification.producerRevision='9'.repeat(40);},
    consumer:receipt=>{receipt.consumerRevision='9'.repeat(40);},
    tokenizer:receipt=>{receipt.tokenizer.sha256='9'.repeat(64);},
    'validation-boolean':receipt=>{receipt.sourceVerification.sourceValidated=1;},
    'unrequested-teacher':receipt=>{receipt.orchestrationTranscriptDigest='9'.repeat(64);},
  };
  for(const [name,nativeMutation] of Object.entries(mutations))await t.test(name,async t=>{
    const {directory}=fixture(t,{nativeMutation}),before=readFileSync(join(directory,'progress/campaign.jsonl'));
    await assert.rejects(verifyV8ReleaseCampaign(directory),/recorded native/);
    assert.deepEqual(readFileSync(join(directory,'progress/campaign.jsonl')),before);
  });
});

test('uncommitted orphan files remain explicit auxiliary bytes and never gain admission',async t=>{
  const {directory}=fixture(t),name='orphan.admitted.json';
  write(join(directory,name),{status:'admitted',claimed:true});
  const result=await verifyV8ReleaseCampaign(directory);
  assert.equal(result.nativeAdmitted,1);assert.equal(result.declared,3);
  assert.ok(result.auxiliaryFiles.includes(name));
  const reportPath=join(directory,'report.json'),report=read(reportPath);
  report.artifacts[name]=result.files.find(row=>row.path===name).sha256;write(reportPath,report);
  await assert.rejects(verifyV8ReleaseCampaign(directory),/added or omitted a committed artifact/);
});

test('V8 release snapshot refuses symbolic-link input before reading campaign objects',async t=>{
  const {directory,parent}=fixture(t),outside=join(parent,'outside.json');write(outside,{private:true});
  symlinkSync(outside,join(directory,'extra.json'));
  await assert.rejects(verifyV8ReleaseCampaign(directory),/symbolic link input/);
});

test('V8 release snapshot refuses a symbolic-link ancestor of its root',async t=>{
  const {directory,parent}=fixture(t),link=join(parent,'alias');symlinkSync(parent,link);
  await assert.rejects(verifyV8ReleaseCampaign(join(link,'campaign')),/symbolic link input ancestor/);
  assert.equal(read(join(directory,'report.json')).declared,3);
});

test('V8 release campaign verification runs with every semantic compiler and old release tool absent',async t=>{
  const {directory,parent}=fixture(t),isolated=join(parent,'isolated');
  for(const file of ['tools/verify-v8-release-campaign.mjs','src/corpus/campaign-store.mjs',
    'src/corpus/release-task-binding-v8.mjs','src/host/graph-codec.js','src/values.js',
    'src/property-keys.js','src/training/data-graph-contract.js','src/host/proxy-check-node.js','package.json']){
    const target=join(isolated,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(ROOT,file),target);
  }
  const stdout=execFileSync(process.execPath,[join(isolated,'tools/verify-v8-release-campaign.mjs'),directory],
    {cwd:isolated,encoding:'utf8',timeout:30000,maxBuffer:MAX_BUFFER});
  const result=JSON.parse(stdout);assert.equal(result.status,'verified');assert.equal(result.declared,3);
  assert.equal(result.nativeAdmitted,1);assert.equal(result.freshNativeAdmissions,0);
  assert.equal(readdirSync(join(isolated,'src')).includes('semantic'),false);
});

const MAX_BUFFER=8*1024*1024;
