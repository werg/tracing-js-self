import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const [rootArg,outArg,consumer,python,tokenizer,selectionFile]=process.argv.slice(2);
const root=resolve(rootArg),out=resolve(outArg),module=name=>import(pathToFileURL(join(root,name)));
const [{CAPABILITY_CASES,buildCapabilityLedger,summarizeCapabilityRows},{loadNativeSettings,createNativeConsumer},
  {encodeGenerationTask},{atomicWrite},{recheckEffectfulAdmission}]=await Promise.all([
  module('src/training/capability-ledger.js'),module('src/corpus/native-admission-client.mjs'),
  module('src/corpus/generation-process.mjs'),module('src/corpus/campaign-store.mjs'),
  module('src/training/effectful-admit.js')]);
const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
if(git(['status','--porcelain','--untracked-files=no']))throw Error('Producer must have clean tracked files');
if(existsSync(out))throw Error('Choose a new immutable evidence directory');
const producerRevision=git(['rev-parse','HEAD']);
const ids=JSON.parse(readFileSync(selectionFile,'utf8')).rows.map(row=>row.id);
if(new Set(ids).size!==ids.length||ids.some(id=>!CAPABILITY_CASES.some(row=>row.id===id)))throw Error('Capability selection changed');
const native=loadNativeSettings({megatoken:consumer,python,tokenizer,policyFile:join(root,'contracts/native-admission-policy-v5.json'),temporaryDirectory:join(out,'.native')});
const nativeConsumer=createNativeConsumer(native),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
mkdirSync(join(out,'cases'),{recursive:true});
const rows=[],files=[];let report={schema:'semantic-capability-ledger/1',status:'running',producerRevision,rows};
const save=()=>atomicWrite(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');save();
try{
 for(const id of ids){
  const fixture=CAPABILITY_CASES.find(row=>row.id===id);let exported=null;
  const fragment=await buildCapabilityLedger({producerRevision,cases:[fixture],nativePolicy:native.policy,
    nativeConsumer:async value=>{exported=value;return nativeConsumer(value);}});
  const row=fragment.rows[0];let recheck=null;
  if(row.stages.nativeAdmission==='passed'){
   if(exported.sidecar.admission!=='admitted')throw Error('Final native binding not retained');
   recheck=await recheckEffectfulAdmission(exported,{requireAdmitted:true,expectedIdentityDigest:exported.sidecar.identityDigest});
  }
  const bytes=gzipSync(Buffer.from(JSON.stringify({schema:'native-capability-private-proof/1',
    task:encodeGenerationTask({kind:'source',producerRevision,fixture:{...fixture,family:'capability:'+id}}),
    exported,ledger:row,recheck})+'\n'),{mtime:0});
  const path='cases/'+id+'.json.gz';writeFileSync(join(out,path),bytes,{flag:'wx'});
  files.push({id,path,bytes:bytes.length,sha256:sha(bytes)});rows.push(row);
  report={...fragment,status:'running',rows,totals:summarizeCapabilityRows(rows),trackedProducerClean:true,
    retainedEvidence:{schema:'native-capability-private-evidence/1',scope:'full admitted public/private documents, graph-encoded tasks and fresh source rechecks',files},
    runnerSha256:sha(readFileSync(fileURLToPath(import.meta.url))),selectionSourceSha256:sha(readFileSync(selectionFile))};
  save();console.log(id+': '+row.stages.nativeAdmission);
 }
 report.status=rows.every(row=>row.stages.nativeAdmission==='passed')?'passed':'failed';save();
 if(report.status!=='passed')process.exitCode=1;
}catch(error){report.status='failed';report.error={name:error.name,message:error.message};save();throw error;}
