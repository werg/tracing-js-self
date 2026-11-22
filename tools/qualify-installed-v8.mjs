#!/usr/bin/env node
// Installation qualification is source/public engineering evidence. It neither
// consults nor manufactures native consumer admission or model-quality receipts.
import {appendFileSync,existsSync} from 'node:fs';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {regionQualificationPopulation} from '../fixtures/semantic-regions/qualification.js';
import {encodeGenerationTask} from '../src/corpus/generation-process.mjs';
import {CampaignStore,atomicWrite} from '../src/corpus/campaign-store.mjs';
import {mapQualificationCases} from '../src/corpus/qualification-progress.mjs';
import {prepareInstalledV8Package,restoreInstalledV8Package,runInstalledV8Worker,runInstalledCommand,
  installedSha256,installedFileHash} from '../src/corpus/installed-v8-qualification.mjs';

export function installedQualificationInventory({producerRevision,population='both',requested=null}={}){
  if(!['all','interoperability','both'].includes(population))throw new TypeError('Unknown installed population');
  const names=population==='both'?['all','interoperability']:[population],rows=[];
  for(const name of names){
    const selected=regionQualificationPopulation({population:name,allInputs:true}),fixtures=[...selected.scripts,...selected.modules];
    if(fixtures.length!==(name==='all'?665:69))throw new Error('Declared installed population changed: '+name);
    if(new Set(fixtures.map(fixture=>fixture.id)).size!==fixtures.length)throw new Error('Duplicate installed population input');
    for(const [index,fixture]of fixtures.entries()){
      const task=encodeGenerationTask({kind:fixture.modules?'module':'source',traceVersion:8,fixture,producerRevision});
      rows.push({key:name+'-'+String(index).padStart(4,'0'),population:name,id:fixture.id,kind:task.kind,
        sourceInputDigest:installedSha256(JSON.stringify(task.fixture)),task});
    }
  }
  if(requested!==null&&(!Array.isArray(requested)||!requested.length||new Set(requested).size!==requested.length||
    requested.some(id=>!rows.some(row=>id===row.id||id===row.population+':'+row.id))))
    throw new TypeError('Unknown or duplicate installed case selection');
  for(const row of rows)row.selected=requested===null||requested.some(id=>id===row.id||id===row.population+':'+row.id);
  return {schema:'semantic-installed-v8-population/1',producerRevision,population,inputs:'all',
    declared:Object.fromEntries(names.map(name=>[name,rows.filter(row=>row.population===name).length])),
    selected:Object.fromEntries(names.map(name=>[name,rows.filter(row=>row.population===name&&row.selected).length])),rows};
}

export function parseInstalledQualificationOptions(args){
  const values=new Set(['--out','--population','--cases','--workers','--worker-timeout-ms','--worker-memory-mb',
    '--worker-output-bytes','--dependency-archives','--dependency-cache']),flags=new Map();
  for(let index=0;index<args.length;index++){
    const key=args[index];if(flags.has(key)||key!=='--resume'&&!values.has(key))throw new Error('Unknown or duplicate option '+key);
    if(key==='--resume')flags.set(key,true);
    else{const value=args[++index];if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);flags.set(key,value);}
  }
  if(!flags.has('--out'))throw new Error('Usage: node tools/qualify-installed-v8.mjs --out OUTSIDE_CHECKOUT '+
    '[--population both|all|interoperability] [--cases ID,POPULATION:ID] [--workers 1..16] [--resume] '+
    '[--dependency-archives DIRECTORY | --dependency-cache DIRECTORY]');
  const integer=(key,defaultValue,min,max)=>{
    const value=Number(flags.get(key)??defaultValue);
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('Invalid '+key);return value;
  };
  return {output:resolve(flags.get('--out')),population:flags.get('--population')??'both',
    requested:flags.has('--cases')?flags.get('--cases').split(','):null,resume:flags.has('--resume'),
    workers:integer('--workers',1,1,16),bounds:{timeoutMs:integer('--worker-timeout-ms',120000,10,3600000),
      memoryMb:integer('--worker-memory-mb',768,64,8192),maxOutputBytes:integer('--worker-output-bytes',268435456,1024,1073741824)},
    dependencyArchiveDirectory:flags.get('--dependency-archives')??null,dependencyCache:flags.get('--dependency-cache')??null};
}

