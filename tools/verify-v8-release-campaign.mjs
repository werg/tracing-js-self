#!/usr/bin/env node
// Read the complete V8 qualification journal without resuming or repairing it.
// Integrity of retained observations is separate from fresh source/native admission.
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,dirname,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {CampaignStore,sha256} from '../src/corpus/campaign-store.mjs';
import {verifyV8TaskArtifactBinding,verifyV8RecordedAdmissionBinding} from '../src/corpus/release-task-binding-v8.mjs';

const HASH=/^[a-f0-9]{64}$/,REVISION=/^[a-f0-9]{40}$/;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
const ARTIFACT=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,399}$/;
const MAX_METADATA=64*1024*1024,MAX_OBJECT=256*1024*1024;
const MAX_FILES=100000,MAX_FILE_BYTES=512*1024*1024,MAX_TOTAL_BYTES=8*1024**3;
const fail=message=>{throw new Error('V8 release campaign: '+message);};
const require=(condition,message)=>{if(!condition)fail(message);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// These inputs have already crossed a JSON boundary. Keep this independent of
// the old program compiler; it is the same sorted-key JSON content encoding.
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){
    require(Number.isFinite(value)&&!Object.is(value,-0),'noncanonical JSON number');return value;
  }
  require(typeof value==='object','noncanonical JSON value');
  return Array.isArray(value)?value.map(canonical):
    Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
const contentDigest=value=>sha256(JSON.stringify(canonical(value)));
const identity=metadata=>[metadata.dev,metadata.ino,metadata.size,metadata.mtimeMs,metadata.ctimeMs];

function inputPath(root,name,{directory=false}={}){
  require(typeof name==='string'&&name&&name!=='.'&&!name.includes('\\')&&!name.includes('\0')&&
    !posix.isAbsolute(name)&&!name.split('/').includes('..')&&posix.normalize(name)===name,
  'noncanonical input path');
  let path=root;
  for(const part of name.split('/')){
    path=join(path,part);require(!lstatSync(path).isSymbolicLink(),'symbolic link input');
  }
  require(directory?lstatSync(path).isDirectory():lstatSync(path).isFile(),
    'input is not a regular '+(directory?'directory':'file'));
  return path;
}

function readJSON(root,name,maximum=MAX_METADATA){
  const path=inputPath(root,name),before=lstatSync(path);
  require(before.size<=maximum,'JSON exceeds its declared byte bound');
  const bytes=readFileSync(path),after=lstatSync(path);
  require(bytes.length===before.size&&isDeepStrictEqual(identity(before),identity(after)),
    'JSON changed while reading: '+name);
  return {value:JSON.parse(bytes),sha256:sha256(bytes),bytes:bytes.length};
}

async function receipt(root,name){
  const path=inputPath(root,name),before=lstatSync(path),hash=createHash('sha256');let bytes=0;
  require(before.size<=MAX_FILE_BYTES,'input file exceeds its declared byte bound');
  for await(const block of createReadStream(path)){bytes+=block.length;hash.update(block);
    require(bytes<=MAX_FILE_BYTES,'input file grew beyond its byte bound');}
  require(bytes===before.size&&isDeepStrictEqual(identity(before),identity(lstatSync(path))),
    'input changed while hashing: '+name);
  return {path:name,bytes,sha256:hash.digest('hex')};
}

function allFiles(root){
  const files=[];let directories=0,total=0;
  function visit(prefix){
    require(++directories<=MAX_FILES,'too many input directories');
    for(const entry of readdirSync(prefix?inputPath(root,prefix,{directory:true}):root,{withFileTypes:true})){
      const name=prefix?prefix+'/'+entry.name:entry.name;
      require(!entry.isSymbolicLink(),'symbolic link input');
      if(entry.isDirectory())visit(name);
      else{
        require(entry.isFile(),'special input file');
        const size=lstatSync(inputPath(root,name)).size;total+=size;files.push(name);
        require(size<=MAX_FILE_BYTES&&files.length<=MAX_FILES&&total<=MAX_TOTAL_BYTES,
          'campaign inventory exceeds its declared bounds');
      }
    }
  }
  visit('');return files.sort();
}

