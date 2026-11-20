#!/usr/bin/env node
// Full-population accounting with explicitly selected, isolated executions.
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createTest262Campaign,bindTest262CatalogProfile,recordTest262Stages,
  validateTest262Campaign,conformanceDigest} from '../src/conformance/test262-catalog.js';
import {acquireTest262GitSnapshot} from '../src/conformance/test262-acquisition.js';
import {ownedTest262Profile,prepareOfficialTest262Variant,checkOfficialTest262Syntax} from '../src/conformance/test262-runner.js';
import {fingerprintTest262Implementation,verifyTest262ImplementationFiles,readTest262Json,writeTest262Json,
  createTest262CampaignReport,validateOriginalTest262Report,runOriginalTest262Worker} from '../src/conformance/test262-campaign.js';

const root=fileURLToPath(new URL('..',import.meta.url)),flags=new Map();
const booleans=new Set(['--all']);
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i],value=booleans.has(key)?true:process.argv[++i];
  if(!['--catalog','--suite-root','--out','--stages','--paths','--cases','--limit','--all','--resume','--check',
    '--jobs','--max-steps','--max-source-bytes','--reference-timeout-ms','--worker-timeout-ms','--heap-mb'].includes(key)||
    flags.has(key)||value===undefined||typeof value==='string'&&value.startsWith('--'))
    throw new TypeError('Invalid original Test262 campaign argument: '+key);
  flags.set(key,value);
}
const number=(name,fallback,min=1,max=Number.MAX_SAFE_INTEGER)=>{
  const value=flags.has(name)?Number(flags.get(name)):fallback;
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError('Invalid '+name);
  return value;
};
const baseInput=readTest262Json(flags.get('--catalog')??join(root,'artifacts/conformance/test262-d53ebc8b-frozen-catalog.json.xz'));
const baseCatalog=baseInput.catalog??baseInput;
if(flags.has('--check')){
  const report=readTest262Json(flags.get('--check'));
  validateOriginalTest262Report(report,{baseCatalog,implementation:report.campaign.implementation});
  verifyTest262ImplementationFiles(report.campaign.implementation);
  console.log(JSON.stringify({valid:true,catalogDigest:report.catalogDigest,summary:report.summary}));
}else{
  if(!flags.has('--suite-root')||!flags.has('--out'))throw new TypeError('--suite-root and --out are required');
  const stages=(flags.get('--stages')??'parse,owned,reference').split(',');
  if(!stages.length||new Set(stages).size!==stages.length||stages.some(stage=>!['parse','owned','reference'].includes(stage)))
    throw new TypeError('Stages must be a unique comma-separated selection of parse,owned,reference');
  if(stages.some(stage=>stage!=='parse')&&!['--paths','--cases','--limit','--all'].some(key=>flags.has(key)))
    throw new TypeError('Execution requires an explicit --paths, --cases, --limit or --all selection');
  const profile=ownedTest262Profile({specification:baseCatalog.profile.specification,
    maxSteps:number('--max-steps',20000),maxSourceBytes:number('--max-source-bytes',1048576),
    referenceTimeoutMs:number('--reference-timeout-ms',300,10,1000)});
  const catalog=bindTest262CatalogProfile(baseCatalog,profile);
  let selected=catalog.variants;
  if(flags.has('--paths')){
    const paths=flags.get('--paths').split(',');
    if(paths.some(path=>!path.startsWith('test/')||path.includes('..')))throw new TypeError('Selection paths must be safe test paths');
    selected=selected.filter(row=>paths.some(path=>path.endsWith('/')?row.path.startsWith(path):row.path===path));
    if(!selected.length)throw new TypeError('--paths selected no frozen variants');
  }
  if(flags.has('--cases')){
    const ids=flags.get('--cases').split(',');
    if(new Set(ids).size!==ids.length||ids.some(id=>!selected.some(row=>row.id===id)))throw new TypeError('Unknown or duplicate selected variant');
    selected=selected.filter(row=>ids.includes(row.id));
  }
  if(flags.has('--limit'))selected=selected.slice(0,number('--limit',1));
  const runPolicy={stages,jobs:number('--jobs',2,1,16),workerTimeoutMs:number('--worker-timeout-ms',10000,10,3600000),
    heapMb:number('--heap-mb',384,64,4096),selection:{paths:flags.get('--paths')??null,
      cases:flags.get('--cases')??null,limit:flags.has('--limit')?number('--limit',1):null,all:flags.has('--all')}};
  const implementation={...fingerprintTest262Implementation(),runPolicy};
  let campaign=createTest262Campaign({catalog,implementation,selectedIds:selected.map(row=>row.id)});
  if(flags.has('--resume')){
    const prior=readTest262Json(flags.get('--resume'));
    const checked=validateOriginalTest262Report(prior,{baseCatalog,implementation});
    if(checked.catalog.digest!==catalog.digest||prior.campaign.identityDigest!==campaign.identityDigest||
      conformanceDigest(prior.runPolicy)!==conformanceDigest(runPolicy))throw new TypeError('Incompatible original Test262 resume policy or selection');
    campaign=prior.campaign;
  }
  const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:flags.get('--suite-root'),revision:catalog.suiteRevision});
  if(Object.keys(snapshot.files).length!==catalog.files.length||catalog.files.some(file=>snapshot.files[file.path]!==file.gitBlobSha))
    throw new TypeError('Acquired exact Git tree differs from the frozen catalog population');
  const output=resolve(flags.get('--out'));
  const checkpoint=()=>{
    verifyTest262ImplementationFiles(implementation);
    const report=createTest262CampaignReport({baseCatalog,catalog,campaign,runPolicy});
    writeTest262Json(output,report);return report;
  };
  checkpoint();
  console.log(JSON.stringify({phase:'acquired',catalogDigest:catalog.digest,population:catalog.variants.length,
    selected:selected.length,sourceRevision:catalog.suiteRevision,output}));
  const syntaxResults=new Map();let pending=[];
  for(let index=0;index<selected.length;index++){
    const variant=selected[index];let syntax;
    try{
      const prepared=prepareOfficialTest262Variant({variant,profile,suiteRevision:catalog.suiteRevision,sources});
      prepared.code??=(variant.mode==='strict'?'"use strict";\n':'')+prepared.source;
      syntax=Buffer.byteLength(prepared.source)>profile.resourcePolicy.maxSourceBytes?
        {stage:{status:'resource_limited',reason:'Source exceeds the pinned byte budget'},parseOnly:true}:
        checkOfficialTest262Syntax(prepared,variant);
    }catch(error){syntax={stage:{status:'infrastructure_error',reason:error.message},parseOnly:true};}
    syntaxResults.set(variant.id,{status:syntax.stage.status,parseOnly:syntax.parseOnly});
    pending.push({caseId:variant.id,stage:'parseStatic',status:syntax.stage.status,reason:syntax.stage.reason,
      evidence:{sourceDigest:variant.sourceDigest,mode:variant.mode,parser:profile.parser,
        parseOnly:syntax.parseOnly,phase:syntax.stage.phase??'input',errorType:syntax.stage.errorType??null}});
    if(pending.length>=5000||index===selected.length-1){
      campaign=recordTest262Stages(campaign,pending);pending=[];checkpoint();
      console.log(JSON.stringify({phase:'parse',completed:index+1,selected:selected.length}));
    }
  }
  const tasks=[];
  for(const variant of selected){
    const syntax=syntaxResults.get(variant.id);
    if(stages.includes('owned')&&syntax.status==='passed'&&!syntax.parseOnly)tasks.push({variant,authority:'owned'});
    if(stages.includes('reference'))tasks.push({variant,authority:'reference'});
  }
  let cursor=0,completed=0;
  const work=async()=>{
    while(cursor<tasks.length){
      const {variant,authority}=tasks[cursor++];
      const paths=[variant.path,...variant.harness.map(file=>file.path)];
      const subset={};
      for(const path of paths)if(sources[path]!==undefined){
        try{subset[path]=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(sources[path]);}
        catch{/* Invalid original bytes remain missing input, never rewritten text. */}
      }
      const result=await runOriginalTest262Worker({authority,implementation,
        options:{variant,profile,suiteRevision:catalog.suiteRevision,sources:subset},
        wallTimeoutMs:runPolicy.workerTimeoutMs,heapMb:runPolicy.heapMb});
      const stage=authority==='owned'?'ownedExecution':'independentReference';
      pending.push({caseId:variant.id,stage,status:result.status,reason:result.reason,
        evidence:{...result,stages:undefined}});
      // Evidence is exact wire data: optional producer fields may be absent.
      pending[pending.length-1].evidence=JSON.parse(JSON.stringify(pending[pending.length-1].evidence));
      completed++;
      if(pending.length>=32||completed===tasks.length){
        campaign=recordTest262Stages(campaign,pending);pending=[];checkpoint();
        console.log(JSON.stringify({phase:'execute',completed,total:tasks.length}));
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(runPolicy.jobs,tasks.length)},work));
  validateTest262Campaign(campaign,{catalog,implementation});
  const report=checkpoint();
  console.log(JSON.stringify({phase:'complete',output,catalogDigest:catalog.digest,summary:report.summary}));
}