export function installedQualificationOutcome(rows){
  const infrastructureFailures=rows.filter(row=>row.selected&&/^(?:worker_|installed_)/.test(row.status)),
    selectedSourceFailures=rows.filter(row=>row.selected&&row.source!=='passed');
  return {status:infrastructureFailures.length||selectedSourceFailures.length?'failed':'completed',
    coverageComplete:rows.every(row=>row.selected),sourcePopulationQualified:rows.every(row=>row.source==='passed'),
    infrastructureFailures:infrastructureFailures.map(row=>row.population+':'+row.id),
    selectedSourceFailures:selectedSourceFailures.map(row=>row.population+':'+row.id)};
}

export async function runInstalledQualification(options){
  const root=fileURLToPath(new URL('..',import.meta.url)),{output,resume,workers,bounds}=options;
  const destination=relative(root,output);
  if(destination===''||destination!=='..'&&!destination.startsWith('..'+sep))
    throw new Error('Installed qualification output must be outside the source checkout');
  if(!resume&&existsSync(output))throw new Error('Installed output already exists; choose a new directory or --resume');
  const current=(await runInstalledCommand('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
  if((await runInstalledCommand('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:root})).stdout.trim())
    throw new Error('Installed qualification requires a completely committed clean checkout');
  const inventory=installedQualificationInventory({...options,producerRevision:current}),
    populationDigest=installedSha256(JSON.stringify(inventory));
  if(!resume)atomicWrite(join(output,'population.json'),JSON.stringify({...inventory,digest:populationDigest},null,2)+'\n');
  const installation=resume?await restoreInstalledV8Package({output}):await prepareInstalledV8Package({root,output,...options});
  if(installation.evidence.producerRevision!==current)throw new Error('Installed package revision changed; cannot reuse source evidence');
  const packageDigest=installedSha256(JSON.stringify(installation.evidence)),
    identity={schema:'semantic-installed-v8-progress/1',producerRevision:current,populationDigest,packageDigest,workers,bounds,
      native:'untested',model:'untested'},store=new CampaignStore(join(output,'progress'),identity,{resume});
  const save=(name,value)=>{const bytes=JSON.stringify(value,null,2)+'\n';atomicWrite(join(output,name),bytes);return installedSha256(bytes);};
  const run=(request,filename)=>runInstalledV8Worker({...installation,...bounds,...request,
    producerRevision:current,output:join(output,filename)});
  try{
    save('population.json',{...inventory,digest:populationDigest});
    // A separate tiny control ensures that even a smoke selection containing
    // only refused sources exercises the installed API and exact lock boundary.
    const sentinel=encodeGenerationTask({kind:'source',traceVersion:8,producerRevision:current,fixture:{
      id:'installed-package-control',family:'installed-package-control',source:'"use strict";function run(){return 7;}',
      entry:'run',args:[],fixture:{calls:[]}}});
    const control=await run({task:sentinel},'package-control.json.gz');
    if(control.result.installedChecks?.source!=='passed'){
      save('setup-failure.json',{phase:'installed-public-control',...control});
      throw new Error('Installed public control failed: '+(control.result.reason??control.result.status));
    }
    const lockPath=join(installation.installed,'npm-shrinkwrap.json'),lock=await readFile(lockPath),guards=[];
    try{
      for(const mutation of ['changed-lock','missing-lock']){
        if(mutation==='changed-lock')await writeFile(lockPath,Buffer.concat([lock,Buffer.from('\n')]));else await rm(lockPath);
        const name='package-'+mutation+'.json.gz',guard=await run({mode:'recheck',candidate:control.result.exported},name),
          valid=guard.result.status==='refused'&&guard.result.nativeCalls===0&&
            (mutation==='changed-lock'?/runtime, dependency or verifier environment/.test(guard.result.reason):
              guard.result.code==='ENOENT'||/ENOENT|no such file/.test(guard.result.reason));
        guards.push({mutation,valid,result:guard.result,artifact:name,sha256:await installedFileHash(join(output,name))});
        await writeFile(lockPath,lock);
        if(!valid)throw new Error('Installed lock tamper control failed: '+mutation);
      }
    }finally{await writeFile(lockPath,lock);}
    save('package-controls.json',{schema:'semantic-installed-v8-controls/1',valid:true,
      control:{artifact:'package-control.json.gz',sha256:await installedFileHash(join(output,'package-control.json.gz')),
        checks:control.result.installedChecks},guards,native:'untested',model:'untested'});
    atomicWrite(join(output,'attempts.jsonl'),'');await mkdir(join(output,'cases'),{recursive:true});
    const rows=await mapQualificationCases(inventory.rows,workers,async input=>{
      const cached=store.cached(input.key,input.task);
      if(cached){
        const prior=store.readObject(cached.result);
        if(await installedFileHash(join(output,prior.row.artifact))!==prior.row.artifactSha256)
          throw new Error('Committed installed source evidence changed: '+input.key);
        appendFileSync(join(output,'attempts.jsonl'),JSON.stringify({...prior.row,resumed:true})+'\n');return prior.row;
      }
      const artifact='cases/'+input.key+'.json.gz';
      const execution=input.selected?await run({task:input.task},artifact):{durationMs:0,peakRssBytes:null,
        result:{status:'untested',reason:'Not selected by --cases; the original input remains in the declared population'}};
      // Also retain timeout/worker failures and unselected rows as exact bytes;
      // a process crash cannot remove their input from the denominator.
      atomicWrite(join(output,artifact),gzipSync(Buffer.from(JSON.stringify(execution.result)+'\n')));
      const result=execution.result,row={id:input.id,population:input.population,kind:input.kind,selected:input.selected,
        sourceInputDigest:input.sourceInputDigest,status:result.status,reason:result.reason??null,
        source:result.installedChecks?.source==='passed'?'passed':input.selected?'unqualified':'untested',
        installedChecks:result.installedChecks??null,native:'untested',model:'untested',
        artifact,artifactSha256:await installedFileHash(join(output,artifact)),
        durationMs:execution.durationMs,peakRssBytes:execution.peakRssBytes};
      store.record(input.key,input.task,{status:row.status,row},row);
      appendFileSync(join(output,'attempts.jsonl'),JSON.stringify(row)+'\n');
      process.stderr.write(JSON.stringify({population:row.population,id:row.id,status:row.status,source:row.source})+'\n');
      return row;
    });
    await restoreInstalledV8Package({output});
    const names=Object.keys(inventory.declared),totals=Object.fromEntries(names.map(name=>{
      const selected=rows.filter(row=>row.population===name);return [name,{declared:selected.length,
        attempted:selected.filter(row=>row.selected).length,sourceQualified:selected.filter(row=>row.source==='passed').length,
        sourceUnqualified:selected.filter(row=>row.source==='unqualified').length,untested:selected.filter(row=>row.source==='untested').length}];
    }));
    const report={schema:'semantic-installed-v8-qualification/1',producerRevision:current,packageDigest,populationDigest,
      packageEvidence:'package-installation.json',populationEvidence:'population.json',controls:'package-controls.json',
      ...installedQualificationOutcome(rows),totals,rows,workers,workerBounds:bounds,
      native:'untested',model:'untested',optimizerSteps:0,defaultPromotion:'not-qualified',
      scope:'Complete npm installation and source/public/checkpoint qualification only; all original input dispositions retained. No native consumer admission or model-learning claim.'};
    save('report.json',report);return report;
  }finally{store.close();}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const options=parseInstalledQualificationOptions(process.argv.slice(2)),report=await runInstalledQualification(options);
  console.log(JSON.stringify({output:options.output,status:report.status,producerRevision:report.producerRevision,
    totals:report.totals,coverageComplete:report.coverageComplete,native:report.native,model:report.model}));
  if(report.status!=='completed')process.exitCode=1;
}
