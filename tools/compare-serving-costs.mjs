#!/usr/bin/env node
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {readQualificationCostInputs} from '../src/semantic/qualification-costs-v8.js';
import {compareRetainedServingCosts} from '../src/semantic/serving-cost-comparison.js';
import {validateAlgorithmTokenizerEvidence} from '../src/semantic/tokenizer.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),flags=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index],value=process.argv[index+1];
  if(!['--before','--after-manifest','--out'].includes(key)||flags.has(key)||!value||value.startsWith('--'))
    throw new Error('Unknown, duplicate or missing comparison option '+key);flags.set(key,value);
}
if(flags.size!==3)throw new Error('Usage: node tools/compare-serving-costs.mjs --before BASELINE_COST_DIRECTORY --after-manifest JSON_FILE --out JSON_FILE');
function loadCosts(directory,schema){
  directory=resolve(directory);const bytes=readFileSync(join(directory,'report.json')),report=JSON.parse(bytes);
  if(report.schema!==schema||report.artifactDigestEncoding!=='sha256 of exact UTF-8 file bytes')
    throw new Error('Exact-byte cost report required: '+directory);
  const evidence=report.tokenizerEvidence;
  validateAlgorithmTokenizerEvidence(evidence,{consumerRevision:evidence?.qualification?.consumerRevision,
    tokenizerIdentity:evidence?.identity?.fingerprint,tokenizerSha256:evidence?.identity?.tokenizerSha256});
  return {directory,report,reportSha256:sha(bytes),readArtifact(name){
    if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)||!/^[a-f0-9]{64}$/.test(report.artifacts?.[name]??''))
      throw new Error('Undeclared comparison artifact');
    const bytes=readFileSync(join(directory,name));if(sha(bytes)!==report.artifacts[name])throw new Error('Comparison artifact bytes changed: '+name);
    return JSON.parse(bytes);
  }};
}
const root=fileURLToPath(new URL('..',import.meta.url)),meterProducerRevision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())
  throw new Error('Cost comparison requires a clean, committed implementation');
const before=loadCosts(flags.get('--before'),'semantic-retained-population-token-costs/1'),
  manifestPath=resolve(flags.get('--after-manifest')),manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);
if(manifest.schema!=='semantic-cost-comparison-inputs/1'||!Array.isArray(manifest.populations)||!manifest.populations.length)
  throw new Error('A comparison manifest must declare current cost/qualification directory pairs');
const groups=manifest.populations.map(group=>{
  if(typeof group.id!=='string'||!group.id||typeof group.costs!=='string'||typeof group.qualification!=='string')
    throw new Error('Invalid comparison population directory pair');
  const costs=loadCosts(resolve(dirname(manifestPath),group.costs),'semantic-v8-population-costs/1'),
    input=readQualificationCostInputs(resolve(dirname(manifestPath),group.qualification)),report=costs.report;
  if(report.qualification?.reportSha256!==input.reportSha256||report.qualification?.populationDigest!==input.report.populationDigest||
    report.producerRevision!==input.report.producerRevision||report.rows.length!==input.report.rows.length||
    report.rows.some((row,index)=>row.id!==input.report.rows[index].id||row.source!==input.report.rows[index].source))
    throw new Error('Current costs differ from source qualification: '+group.id);
  return {id:group.id,...costs,input,population:input.population};
});
const report=compareRetainedServingCosts(before.report,groups),
  same=(left,right)=>hashAlgorithmData(left)===hashAlgorithmData(right);
for(const row of report.rows.filter(row=>row.status==='paired')){
  const old=before.report.rows.find(source=>source.population===row.baselinePopulation&&source.id===row.id),
    group=groups.find(group=>group.id===row.currentPopulation),current=group.report.rows.find(source=>source.id===row.id),
    oldArtifact=before.readArtifact(old.cost.artifact),newArtifact=group.readArtifact(current.cost.artifact),
    qualified=group.input.report.rows.find(source=>source.id===row.id),source=group.input.readArtifact(qualified.sourceArtifact);
  if(oldArtifact.schema!=='semantic-retained-flat-token-costs/1'||newArtifact.schema!=='semantic-flat-serving-costs/2'||
    oldArtifact.tokenizerIdentity!==before.report.tokenizerEvidence.identity.fingerprint||
    newArtifact.tokenizerIdentity!==oldArtifact.tokenizerIdentity||newArtifact.eosTokenId!==oldArtifact.eosTokenId||
    oldArtifact.eosTokenId!==before.report.eosTokenId||!same(oldArtifact.sourceIdentity,old.sourceIdentity)||
    !same(oldArtifact.bytes,old.cost.bytes)||!same(oldArtifact.tokens,old.cost.tokens)||oldArtifact.predictions!==old.cost.predictions||
    !same(newArtifact.bytes,current.cost.bytes)||!same(newArtifact.tokens,current.cost.tokens)||newArtifact.predictions!==current.cost.predictions||
    newArtifact.rows.filter(item=>item.detail).reduce((n,item)=>n+item.generatedTokens,0)!==current.cost.detailedTokens||
    newArtifact.episodeDigest!==hashAlgorithmData(source.public)||newArtifact.contextsDigest!==hashAlgorithmData(source.contexts))
    throw new Error('Paired measurements differ from exact retained source/token artifacts: '+row.id);
  row.artifacts={before:{file:old.cost.artifact,sha256:before.report.artifacts[old.cost.artifact]},
    after:{file:current.cost.artifact,sha256:group.report.artifacts[current.cost.artifact]},
    source:{file:qualified.sourceArtifact,sha256:group.input.report.artifacts[qualified.sourceArtifact]}};
}
report.meterProducerRevision=meterProducerRevision;
report.inputs={before:{reportSha256:before.reportSha256,baseline:before.report.baseline},
  afterManifestSha256:sha(manifestBytes),after:groups.map(group=>({id:group.id,producerRevision:group.report.producerRevision,
    costReportSha256:group.reportSha256,qualificationReportSha256:group.input.reportSha256,
    populationDigest:group.input.report.populationDigest,nativePolicy:group.input.report.nativePolicy}))};
const output=resolve(flags.get('--out'));mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,denominators:report.denominators,summary:report.summary,baselinePopulations:report.baselinePopulations}));
