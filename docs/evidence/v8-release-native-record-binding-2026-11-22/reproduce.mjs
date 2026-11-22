import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [repository,input,output]=process.argv.slice(2).map(value=>resolve(value));
const {openQualificationProgress}=await import(pathToFileURL(join(repository,'src/corpus/qualification-progress.mjs')));
const {verifyV8ReleaseCampaign}=await import(pathToFileURL(join(repository,'tools/verify-v8-release-campaign.mjs')));
const read=name=>JSON.parse(readFileSync(join(input,name),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const population=read('population.json'),report=read('report.json'),authority=read('original-authority.json').identity;
const pair=['se-support-rectangle-perimeter-pure','se-support-rectangular-capacity-pure'];
const results=[];
for(const swap of [false,true]){
  const root=join(output,swap?'wrong-task-artifact':'unchanged-task-artifact');
  const progress=openQualificationProgress(root,authority),artifacts={},rows=[];
  for(const name of ['population.json','support-cohort.json','family-registry.json']){
    copyFileSync(join(input,name),join(root,name));artifacts[name]=sha(readFileSync(join(root,name)));
  }
  try{
    for(const [index,task] of population.tasks.entries()){
      const row=structuredClone(report.rows[index]),id=row.id;
      const from=swap&&pair.includes(id)?pair[1-pair.indexOf(id)]:id;
      const names=['source','admitted','native'].map(kind=>id+'.'+kind+'.json');
      for(const kind of ['source','admitted','native']){
        const name=id+'.'+kind+'.json';
        copyFileSync(join(input,(kind==='source'?id:from)+'.'+kind+'.json'),join(root,name));
        artifacts[name]=sha(readFileSync(join(root,name)));
      }
      row.nativeReceipt=read(from+'.native.json');
      progress.complete(id,task,row,names);rows.push(row);
    }
    progress.save('report.json',{...report,rows,artifacts,progressDigest:progress.digest});
  }finally{progress.close();}
  const snapshot=await verifyV8ReleaseCampaign(root);
  const detail={schema:'semantic-v8-release-task-artifact-red-control/1',
    mode:swap?'wrong-task-artifact':'unchanged-task-artifact',
    snapshotStatus:snapshot.status,declared:snapshot.declared,
    sourceQualified:snapshot.sourceQualified,nativeAdmitted:snapshot.nativeAdmitted,
    originalPopulationByteExact:sha(readFileSync(join(root,'population.json')))===sha(readFileSync(join(input,'population.json'))),
    originalRegistryByteExact:sha(readFileSync(join(root,'family-registry.json')))===sha(readFileSync(join(input,'family-registry.json'))),
    originalTaskAndSelectionUnchanged:JSON.stringify(population)===JSON.stringify(JSON.parse(readFileSync(join(root,'population.json')))),
    mappings:pair.map(id=>{
      const task=population.tasks.find(t=>t.fixture.id===id);
      const artifact=JSON.parse(readFileSync(join(root,id+'.source.json')));
      return {caseId:id,taskSource:task.fixture.source,
        artifactSource:artifact.sidecar.sourceArtifact.sidecar.referenceInput.source,
        artifactSourceId:artifact.sidecar.datasetBinding.sourceId,
        artifactBytesSha256:sha(readFileSync(join(root,id+'.source.json'))),
        originalSourceArtifactFrom:id,nativeArtifactFrom:swap?pair[1-pair.indexOf(id)]:id,
        originalSourcePublicDigest:artifact.sidecar.publicDigest,
        nativeReceiptPublicDigest:JSON.parse(readFileSync(join(root,id+'.native.json'))).publicDigest};
    }),
    allOriginalSourceArtifactBytesPreserved:true,
    nativeArtifactSubstitutionDetected:snapshot.status!=='verified',
    scope:'Original archived frozen64 tasks and all source assets unchanged; only two admitted/native artifact triplets swapped and journal resealed. Snapshot boundary only; no optimizer or native rerun.'};
  writeFileSync(join(output,detail.mode+'.snapshot.json'),JSON.stringify(snapshot,null,2)+'\n');
  writeFileSync(join(output,detail.mode+'.result.json'),JSON.stringify(detail,null,2)+'\n');
  results.push(detail);
}
console.log(JSON.stringify(results,null,2));
