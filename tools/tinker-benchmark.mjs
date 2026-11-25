#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {generatedCandidates,repositoryCandidates,censusCandidates,assignFrozenSplits,splitDiagnosticInputs,
  challengeCandidates,datasetCounts,readCandidateJsonl,sha256,BENCHMARK_SCHEMA} from '../src/training/tinker-benchmark.js';
import {prepareTinkerTask,readableMessagesFromJournal} from '../src/training/tinker-execution.js';
import {verifyFuzzCase,aggregateVerification,failureCategory,validateFuzzResumeRecord} from '../src/training/tinker-verification.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const {values,positionals}=parseArgs({allowPositionals:true,options:{
  seed:{type:'string',default:'17'},jobs:{type:'string',default:'4'},count:{type:'string',default:'10000'},
  limit:{type:'string'},'per-family':{type:'string',default:'4'},'output-dir':{type:'string'},
  input:{type:'string'},resume:{type:'boolean',default:false},'no-upstream':{type:'boolean',default:false},help:{type:'boolean',short:'h'},
}});
const command=positionals[0],number=(name,min,max)=>{const n=Number(values[name]);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid --'+name);return n;};
if(values.help||!command){console.log(`Usage: node tools/tinker-benchmark.mjs <build|census|fuzz> [options]
  build  --output-dir training/fixtures/expanded [--seed 17] [--jobs 4]
         Creates reverified main, familiar-input and composition challenge datasets,
         a frozen evaluation manifest and full admission/refusal census.
  census --output-dir runs/tinker-census [--per-family 2] [--input tasks-or-trajectories.jsonl]
         Rechecks every candidate from the declared repository inventory or input file.
  fuzz   --output-dir runs/tinker-fuzz [--count 10000] [--seed 17] [--jobs 4] [--resume]
         Tests actual owned/native executions, independent boundary checks, and
         observable corruptions. Saves minimized reproductions on failure.
  --limit N explicitly limits build/census coverage and is recorded in evidence.
  --no-upstream builds authored sources only. No command contacts a model service.`);process.exit(0);}
if(positionals.length!==1||!['build','census','fuzz'].includes(command))throw Error('Expected build, census or fuzz');
if(command==='fuzz'&&(values.limit!==undefined||values.input||values['no-upstream']))throw Error('Fuzz uses --count; --limit, --input and --no-upstream are not applicable');
if(command!=='fuzz'&&values.resume)throw Error('--resume applies only to fuzz');
if(command!=='census'&&values.input)throw Error('--input applies only to census');
const seed=number('seed',0,0xffffffff),jobs=number('jobs',1,8),count=number('count',1,1000000),perFamily=number('per-family',1,12);
const limit=values.limit===undefined?null:number('limit',1,1000000);
const output=resolve(values['output-dir']??(command==='build'?'training/fixtures/expanded':'runs/tinker-'+command));
mkdirSync(output,{recursive:true});
const json=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
const jsonl=(name,rows)=>writeFileSync(join(output,name),rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''));
const digestFile=path=>sha256(readFileSync(path));

function implementationIdentity(){
  const paths=[];
  function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(/\.(?:js|mjs|json|py)$/.test(entry.name))paths.push(path);}}
  for(const directory of ['src','tools'])walk(join(root,directory));
  for(const name of ['package.json','package-lock.json'])if(existsSync(join(root,name)))paths.push(join(root,name));
  return {schema:'tinker-local-verification-identity/1',sha256:sha256(paths.map(path=>[relative(root,path),digestFile(path)])),files:paths.length,node:process.version};
}
const identity=implementationIdentity(),started=new Date().toISOString();
async function pool(rows,work,onResult=()=>{}){
  const results=new Array(rows.length);let next=0,done=0;
  await Promise.all(Array.from({length:Math.min(jobs,rows.length)},async()=>{while(next<rows.length){const index=next++,result=await work(rows[index],index);results[index]=result;done++;onResult(result,index);if(done%100===0)process.stderr.write(command+': '+done+'/'+rows.length+'\n');}}));
  return results;
}
const taskBinding=task=>({id:task.id,family:task.family,sourceSha256:sha256(task.source??''),taskSha256:sha256(task),split:task.split??null,
  features:task.metadata?.features??[],tier:task.metadata?.tier??null,template:task.metadata?.template??task.family,
  lineage:task.metadata?.lineage??[],sourceOrigin:task.metadata?.sourceOrigin??null,agentTaskSuccessVerified:false});

