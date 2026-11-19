#!/usr/bin/env node
// Internal restore worker. The Python driver authenticates and extracts the
// complete archive before invoking this file. Guest sources remain trusted.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,parseArgs} from 'node:util';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>{
  if(statSync(path).size>64*1024*1024)throw new Error('Restore metadata exceeds its bound');
  return JSON.parse(readFileSync(path,'utf8'));
};
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
export function originalProducer(root,revision){
  if(!/^[a-f0-9]{40}$/.test(revision??'')||git(root,'rev-parse','HEAD')!==revision||
    git(root,'status','--porcelain','--untracked-files=no'))
    throw new Error('Restore requires the clean exact original producer checkout');
  return {revision,tree:git(root,'rev-parse','HEAD^{tree}'),trackedWorktreeClean:true};
}

export async function replayRestoredCampaign({tracerRoot,releaseRoot,producerRevision,output,
    referenceTimeoutMs=10000,megatoken=null,tokenizer=null,python='python3'}={}){
  tracerRoot=resolve(tracerRoot);releaseRoot=resolve(releaseRoot);output=resolve(output);
  if(!Number.isSafeInteger(referenceTimeoutMs)||referenceTimeoutMs<1000||referenceTimeoutMs>120000)
    throw new Error('Reference timeout is outside its declared bound');
  if(Boolean(megatoken)!==Boolean(tokenizer))throw new Error('Native requalification needs consumer and tokenizer');
  if(existsSync(output))throw new Error('Restore replay output must be new');
  const producer=originalProducer(tracerRoot,producerRevision);
  const release=json(join(releaseRoot,'release-manifest.json')),corpus=join(releaseRoot,'corpus');
  if(release.schema!=='semantic-private-release/1'||release.producerRevision!==producerRevision||
    release.campaignManifestSha256!==sha(readFileSync(join(corpus,'manifest.json'))))
    throw new Error('Restored release does not bind its original campaign');
  const load=async name=>{
    // Never import a similarly named untracked substitute or the restorer's
    // current interpreter. Missing historical APIs are an explicit refusal.
    git(tracerRoot,'ls-files','--error-unmatch','--',name);
    return import(pathToFileURL(join(tracerRoot,name)).href);
  };
  const {verifyReleaseCampaign}=await load('tools/verify-release-campaign.mjs');
  const {CampaignStore}=await load('src/corpus/campaign-store.mjs');
  const {recheckEffectfulAdmission,requireNativeAdmission}=await load('src/training/effectful-admit.js');
  const {admissionEnvironment}=await load('src/training/admission-identity.js');
  const environment=admissionEnvironment();
  const verification=await verifyReleaseCampaign(corpus);
  if(verification.producerRevision!==producerRevision||verification.attempted!==release.attempted||
    !isDeepStrictEqual(verification.counts,release.counts))
    throw new Error('Restored release changed original campaign dispositions or denominator');
  mkdirSync(output,{mode:0o700});
  writeFileSync(join(output,'campaign-verification.json'),JSON.stringify(verification,null,2)+'\n',{flag:'wx'});
  const report={schema:'semantic-release-original-replay/1',status:'running',producer,environment,
    scope:'every original positive attempt, including superseded attempts; other dispositions preserved',
    campaignIdentityDigest:verification.campaignIdentityDigest,campaignHead:verification.campaignHead,
    manifestSha256:verification.manifestSha256,attemptedCandidates:verification.attempted,
    attempts:verification.attempts,latestDispositionCounts:verification.counts,
    positiveAttempts:0,originalAdmittedAttempts:0,originalLocallyVerifiedAttempts:0,
    replayVerified:0,replayFailed:0,preservedNonpositiveAttempts:0,
    nativeRequalification:megatoken?'running':'untested',nativeRequalified:0,
    admissionChanged:false,originalArtifactsModified:false,freshMachineQualification:false,
    optimizerSteps:0,learnedSuccess:null};
  const header=json(join(corpus,'campaign.json'));
  let nativeConsumer=null,settings=null;
  if(megatoken){
    const {loadNativeSettings,createNativeConsumer}=await load('src/corpus/native-admission-client.mjs');
    settings=loadNativeSettings({megatoken,tokenizer,python,
      policyFile:join(tracerRoot,'contracts/native-admission-policy-v6.json'),
      temporaryDirectory:join(output,'native-temporary')});
    nativeConsumer=createNativeConsumer(settings);
  }
  const store=new CampaignStore(corpus,header.identity,{readOnly:true,recoverTornLog:false,
    maxObjectBytes:Math.min(header.identity.bounds?.maxOutputBytes??268435456,268435456)});
  try{
    for(const entry of store.entries){
      const row={id:entry.id,attempt:entry.attempt,entryDigest:entry.entryDigest,
        candidateDigest:entry.candidateDigest,originalDisposition:entry.status,
        latest:store.latest.get(entry.id).entryDigest===entry.entryDigest};
      if(!['admitted','locally_verified'].includes(entry.status)){
        row.status='preserved-without-admission';
        row.reason=store.readObject(entry.result).reason??null;
        report.preservedNonpositiveAttempts++;
      }else{
        report.positiveAttempts++;
        report[entry.status==='admitted'?'originalAdmittedAttempts':'originalLocallyVerifiedAttempts']++;
        let originalEnvironment;
        try{
          const document=store.exported(entry),side=document?.sidecar;
          originalEnvironment=side?.environment;
          if(!side||side.admission!==entry.status||side.producerRevision!==producerRevision)
            throw new Error('Original positive attempt changed disposition or producer');
          row.identityDigest=side.identityDigest;
          const before=sha(JSON.stringify(document));
          row.source=await recheckEffectfulAdmission(document,{requireAdmitted:entry.status==='admitted',
            expectedIdentityDigest:side.identityDigest,timeoutMs:referenceTimeoutMs,nativePolicy:side.nativePolicy??null});
          if(!row.source.sourceValidated||!row.source.replayValidated||!row.source.identityValidated)
            throw new Error('Original source checker did not establish source, replay and identity');
          if(nativeConsumer&&entry.status==='admitted'){
            row.native=await nativeConsumer(document);
            requireNativeAdmission(document,row.native,settings.policy);
            report.nativeRequalified++;
          }
          if(before!==sha(JSON.stringify(document)))throw new Error('Original checker mutated the restored episode');
          row.status='verified';report.replayVerified++;
        }catch(error){row.status='failed';row.reason=error.message;report.replayFailed++;
          if(originalEnvironment&&!isDeepStrictEqual(originalEnvironment,environment))
            row.environmentDifferences=Object.fromEntries([...new Set([...Object.keys(originalEnvironment),...Object.keys(environment)])]
              .filter(key=>!isDeepStrictEqual(originalEnvironment[key],environment[key]))
              .map(key=>[key,{original:originalEnvironment[key],actual:environment[key]}]));
        }
      }
      appendFileSync(join(output,'attempts.jsonl'),JSON.stringify(row)+'\n');
    }
  }finally{store.close();}
  const finalVerification=await verifyReleaseCampaign(corpus);
  if(!isDeepStrictEqual(finalVerification,verification)||
    !isDeepStrictEqual(originalProducer(tracerRoot,producerRevision),producer))
    throw new Error('Original campaign or producer changed during restore replay');
  report.status=report.replayFailed?'failed':'verified';
  if(nativeConsumer)report.nativeRequalification=!report.originalAdmittedAttempts?'not-applicable-no-original-admissions':
    report.nativeRequalified===report.originalAdmittedAttempts?
    'verified-for-all-original-admitted-attempts':'failed';
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{'tracer-root':{type:'string'},release:{type:'string'},
    'producer-revision':{type:'string'},out:{type:'string'},'reference-timeout-ms':{type:'string'},
    megatoken:{type:'string'},tokenizer:{type:'string'},python:{type:'string'}}});
  for(const key of ['tracer-root','release','producer-revision','out'])if(!values[key])throw new Error('Missing --'+key);
  const report=await replayRestoredCampaign({tracerRoot:values['tracer-root'],releaseRoot:values.release,
    producerRevision:values['producer-revision'],output:values.out,
    referenceTimeoutMs:Number(values['reference-timeout-ms']??10000),megatoken:values.megatoken,
    tokenizer:values.tokenizer,python:values.python??'python3'});
  console.log(JSON.stringify(report));if(report.status!=='verified')process.exitCode=1;
}
