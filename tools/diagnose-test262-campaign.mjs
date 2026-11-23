#!/usr/bin/env node
// Diagnostic replay of non-passing original inputs. This adds no admission
// claim and does not replace the isolated campaign's complete outcome ledger.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const flags=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const name=process.argv[index],value=process.argv[index+1];
  if(!['--report','--suite-root','--out'].includes(name)||!value||flags.has(name))
    throw new TypeError('Usage: node diagnose-test262-campaign.mjs --report full-report.json.gz --suite-root test262 --out diagnostics.json');
  flags.set(name,value);
}
if(flags.size!==3)throw new TypeError('--report, --suite-root and --out are required');
const local=path=>import(pathToFileURL(resolve(path)));
const {readTest262Json,validateOriginalTest262Report,verifyTest262ImplementationFiles}=await local('src/conformance/test262-campaign.js');
const {bindTest262CatalogProfile}=await local('src/conformance/test262-catalog.js');
const {prepareOfficialTest262Variant}=await local('src/conformance/test262-runner.js');
const {createRuntime}=await local('src/runtime.js');
const report=readTest262Json(flags.get('--report'));
validateOriginalTest262Report(report);verifyTest262ImplementationFiles(report.campaign.implementation);
const catalog=bindTest262CatalogProfile(report.baseCatalog,report.profile),diagnostics=[];
const variants=new Map(catalog.variants.map(row=>[row.id,row]));
for(const row of report.campaign.rows.filter(row=>row.selected&&
    ['unsupported','failed'].includes(row.stages.ownedExecution.status))){
  const variant=variants.get(row.id),sources={};
  for(const path of [variant.path,...variant.harness.map(file=>file.path)])
    sources[path]=readFileSync(join(flags.get('--suite-root'),path));
  const prepared=prepareOfficialTest262Variant({variant,profile:report.profile,
    suiteRevision:catalog.suiteRevision,sources});
  const runtime=createRuntime({maxSteps:report.profile.resourcePolicy.maxSteps});
  let error=null,exit=null;
  try{
    const sequence=[...prepared.harness.map(file=>runtime.registerSource({text:file.text,url:file.path,scriptProfile:true})),
      runtime.registerSource({text:prepared.code,url:variant.path,scriptProfile:true})];
    runtime.startScriptSequence(sequence);exit=runtime.drive();
  }catch(thrown){error={name:thrown.name,message:thrown.message};}
  const control=runtime.state.control.a0,frame=runtime.state.frames[control.activeFrameId],
    instruction=frame?runtime.programs[frame.codeId]?.instructions[frame.pc]:null,
    site=instruction?runtime.sites.find(site=>site.siteId===instruction.siteId):null,
    source=site?runtime.sources.find(source=>source.sourceId===site.sourceId):null,
    globals=runtime.state.envs[control.scriptSequence?.environmentId??control.globalEnvId]?.bindings??{};
  const observations={};
  for(const name of ['actual','expected','iterationCount','returnGets'])if(globals[name]){
    const value=globals[name].token?.value;
    observations[name]={binding:globals[name],...(value?.[0]==='ref'?{object:runtime.state.heap[value[1]]}:{})};
  }
  diagnostics.push({caseId:row.id,path:variant.path,mode:variant.mode,
    campaignStatus:row.stages.ownedExecution.status,sourceDigest:variant.sourceDigest,
    harness:variant.harness,error,exit,completedEvents:runtime.events.length,
    frameId:frame?.id??null,programCounter:frame?.pc??null,instruction:instruction??null,
    site:site??null,sourcePath:source?.url??null,sourceText:source&&instruction?
      source.text.slice(instruction.start,instruction.end):null,stack:frame?.stack??[],
    scriptSequence:control.scriptSequence??null,globals:observations,
    guestThrows:runtime.events.filter(event=>event.completion?.type==='throw').map(event=>({
      eventId:event.eventId,operation:event.operation,siteId:event.siteId,completion:event.completion})),
    promises:Object.values(runtime.state.promises).map(promise=>({id:promise.id,status:promise.status,value:promise.value}))});
  console.log(JSON.stringify({path:variant.path,mode:variant.mode,error,events:runtime.events.length}));
}
verifyTest262ImplementationFiles(report.campaign.implementation);
writeFileSync(flags.get('--out'),JSON.stringify({schema:'test262-owned-unsupported-location/1',
  purpose:'Locate the first refused operation in unchanged original source or harness execution',
  sourceRevision:catalog.suiteRevision,producerRevision:report.campaign.implementation.producerRevision,
  implementationDigest:report.campaign.implementation.codeDigest,
  inputReportSha256:createHash('sha256').update(readFileSync(flags.get('--report'))).digest('hex'),
  maxSteps:report.profile.resourcePolicy.maxSteps,independentAdmission:false,diagnostics},null,2)+'\n');