async function qualify(task){
  const record=taskBinding(task),before=performance.now();
  if(!task.source||!task.family||!task.id)return {...record,status:'missing-inputs',reason:'Complete source, family and task ID required'};
  if(task.preflightFailure)return {...record,status:'refused',category:task.preflightFailure.status,reason:task.preflightFailure.reason};
  try{
    const prepared=await prepareTinkerTask(task),messages=readableMessagesFromJournal(prepared.bundle,prepared);
    return {...record,status:'admitted',sourceVerified:true,exceptionProfile:'declared-error/name-message/1',
      elapsedMs:Math.round(performance.now()-before),externalCalls:prepared.fixture.calls.length,
      externalOperations:prepared.fixture.calls.map(c=>c.operation),
      observationPattern:prepared.fixture.calls.map(c=>(c.status??'fulfilled')+':'+c.operation),
      traceCharacters:messages.filter(m=>m.role==='assistant').reduce((n,m)=>n+m.content.length,0),
      completeKind:prepared.outcome.kind,task:prepared.task};
  }catch(error){return {...record,status:'refused',category:failureCategory(error),reason:String(error.message),elapsedMs:Math.round(performance.now()-before)};}
}
function censusSummary(records){
  const statuses={},refusals={},byOrigin={},byFeature={};
  for(const record of records){statuses[record.status]=(statuses[record.status]??0)+1;
    if(record.status!=='admitted')refusals[record.category??record.status]=(refusals[record.category??record.status]??0)+1;
    const origin=byOrigin[record.sourceOrigin??'unspecified']??={candidates:0,admitted:0};origin.candidates++;if(record.status==='admitted')origin.admitted++;
    for(const feature of record.features){const group=byFeature[feature]??={candidates:0,admitted:0};group.candidates++;if(record.status==='admitted')group.admitted++;}}
  return {candidateExecutions:records.length,candidateFamilies:new Set(records.map(r=>r.family)).size,statuses,refusals,byOrigin,byFeature,
    admissionFraction:records.length?(statuses.admitted??0)/records.length:null,modelExecutionAccuracy:null,agentTaskSuccess:null,
    denominator:'every candidate in the declared inventory, including missing inputs and refusals'};
}
function finish(extra){const finishedIdentity=implementationIdentity();return {started,finished:new Date().toISOString(),implementation:identity,
  implementationAtFinish:finishedIdentity,codeChangedDuringRun:identity.sha256!==finishedIdentity.sha256,
  actualModelSamples:0,...extra};}

