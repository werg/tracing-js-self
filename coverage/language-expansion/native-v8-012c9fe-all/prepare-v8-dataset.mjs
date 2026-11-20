import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const [producer,out,...directories]=process.argv.slice(2);
if(!producer||!out||!directories.length)throw new Error('Usage: node prepare-v8-dataset.mjs PRODUCER NEW_OUTPUT QUALIFICATION...');
const root=resolve(producer),revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}).trim())throw new Error('Producer must be clean');
const {readQualificationCostInputs}=await import(pathToFileURL(join(root,'src/semantic/qualification-costs-v8.js')));
const candidates=[],sources=[];
for(const directory of directories){
  const input=readQualificationCostInputs(directory),{report}=input;
  if(report.producerRevision!==revision||report.sourceQualified!==report.declared||report.nativeAdmitted!==report.declared)
    throw new Error('Complete current source/native qualification required: '+directory);
  sources.push({population:report.population,declared:report.declared,reportSha256:input.reportSha256,populationDigest:report.populationDigest});
  for(const row of report.rows)candidates.push({id:report.population+':'+row.id,status:'locally_verified',exported:input.readArtifact(row.sourceArtifact)});
}
mkdirSync(resolve(out));mkdirSync(join(resolve(out),'native-inputs'));
writeFileSync(join(out,'candidates.jsonl'),candidates.map(row=>JSON.stringify(row)+'\n').join(''),{flag:'wx'});
writeFileSync(join(out,'inputs.json'),JSON.stringify({schema:'v8-dataset-qualification-inputs/1',producerRevision:revision,inputCandidates:candidates.length,sources},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:resolve(out),inputCandidates:candidates.length,sources}));
