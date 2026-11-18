#!/usr/bin/env node
// Bind every manifest disposition to the complete durable campaign. This tool
// intentionally uses the stored campaign identity: packaging a historical
// corpus must not substitute the current checkout's source/runtime identity.
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,readFileSync,statSync} from 'node:fs';
import {resolve,join,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {CampaignStore,sha256} from '../src/corpus/campaign-store.mjs';

const MAX_METADATA_BYTES=64*1024*1024,MAX_OBJECT_BYTES=256*1024*1024;
const safeId=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
const hash=/^[a-f0-9]{64}$/;
const fail=message=>{throw new Error('Release campaign verification failed: '+message);};
function sourcePath(root,name){
  if(typeof name!=='string'||!name||name==='.'||name.includes('\\')||name.includes('\0')||
    posix.isAbsolute(name)||name.split('/').includes('..')||posix.normalize(name)!==name)
    fail('noncanonical candidate path');
  let path=root;
  for(const part of name.split('/')){path=join(path,part);if(lstatSync(path).isSymbolicLink())fail('symbolic link input');}
  if(!statSync(path).isFile())fail('candidate path is not a regular file');
  return path;
}
function readJSON(path,maximum=MAX_METADATA_BYTES){
  if(statSync(path).size>maximum)fail('JSON metadata exceeds its bounded limit');
  return JSON.parse(readFileSync(path,'utf8'));
}
async function fileHash(path){
  const hash=createHash('sha256');for await(const block of createReadStream(path))hash.update(block);
  return hash.digest('hex');
}

export async function verifyReleaseCampaign(directory){
  const root=resolve(directory),headerPath=sourcePath(root,'campaign.json'),
    manifestPath=sourcePath(root,'manifest.json');
  const header=readJSON(headerPath),manifest=readJSON(manifestPath);
  if(manifest.schema!=='semantic-corpus-manifest/4'||!Array.isArray(manifest.cases)||
    !manifest.counts||typeof manifest.counts!=='object'||Array.isArray(manifest.counts))fail('invalid manifest');
  const campaign=new CampaignStore(root,header.identity,{readOnly:true,maxObjectBytes:MAX_OBJECT_BYTES});
  try{
    if(manifest.producerRevision!==header.identity.producerRevision||
      manifest.campaign?.identityDigest!==campaign.identityDigest||
      manifest.campaign.completed!==manifest.cases.length||
      manifest.cases.length!==campaign.latest.size)fail('manifest does not cover the complete campaign');
    const seen=new Set(),paths=new Set(),physicalPaths=new Set(),counts={},dispositions=[],
      objects=new Map(),compatibilityExports=[];
    // Validate paths for every historical attempt, including refused and
    // superseded candidates. CampaignStore has already verified all bytes.
    for(const entry of campaign.entries){
      const candidate=campaign.readObject(entry.candidate);
      for(const ref of [entry.candidate,entry.result,entry.public,entry.private,
        ...(candidate.inputs??[]).flatMap(input=>[input.source,input.input,input.fixture])].filter(Boolean)){
        sourcePath(root,ref.path);
        if(objects.has(ref.path)&&!isDeepStrictEqual(objects.get(ref.path),ref))fail('ambiguous object path identity');
        objects.set(ref.path,ref);
      }
    }
    for(const row of manifest.cases){
      if(!row||!safeId.test(row.id??'')||seen.has(row.id))fail('duplicate or unsafe candidate ID');
      seen.add(row.id);
      const entry=campaign.latest.get(row.id);
      if(!entry||entry.status!==row.status||entry.candidateDigest!==row.candidateDigest)
        fail('candidate disposition or digest differs from its committed attempt: '+row.id);
      const candidate=campaign.readObject(entry.candidate),result=campaign.readObject(entry.result);
      if(candidate.id!==undefined&&candidate.id!==row.id||
        candidate.family!==undefined&&candidate.family!==row.family)
        fail('candidate ID or family differs: '+row.id);
      if(row.durationMs!==entry.durationMs||row.peakRssBytes!==entry.peakRssBytes)
        fail('candidate resource receipt differs: '+row.id);
      counts[row.status]=(counts[row.status]??0)+1;
      const disposition={id:row.id,family:row.family,status:row.status,candidateDigest:entry.candidateDigest,
        entryDigest:entry.entryDigest,attempt:entry.attempt,candidate:entry.candidate,result:entry.result};
      if(entry.public){
        if(!isDeepStrictEqual(row.publicShard,entry.public)||!isDeepStrictEqual(row.privateEvidence,entry.private))
          fail('public/private object references differ: '+row.id);
        const document=campaign.exported(entry),side=document.sidecar,details=result.campaignSummary;
        if(!details||side.admission!==row.status||side.producerRevision!==manifest.producerRevision||
          side.sourceFamily!==row.family||side.split!==row.split||side.representation!==row.representation||
          side.identityDigest!==row.identityDigest||!hash.test(row.identityDigest??'')||
          row.episodeDigest!==sha256(JSON.stringify(document.public)))
          fail('public episode, identity, split or source binding differs: '+row.id);
        for(const field of ['split','episodeDigest','identityDigest','metrics','difficulty','sourceCluster'])
          if(!isDeepStrictEqual(row[field],details[field]))fail('candidate summary differs: '+row.id+' '+field);
        if(row.sourceCluster!==(side.splitIdentity?.componentId??side.sourceFamily))
          fail('source component differs: '+row.id);
        if(row.path!==undefined){
          if(paths.has(row.path))fail('duplicate candidate path');
          const path=sourcePath(root,row.path),metadata=statSync(path),physical=metadata.dev+':'+metadata.ino;
          if(physicalPaths.has(physical))fail('duplicate physical candidate path');
          paths.add(row.path);physicalPaths.add(physical);
          if(metadata.size>2*MAX_OBJECT_BYTES)fail('JSON metadata exceeds its bounded limit');
          const raw=readFileSync(path);
          if(raw.length>2*MAX_OBJECT_BYTES||!isDeepStrictEqual(JSON.parse(raw.toString('utf8')),document))
            fail('materialized candidate differs from committed objects: '+row.id);
          compatibilityExports.push({path:row.path,bytes:raw.length,sha256:sha256(raw)});
        }
        Object.assign(disposition,{split:row.split,identityDigest:row.identityDigest,episodeDigest:row.episodeDigest,
          sourceCluster:row.sourceCluster,publicShard:entry.public,privateEvidence:entry.private,
          ...(row.path===undefined?{}:{path:row.path})});
      }else{
        if(row.status==='admitted'||row.publicShard!==undefined||row.privateEvidence!==undefined||row.path!==undefined||
          row.episodeDigest!==undefined||row.identityDigest!==undefined||row.reason!==(result.reason??null))
          fail('refusal differs from committed evidence: '+row.id);
        disposition.reason=row.reason;
      }
      dispositions.push(disposition);
    }
    for(const [name,count]of Object.entries(manifest.counts))
      if(!Number.isSafeInteger(count)||count<0||count!==(name==='attempted'?manifest.cases.length:counts[name]??0))
        fail('manifest counts do not reconcile');
    if(manifest.counts.attempted!==manifest.cases.length||
      Object.entries(counts).some(([name,count])=>manifest.counts[name]!==count))fail('manifest counts omit dispositions');
    const logPath=sourcePath(root,'campaign.jsonl');
    return {schema:'semantic-release-campaign-receipt/1',status:'verified',producerRevision:manifest.producerRevision,
      campaignIdentityDigest:campaign.identityDigest,campaignHead:campaign.previous,
      manifestSha256:await fileHash(manifestPath),headerSha256:await fileHash(headerPath),logSha256:await fileHash(logPath),
      attempts:campaign.entries.length,attempted:manifest.cases.length,counts,dispositions,
      objects:[...objects.values()].sort((a,b)=>a.path.localeCompare(b.path)),compatibilityExports,
      optimizerSteps:0,learnedSuccess:null};
  }finally{campaign.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw new Error('Usage: node tools/verify-release-campaign.mjs CORPUS');
  process.stdout.write(JSON.stringify(await verifyReleaseCampaign(process.argv[2]))+'\n');
}