if(command==='build'){
  const candidates=assignFrozenSplits([...generatedCandidates({seed}),...(values['no-upstream']?[]:repositoryCandidates({root,seed,perFamily}))],{seed});
  const selected=limit?candidates.slice(0,limit):candidates;
  const records=await pool(selected,qualify),accepted=records.filter(r=>r.status==='admitted').map(r=>r.task);
  const {main,familiar,duplicateDiagnosticInputs}=splitDiagnosticInputs(accepted);
  const challengeRaw=challengeCandidates(main,{seed}),challengeRecords=await pool(challengeRaw,qualify);
  const challenge=challengeRecords.filter(r=>r.status==='admitted').map(r=>r.task);
  jsonl('main.jsonl',main);jsonl('familiar-inputs.jsonl',familiar);jsonl('challenge.jsonl',challenge);
  jsonl('familiar-input-exclusions.jsonl',duplicateDiagnosticInputs);
  jsonl('admission.jsonl',records.map(({task,...record})=>record));
  jsonl('challenge-admission.jsonl',challengeRecords.map(({task,...record})=>record));
  const evaluation=Object.fromEntries(['train','validation','test'].map(split=>[split,main.filter(r=>r.split===split).map(r=>r.id).sort()]));
  json('evaluation-manifest.json',evaluation);
  const manifest=finish({schema:BENCHMARK_SCHEMA,seed,splitFractions:{train:0.5,validation:0.2,test:0.3},requestedCandidates:candidates.length,limited:limit!==null,
    includeUpstream:!values['no-upstream'],perFamily,candidatePopulation:censusSummary(records),counts:datasetCounts(main),
    diagnostics:{familiarInputs:datasetCounts(familiar),familiarInputDuplicateExclusions:duplicateDiagnosticInputs.length,
      challenge:datasetCounts(challenge),challengePopulation:censusSummary(challengeRecords)},
    files:Object.fromEntries(['main.jsonl','familiar-inputs.jsonl','familiar-input-exclusions.jsonl','challenge.jsonl','admission.jsonl','challenge-admission.jsonl','evaluation-manifest.json']
      .map(name=>[name,{sha256:digestFile(join(output,name)),bytes:readFileSync(join(output,name)).length}])),
    splitPolicy:'union declared family, template, ancestors, exact source and conservative alpha/literal clone fingerprint before admission',
    claims:{independentFamiliesAreComponents:true,sourceVariantsAreNotIndependentFamilies:true,
      familiarInputsAreGeneralizationEvidence:false,challengeUsesHeldOutParentFamilies:true,agentTaskSuccessVerified:false},
    verificationScope:'complete owned execution versus existing native reference; independent boundary fuzz is a separate evidence file'});
  json('manifest.json',manifest);console.log(JSON.stringify({output,manifest}));
  if(manifest.codeChangedDuringRun)process.exitCode=2;
  else if(records.some(r=>r.sourceOrigin==='authored-generator'&&r.status!=='admitted'))process.exitCode=1;
}else if(command==='census'){
  const input=values.input?readCandidateJsonl(values.input):censusCandidates({root,seed,perFamily:Math.min(perFamily,2)});
  const candidates=input.map((row,index)=>{
    const task=row.executorTask??row.task??row;
    return {...task,id:task.id??'input-'+index,metadata:{...task.metadata,
      sourceOrigin:task.metadata?.sourceOrigin??(row.messages?'supplied-agent-trajectory':'supplied-task'),
      features:task.metadata?.features??[],agentTaskSuccessVerified:false}};
  });
  const selected=limit?candidates.slice(0,limit):candidates,records=await pool(selected,qualify);
  jsonl('admission.jsonl',records.map(({task,...record})=>record));
  const report=finish({schema:'tinker-workload-admission-census/1',seed,limited:limit!==null,requestedCandidates:candidates.length,
    inventory:values.input?{path:resolve(values.input),sha256:digestFile(resolve(values.input))}:
      {streams:['pinned-utilities','pinned-exercism','pinned-production','existing-engineering','existing-semantic-recipes','existing-algorithm-recipes'],
        perPinnedFamily:Math.min(perFamily,2),agentTrajectoriesIncluded:false,
        scope:'the enumerated repository inventories; not a claim to census every file or deployment workload'},
    summary:censusSummary(records),recordsSha256:digestFile(join(output,'admission.jsonl')),
    refusalExamples:records.filter(r=>r.status!=='admitted').slice(0,20).map(({task,...record})=>record)});
  json('report.json',report);console.log(JSON.stringify({output,report}));if(report.codeChangedDuringRun)process.exitCode=2;
}else{
  const statePath=join(output,'run.json'),recordsPath=join(output,'cases.jsonl'),receiptPath=join(output,'append-receipt.json');
  const binding={schema:'tinker-fuzz-run/1',seed,count,implementation:identity};
  let previous=[],recordCount=0;
  const chain=createHash('sha256');
  const seal=()=>{const temporary=receiptPath+'.tmp';writeFileSync(temporary,JSON.stringify({schema:'tinker-fuzz-append-receipt/1',
    bindingSha256:sha256(binding),recordCount,recordsSha256:chain.copy().digest('hex')})+'\n');renameSync(temporary,receiptPath);};
  if(values.resume){
    if(!existsSync(statePath)||!existsSync(recordsPath)||!existsSync(receiptPath))throw Error('No compatible receipted fuzz run to resume');
    const old=JSON.parse(readFileSync(statePath,'utf8'));
    if(JSON.stringify(old)!==JSON.stringify(binding))throw Error('Fuzz resume identity/count/seed mismatch');
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8')),contents=readFileSync(recordsPath,'utf8'),lines=contents.match(/[^\n]*\n/g)??[];
    if(receipt.schema!=='tinker-fuzz-append-receipt/1'||receipt.bindingSha256!==sha256(binding)||
      !Number.isSafeInteger(receipt.recordCount)||receipt.recordCount<0||receipt.recordCount>count||receipt.recordCount>lines.length)
      throw Error('Fuzz append receipt is not bound to this run');
    const prefix=lines.slice(0,receipt.recordCount).join('');
    if(sha256(prefix)!==receipt.recordsSha256)throw Error('Fuzz records do not match sealed append receipt');
    previous=prefix.split('\n').filter(Boolean).map(line=>JSON.parse(line));const ids=new Set();
    for(const record of previous){validateFuzzResumeRecord(record,{seed,count});if(ids.has(record.index))throw Error('Duplicate fuzz record');ids.add(record.index);}
    if(contents!==prefix){const archive=join(output,'unreceipted-'+Date.now()+'.jsonl');writeFileSync(archive,contents.slice(prefix.length));
      writeFileSync(recordsPath,prefix);process.stderr.write('Retained unreceipted tail in '+archive+'; these cases will be executed again.\n');}
    chain.update(prefix);recordCount=previous.length;
  }else{
    if(existsSync(recordsPath)||existsSync(statePath)||existsSync(receiptPath))throw Error('Fuzz evidence exists; use --resume or a fresh output directory');
    json('run.json',binding);writeFileSync(recordsPath,'');
    seal();
  }
  const completed=new Set(previous.map(r=>r.index)),remaining=Array.from({length:count},(_,i)=>i).filter(i=>!completed.has(i));
  const results=await pool(remaining,index=>verifyFuzzCase(seed,index),record=>{
    validateFuzzResumeRecord(record,{seed,count});
    const line=JSON.stringify(record)+'\n';writeFileSync(recordsPath,line,{flag:'a'});chain.update(line);recordCount++;seal();
    if(!record.ok)json('failure-'+record.index+'.json',record);
  });
  if(digestFile(recordsPath)!==chain.copy().digest('hex'))throw Error('Fuzz records changed outside this writer');
  const all=[...previous,...results].sort((a,b)=>a.index-b.index),report=finish({...aggregateVerification(all),seed,requestedCases:count,
    recordsSha256:digestFile(recordsPath),codeIdentity:identity.sha256,minimization:'bounded argument simplification and statement deletion preserving the same failure category'});
  report.gatePassed=report.failures===0&&report.cases===count&&report.independentChecks===count&&!report.codeChangedDuringRun;
  json('report.json',report);console.log(JSON.stringify({output,report}));if(!report.gatePassed)process.exitCode=1;
}