function artifactMap(value){
  require(record(value),'artifact map is missing');
  for(const [name,digest] of Object.entries(value))
    require(ARTIFACT.test(name)&&name!=='report.json'&&HASH.test(digest),'unsafe artifact identity');
  return value;
}

export async function verifyV8ReleaseCampaign(directory){
  const root=resolve(directory);
  for(let path=root;;path=dirname(path)){
    require(!lstatSync(path).isSymbolicLink(),'symbolic link input ancestor');
    if(dirname(path)===path)break;
  }
  require(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink(),'campaign root is not a regular directory');
  // Check every descendant before CampaignStore can follow any object reference.
  const names=allFiles(root);
  const header=readJSON(root,'progress/campaign.json'),population=readJSON(root,'population.json'),
    reportInput=readJSON(root,'report.json'),logPath=inputPath(root,'progress/campaign.jsonl');
  inputPath(root,'progress/.campaign.lock');
  require(lstatSync(logPath).size<=MAX_METADATA,'journal exceeds its declared byte bound');
  const initialLog=await receipt(root,'progress/campaign.jsonl');
  const report=reportInput.value,inventory=population.value,authority=header.value.identity;
  require(record(authority)&&authority.schema==='semantic-v8-qualification-progress/1',
    'unsupported qualification authority');
  require(record(inventory)&&inventory.schema==='semantic-v8-qualification-population/1'&&
    Array.isArray(inventory.tasks)&&Number.isSafeInteger(inventory.declared)&&inventory.declared>0&&
    inventory.tasks.length===inventory.declared,'invalid complete population');
  const {digest:populationDigest,...populationBody}=inventory;
  require(HASH.test(populationDigest)&&contentDigest(populationBody)===populationDigest&&
    populationDigest===authority.populationDigest,'population digest differs from journal authority');
  require(record(report)&&report.schema==='semantic-v8-qualification/1'&&Array.isArray(report.rows)&&
    report.rows.length===inventory.declared,'report omits declared population members');
  require(REVISION.test(authority.producerRevision)&&report.producerRevision===authority.producerRevision&&
    inventory.producerRevision===authority.producerRevision,'producer revision differs');
  for(const key of ['contractDigest','fixtureDigest','interoperabilityDigest'])
    require(HASH.test(authority[key])&&report[key]===authority[key],'contract identity differs: '+key);
  for(const key of ['population','inputs','declared','selectedCaseIds','populationDigest'])
    require(isDeepStrictEqual(report[key],key==='populationDigest'?populationDigest:inventory[key]),
      'report and population differ: '+key);
  require(report.preparationOnly===authority.prepareOnly&&
    isDeepStrictEqual(report.nativePolicy,authority.nativePolicy)&&
    report.workers===authority.workers&&isDeepStrictEqual(report.workerBounds,authority.bounds)&&
    report.nativeTimeoutMs===authority.nativeTimeoutMs,'report changed frozen execution settings');
  require(typeof authority.prepareOnly==='boolean'&&(authority.prepareOnly?authority.nativePolicy===null:
    record(authority.nativePolicy)&&authority.nativePolicy.schema==='semantic-native-policy/8'&&
    authority.nativePolicy.consumerRepository==='werg/megatoken'&&REVISION.test(authority.nativePolicy.consumerRevision)&&
    ['contractDigest','fixtureDigest','interoperabilityDigest'].every(key=>authority.nativePolicy[key]===authority[key])&&
    HASH.test(authority.nativePolicy.tokenizerIdentity)&&HASH.test(authority.nativePolicy.tokenizerSha256)),
  'native policy is absent or differs from the declared V8 pair');
  require(report.optimizerSteps===0&&report.model==='untested'&&report.defaultPromotion==='not-qualified',
    'source qualification cannot claim optimizer/model/default acceptance');
  const ids=inventory.tasks.map(task=>{
    require(record(task)&&task.traceVersion===8&&['source','module'].includes(task.kind)&&
      task.producerRevision===authority.producerRevision&&record(task.fixture)&&ID.test(task.fixture.id),
      'invalid frozen V8 source task');return task.fixture.id;
  });
  require(new Set(ids).size===ids.length,'duplicate population member');
  const selected=inventory.selectedCaseIds;
  require(Array.isArray(selected)&&selected.length>0&&new Set(selected).size===selected.length&&
    isDeepStrictEqual(selected,ids.filter(id=>selected.includes(id))),'invalid or reordered source selection');
  require(isDeepStrictEqual(report.rows.map(row=>row?.id),ids),'report reordered or substituted a population member');
  const reportArtifacts=artifactMap(report.artifacts),globals=new Set(['population.json']);
  for(const [field,name] of [['supportCohortArtifact','support-cohort.json'],['familyRegistryArtifact','family-registry.json']]){
    if(report[field]!==undefined){require(report[field]===name,'unexpected population artifact');globals.add(name);}
  }
  for(const key of ['supportCohortDigest','registryDigest','sourceCounts'])
    require(isDeepStrictEqual(report[key],inventory[key]),'support population identity differs: '+key);
  require(reportArtifacts['population.json']===population.sha256,'population artifact bytes differ');
  const interpretedArtifacts=new Map();
  const readArtifact=(name,expected)=>{
    const input=readJSON(root,name,MAX_OBJECT);
    // Bind semantic comparisons to these exact read bytes, then recheck them
    // during the final inventory. A shared journal lock is not byte authority.
    require(HASH.test(expected)&&input.sha256===expected,
      'completed artifact bytes changed before interpretation: '+name);
    require(!interpretedArtifacts.has(name)||interpretedArtifacts.get(name)===input.sha256,
      'completed artifact changed between interpretations: '+name);
    interpretedArtifacts.set(name,input.sha256);return input.value;
  };
  const registry=inventory.registryDigest===undefined?null:
    readArtifact('family-registry.json',reportArtifacts['family-registry.json']);
  require(registry===null||globals.has('family-registry.json')&&registry.digest===inventory.registryDigest,
    'original task family registry differs from the frozen population');
  const store=new CampaignStore(join(root,'progress'),authority,{readOnly:true,maxObjectBytes:MAX_OBJECT,recoverTornLog:false});
  try{
    require(store.identityDigest===report.progressDigest&&store.latest.size===ids.length,
      'report does not cover the complete committed journal');
    const requiredArtifacts=new Map(),attempts=[],referencedObjects=new Set(),cases=[],
      taskBindings=new Map(),nativeBindings=new Map();
    const retain=ref=>{
      if(!ref)return;
      inputPath(root,'progress/'+ref.path);referencedObjects.add('progress/'+ref.path);
      if(ref.format){
        const envelope=JSON.parse(store.readRawObject(ref));
        for(const item of envelope.registryReferences)retain(item.reference);
      }
    };
    const retainArtifacts=(value,label)=>{
      for(const [name,digest] of Object.entries(artifactMap(value))){
        require(!requiredArtifacts.has(name)||requiredArtifacts.get(name)===digest,
          'historical artifact was overwritten: '+name);
        requiredArtifacts.set(name,digest);inputPath(root,name);
      }
      return label;
    };
    for(const entry of store.entries){
      require(ids.includes(entry.id),'journal contains an undeclared candidate');
      const task=store.readObject(entry.candidate),result=store.readObject(entry.result);
      require(isDeepStrictEqual(task,inventory.tasks[ids.indexOf(entry.id)]),
        'journal candidate differs from frozen population: '+entry.id);
      require(record(result.row)&&result.row.id===entry.id&&result.row.status===entry.status&&
        result.row.durationMs===entry.durationMs&&result.row.peakRssBytes===entry.peakRssBytes&&
        !entry.public&&!entry.private,'committed result or resource accounting changed');
      retainArtifacts(result.artifacts,entry.id);
      if(result.row.source==='passed'){
        const name=result.row.sourceArtifact;
        require(name===entry.id+'.source.json'&&Object.hasOwn(result.artifacts,name),
          'source-qualified attempt has no original source artifact');
        // A hash-linked journal can consistently name the wrong safe artifact.
        // Bind the encoded task's request before fresh source/native replay.
        const sourceArtifact=readArtifact(name,result.artifacts[name]),
          binding=verifyV8TaskArtifactBinding(task,sourceArtifact,{registry,expectedSourceId:result.row.sourceId});
        require(result.row.family===task.fixture.family,'reported family differs from original task');
        if(registry!==null)require(result.row.sourceId===binding.membership.sourceId&&
          result.row.split===binding.membership.split,'reported source membership differs from original task');
        taskBindings.set(entry.entryDigest,binding);
        if(result.row.native==='passed'){
          const admitted=entry.id+'.admitted.json',native=entry.id+'.native.json';
          require(Object.hasOwn(result.artifacts,admitted)&&Object.hasOwn(result.artifacts,native),
            'native-qualified attempt has no original admitted copy or native receipt');
          const receipt=readArtifact(native,result.artifacts[native]);
          require(isDeepStrictEqual(receipt,result.row.nativeReceipt),'recorded native receipt differs from its journal');
          nativeBindings.set(entry.entryDigest,verifyV8RecordedAdmissionBinding(sourceArtifact,
            readArtifact(admitted,result.artifacts[admitted]),receipt,authority.nativePolicy,authority.producerRevision));
        }
      }
      for(const ref of [entry.candidate,entry.result,...(task.inputs??[]).flatMap(input=>
        [input.source,input.input,input.fixture])])retain(ref);
      attempts.push({id:entry.id,status:entry.status,attempt:entry.attempt,entryDigest:entry.entryDigest,
        previous:entry.previous,candidateDigest:entry.candidateDigest,candidate:entry.candidate,result:entry.result,
        durationMs:entry.durationMs,peakRssBytes:entry.peakRssBytes,artifacts:result.artifacts});
    }
    const latestArtifacts=new Map();
    for(const [index,row] of report.rows.entries()){
      const entry=store.latest.get(row.id),result=store.readObject(entry.result),isSelected=selected.includes(row.id);
      require(isDeepStrictEqual(result.row,row)&&entry.candidateDigest===store.candidateDigest(inventory.tasks[index]),
        'report differs from the latest completed result: '+row.id);
      require(typeof row.source==='string'&&typeof row.native==='string'&&
        /^[a-z][a-z0-9_-]{0,127}$/.test(row.source)&&/^[a-z][a-z0-9_-]{0,127}$/.test(row.native),
        'missing or malformed source/native disposition');
      require(isSelected||row.status==='untested'&&row.source==='untested'&&row.native==='untested',
        'unselected source gained qualification');
      for(const [name,digest] of Object.entries(result.artifacts)){
        require(!latestArtifacts.has(name)||latestArtifacts.get(name)===digest,'ambiguous current artifact');
        latestArtifacts.set(name,digest);
      }
      const item={id:row.id,selected:isSelected,status:row.status,source:row.source,native:row.native,
        attempt:entry.attempt,entryDigest:entry.entryDigest,candidateDigest:entry.candidateDigest,
        artifacts:result.artifacts};
      if(row.source==='passed'){
        require(row.sourceArtifact===row.id+'.source.json'&&Object.hasOwn(result.artifacts,row.sourceArtifact),
          'source-qualified result has no bound original source artifact');
        item.sourceArtifact=row.sourceArtifact;
        item.taskArtifactBinding=taskBindings.get(entry.entryDigest);
      }
      if(row.native==='passed'){
        require(!authority.prepareOnly&&isSelected&&row.source==='passed'&&row.status==='admitted'&&
          Object.hasOwn(result.artifacts,row.id+'.admitted.json')&&
          Object.hasOwn(result.artifacts,row.id+'.native.json'),'admitted result has no exact native artifacts');
        require(isDeepStrictEqual(readArtifact(row.id+'.native.json',result.artifacts[row.id+'.native.json']),row.nativeReceipt),
          'native artifact differs from its committed result: '+row.id);
        item.admittedArtifact=row.id+'.admitted.json';item.nativeArtifact=row.id+'.native.json';
        item.nativeRecordBinding=nativeBindings.get(entry.entryDigest);
      }
      cases.push(item);
    }
    const expectedReported=new Map([...latestArtifacts,...[...globals].map(name=>[name,reportArtifacts[name]])]);
    require(isDeepStrictEqual([...expectedReported.keys()].sort(),Object.keys(reportArtifacts).sort())&&
      [...expectedReported].every(([name,digest])=>HASH.test(digest)&&reportArtifacts[name]===digest),
      'report added or omitted a committed artifact');
    for(const name of globals)requiredArtifacts.set(name,reportArtifacts[name]);
    const files=[];
    for(const name of names)files.push(await receipt(root,name));
    require(isDeepStrictEqual(names,allFiles(root)),'campaign membership changed while checking');
    const byPath=new Map(files.map(row=>[row.path,row]));
    for(const [name,digest] of requiredArtifacts)
      require(byPath.get(name)?.sha256===digest,'completed artifact bytes changed: '+name);
    for(const [name,digest] of interpretedArtifacts)
      require(byPath.get(name)?.sha256===digest,'interpreted artifact changed while checking: '+name);
    for(const [name,initial] of [['population.json',population],['report.json',reportInput],
      ['progress/campaign.json',header],['progress/campaign.jsonl',initialLog]])
      require(byPath.get(name)?.sha256===initial.sha256,'authority changed while checking: '+name);
    const sourceQualified=cases.filter(row=>row.source==='passed').length,
      nativeAdmitted=cases.filter(row=>row.native==='passed').length;
    require(report.sourceQualified===sourceQualified&&report.nativeAdmitted===nativeAdmitted,
      'reported source/native totals differ');
    const counts=rows=>Object.fromEntries([...new Set(rows.map(row=>row.status))].sort().map(status=>
      [status,rows.filter(row=>row.status===status).length]));
    const authorityFiles=new Set(['report.json','population.json','progress/campaign.json',
      'progress/campaign.jsonl','progress/.campaign.lock',...requiredArtifacts.keys(),...referencedObjects]);
    const body={schema:'semantic-v8-release-campaign-snapshot/1',status:'verified',
      producerRevision:authority.producerRevision,contractDigest:authority.contractDigest,
      fixtureDigest:authority.fixtureDigest,interoperabilityDigest:authority.interoperabilityDigest,
      nativePolicy:authority.nativePolicy,preparationOnly:authority.prepareOnly,
      populationDigest,progressDigest:store.identityDigest,journalHead:store.previous,
      declared:ids.length,selectedCaseIds:selected,sourceQualified,nativeAdmitted,
      counts:counts(cases),attemptCounts:counts(attempts),cases,attempts,files,
      auxiliaryFiles:files.filter(row=>!authorityFiles.has(row.path)).map(row=>row.path),
      taskArtifactBindings:{checkedAttempts:taskBindings.size,checkedCurrentSources:sourceQualified,
        checkedNativeRecords:nativeBindings.size,
        authority:'Original encoded task request and frozen family registry; checked before source/native replay'},
      limits:{metadataBytes:MAX_METADATA,objectBytes:MAX_OBJECT,fileBytes:MAX_FILE_BYTES,
        totalBytes:MAX_TOTAL_BYTES,files:MAX_FILES},
      optimizerUpdates:0,freshSourceReplays:0,freshNativeAdmissions:0,learnedSuccess:null,
      scope:'Complete retained V8 qualification population, every committed attempt and exact bytes; fresh source/native and model/release qualification remain separate'};
    return {...body,identityDigest:contentDigest(body)};
  }finally{store.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  require(process.argv.length===3||process.argv.length===5&&process.argv[3]==='--output',
    'usage: node tools/verify-v8-release-campaign.mjs DIRECTORY [--output NEW_FILE]');
  const result=await verifyV8ReleaseCampaign(process.argv[2]),bytes=JSON.stringify(result,null,2)+'\n';
  if(process.argv[4]){
    const output=resolve(process.argv[4]),inside=relative(resolve(process.argv[2]),output);
    require(inside.startsWith('..'+posix.sep)||posix.isAbsolute(inside),'snapshot output must be outside campaign');
    writeFileSync(output,bytes,{flag:'wx',mode:0o600});
  }else process.stdout.write(bytes);
}
