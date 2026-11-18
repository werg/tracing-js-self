#!/usr/bin/env node
// Read-only proof for existing selections: compare full native episodes while
// retaining original campaigns, selector reports and selected export bytes.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {sha256} from '../src/corpus/campaign-store.mjs';
import {nativeEpisodeMetadata} from './select-admitted-campaign.mjs';

export async function verifyExactPublicAliases({input,selection,tracerRoot,consumerRoot,tokenizerJson,python,output}){
  input=resolve(input);selection=resolve(selection);tracerRoot=resolve(tracerRoot);output=resolve(output);
  const reportPath=join(selection,'selection-report.json'),manifestPath=join(input,'manifest.json'),
    originalManifest=readFileSync(manifestPath),reportBytes=readFileSync(reportPath),
    report=JSON.parse(reportBytes),manifest=JSON.parse(originalManifest),
    header=JSON.parse(readFileSync(join(input,'campaign.json'),'utf8'));
  if(report.sourceManifestSha256!==sha256(originalManifest)||report.sourceCampaignDigest!==header.identityDigest||
    report.exactPublicSelection?.enabled!==true)
    throw new Error('Alias proof requires the exact original selected campaign');
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:tracerRoot,encoding:'utf8'}).trim();
  if(revision!==manifest.producerRevision)throw new Error('Alias proof requires the exact producing checkout');
  execFileSync('git',['diff','--quiet','HEAD','--'],{cwd:tracerRoot});
  const [{CampaignStore},{verifyNativeBinding}]=await Promise.all([
    import(pathToFileURL(join(tracerRoot,'src/corpus/campaign-store.mjs')).href),
    import(pathToFileURL(join(tracerRoot,'src/training/effectful-admit.js')).href)]);
  const store=new CampaignStore(input,header.identity,{resume:true,recoverTornLog:false,
    maxObjectBytes:header.identity.bounds?.maxOutputBytes??268435456});
  const aliases=report.exclusions.filter(row=>row.status==='exact_public_alias');
  if(aliases.length!==report.exactPublicSelection.excludedAliases)
    throw new Error('Alias exclusion count changed');
  const selectedManifest=JSON.parse(readFileSync(join(selection,'manifest.json'),'utf8')),
    selectedById=new Map(selectedManifest.cases.map(row=>[row.id,row]));
  mkdirSync(output,{recursive:false});
  const temporary=mkdtempSync(join(output,'native-inputs-')),groups=[];
  try{
    let ordinal=0;
    for(const group of report.exactPublicSelection.groups){
      const members=[],metadataDigests=new Set();
      for(const id of [group.representativeId,...group.aliases]){
        const entry=store.latest.get(id);
        if(entry?.status!=='admitted')throw new Error('Alias proof member is not originally admitted');
        const exported=store.exported(entry),side=exported.sidecar;
        verifyNativeBinding(exported,header.identity.nativePolicy);
        const publicDigest=sha256(JSON.stringify(exported.public));
        if(publicDigest!==group.episodeDigest||side.splitIdentity.componentId!==group.componentId||
          side.split!==group.split||side.splitIdentity.registryDigest!==group.registryDigest)
          throw new Error('Alias proof original public stream or frozen component differs');
        if(id!==group.representativeId){
          const alias=aliases.find(row=>row.id===id);
          if(!alias||alias.representativeId!==group.representativeId||alias.identityDigest!==side.identityDigest||
            alias.candidateDigest!==entry.candidateDigest||alias.sourceEntryDigest!==entry.entryDigest)
            throw new Error('Alias exclusion no longer binds its original immutable candidate');
        }
        const metadataDigest=sha256(JSON.stringify(nativeEpisodeMetadata(side)));
        metadataDigests.add(metadataDigest);
        const bytes=Buffer.from(JSON.stringify(exported)+'\n'),file=String(ordinal++)+'.json';
        if(selectedById.has(id)){
          const selectedBytes=readFileSync(join(selection,selectedById.get(id).path));
          if(!selectedBytes.equals(bytes))throw new Error('Existing selected export bytes differ from the original');
        }
        writeFileSync(join(temporary,file),bytes,{flag:'wx'});
        members.push({id,file,exportSha256:sha256(bytes),identityDigest:side.identityDigest,
          candidateDigest:entry.candidateDigest,sourceEntryDigest:entry.entryDigest,
          nativeEpisodeMetadataDigest:metadataDigest});
      }
      if(metadataDigests.size!==1)throw new Error('Existing aliases fail strengthened native metadata compatibility');
      groups.push({episodeDigest:group.episodeDigest,representativeId:group.representativeId,members});
    }
    if(groups.reduce((n,group)=>n+group.members.length-1,0)!==aliases.length)
      throw new Error('Alias group inventory does not cover every exclusion');
    const inputs=join(temporary,'inputs.json');
    writeFileSync(inputs,JSON.stringify({nativePolicy:header.identity.nativePolicy,groups}));
    const nativeTool=fileURLToPath(new URL('./verify-exact-public-aliases.py',import.meta.url));
    const native=JSON.parse(execFileSync(python,[nativeTool,'--inputs',inputs,'--consumer-root',resolve(consumerRoot),
      '--tokenizer-json',resolve(tokenizerJson)],{encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024}));
    if(sha256(readFileSync(manifestPath))!==sha256(originalManifest)||sha256(readFileSync(reportPath))!==sha256(reportBytes))
      throw new Error('Original campaign or selection changed during alias verification');
    const receipt={schema:'semantic-exact-public-native-equivalence/1',status:'verified',retrospective:true,
      sourceCampaignDigest:header.identityDigest,sourceManifestSha256:sha256(originalManifest),
      selectionReportSha256:sha256(reportBytes),originalSelectionPolicy:report.exactPublicSelection.policy,
      strengthenedSelectionPolicy:'exact-public-within-frozen-component/2',
      producerRevision:revision,producerVerifierEnvironmentUnchanged:true,
      originalCampaignModified:false,originalSelectionModified:false,newAdmissionClaims:false,
      optimizerSteps:0,modelInferenceCalls:0,allowedNativeDifference:['lineage.task_id'],
      verifierSha256:sha256(readFileSync(new URL(import.meta.url))),nativeVerifierSha256:sha256(readFileSync(nativeTool)),
      metadataHelperSha256:sha256(readFileSync(new URL('./select-admitted-campaign.mjs',import.meta.url))),native};
    writeFileSync(join(output,'native-equivalence.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    return receipt;
  }finally{rmSync(temporary,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const flags=new Map();
  for(let index=2;index<process.argv.length;index+=2)flags.set(process.argv[index],process.argv[index+1]);
  for(const key of ['--input','--selection','--tracer-root','--consumer-root','--tokenizer-json','--python','--out'])
    if(!flags.get(key))throw new Error('Missing '+key);
  const result=await verifyExactPublicAliases({input:flags.get('--input'),selection:flags.get('--selection'),
    tracerRoot:flags.get('--tracer-root'),consumerRoot:flags.get('--consumer-root'),tokenizerJson:flags.get('--tokenizer-json'),
    python:flags.get('--python'),output:flags.get('--out')});
  console.log(JSON.stringify({status:result.status,groups:result.native.comparedGroups,aliases:result.native.comparedAliases}));
}
