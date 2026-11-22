import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {parse} from 'acorn';
import {verifyDeclaredEcma262Specification} from './test262-specification.js';
import {bindTest262CatalogProfile,conformanceDigest,validateTest262Catalog,validateTest262Campaign,
  summarizeTest262Campaign} from './test262-catalog.js';

const root=fileURLToPath(new URL('../..',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const workerEnvironment=()=>Object.fromEntries(['PATH','LANG','LC_ALL','TZ']
  .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));

/** Bind only the actual runner import closure, not unrelated concurrently
 * edited development modules. Retain all hashes so a worker can reject drift. */
export function fingerprintTest262Implementation(){
  const paths=new Set(),pending=['tools/run-test262-campaign.mjs','tools/test262-original-worker.mjs',
    'src/conformance/test262-runner.js','src/conformance/test262-reference.js',
    'src/conformance/test262-acquisition.js','src/conformance/test262-catalog.js',
    'src/conformance/test262-campaign.js','npm-shrinkwrap.json','package.json'];
  while(pending.length){
    const path=pending.pop();if(paths.has(path))continue;
    paths.add(path);
    if(!/\.m?js$/.test(path))continue;
    const url=new URL(path,'file://'+root+'/'),source=readFileSync(url,'utf8');
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
    function add(specifier){
      if(typeof specifier!=='string'||!specifier.startsWith('.'))return;
      const dependency=fileURLToPath(new URL(specifier,url));
      if(!dependency.startsWith(root+'/')||!existsSync(dependency))throw new TypeError('Missing local runner dependency: '+specifier);
      pending.push(relative(root,dependency));
    }
    function walk(node){
      if(!node||typeof node!=='object')return;
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)add(node.source.value);
      if(node.type==='ImportExpression'&&node.source?.type==='Literal')add(node.source.value);
      if(node.type==='NewExpression'&&node.callee?.name==='URL'&&node.arguments[0]?.type==='Literal'&&
        /\.(?:json|mjs|js)$/.test(node.arguments[0].value??''))add(node.arguments[0].value);
      for(const [key,value] of Object.entries(node)){
        if(['loc','start','end'].includes(key))continue;
        if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
      }
    }
    walk(ast);
  }
  const files=[...paths].sort().map(path=>({path,sha256:sha(readFileSync(resolve(root,path)))}));
  files.push({path:'node_modules/acorn/dist/acorn.mjs',sha256:sha(readFileSync(new URL(import.meta.resolve('acorn'))))});
  return {producerRevision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    codeDigest:conformanceDigest(files),runnerDigest:conformanceDigest(files.filter(file=>
      file.path.startsWith('src/conformance/')||file.path.startsWith('tools/'))),
    node:process.version,v8:process.versions.v8,environment:workerEnvironment(),files};
}

export function verifyTest262ImplementationFiles(implementation){
  if(!implementation||!Array.isArray(implementation.files)||
    conformanceDigest(implementation.files)!==implementation.codeDigest)
    throw new TypeError('Invalid Test262 implementation file identity');
  for(const file of implementation.files){
    if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').some(part=>['','..','.'].includes(part))||
      sha(readFileSync(resolve(root,file.path)))!==file.sha256)
      throw new TypeError('Test262 implementation changed during the campaign: '+file.path);
  }
  if(implementation.node!==process.version||implementation.v8!==process.versions.v8)
    throw new TypeError('Test262 execution engine differs from the campaign');
  if(implementation.environment!==undefined&&conformanceDigest(implementation.environment)!==conformanceDigest(workerEnvironment()))
    throw new TypeError('Test262 execution environment differs from the campaign');
  return true;
}

export function readTest262Json(path){
  const full=resolve(path);
  const bytes=full.endsWith('.xz')?execFileSync('xz',['--decompress','--stdout','--',full],{maxBuffer:512*1024*1024}):
    full.endsWith('.gz')?gunzipSync(readFileSync(full)):readFileSync(full);
  return JSON.parse(bytes.toString('utf8'));
}
export function writeTest262Json(path,value){
  const full=resolve(path);mkdirSync(dirname(full),{recursive:true});
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  writeFileSync(full+'.tmp',full.endsWith('.gz')?gzipSync(bytes,{level:9}):bytes);
  renameSync(full+'.tmp',full);
}

export function createTest262CampaignReport({baseCatalog,catalog,campaign,runPolicy}){
  verifyDeclaredEcma262Specification(catalog.profile.specification);
  return {schema:'original-test262-campaign-report/1',baseCatalogDigest:baseCatalog.digest,baseCatalog,
    catalogDigest:catalog.digest,profile:catalog.profile,runPolicy,campaign,
    summary:summarizeTest262Campaign(campaign),
    claims:{fullSuiteAcquired:catalog.claims.fullSuiteAcquired,fullEditionConformance:false,
      publicSemanticReplay:false,nativeReplay:false,datasetAdmission:false,ordinaryTraining:false,
      serving:false,learnedUsefulness:false}};
}
export function validateOriginalTest262Report(report,{baseCatalog=report?.baseCatalog,
  implementation=report?.campaign?.implementation}={}){
  validateTest262Catalog(baseCatalog);
  if(report?.schema!=='original-test262-campaign-report/1'||report.baseCatalogDigest!==baseCatalog.digest)
    throw new TypeError('Original Test262 report changed its frozen inventory');
  if(report.baseCatalog!==undefined&&conformanceDigest(report.baseCatalog)!==conformanceDigest(baseCatalog))
    throw new TypeError('Original Test262 report changed its retained source catalog');
  verifyDeclaredEcma262Specification(report.profile?.specification);
  const catalog=bindTest262CatalogProfile(baseCatalog,report.profile);
  if(report.catalogDigest!==catalog.digest)throw new TypeError('Original Test262 report changed its execution profile');
  validateTest262Campaign(report.campaign,{catalog,implementation});
  if(conformanceDigest(report.runPolicy)!==conformanceDigest(implementation.runPolicy))
    throw new TypeError('Original Test262 report changed its worker policy');
  if(conformanceDigest(summarizeTest262Campaign(report.campaign))!==conformanceDigest(report.summary)||
     conformanceDigest(report.claims)!==conformanceDigest(createTest262CampaignReport({
       baseCatalog,catalog,campaign:report.campaign,runPolicy:report.runPolicy}).claims))
    throw new TypeError('Original Test262 report summary or admission claims changed');
  return {valid:true,catalog};
}

/** Disposable native process plus VM/owned step budgets, with no access token
 * environment passed to a reference worker. A worker timeout never passes a
 * guest negative test. Inputs must already carry exact catalog identities. */
export function runOriginalTest262Worker({authority,options,implementation,wallTimeoutMs=10000,heapMb=384,signal}={}){
  if(!['owned','reference'].includes(authority)||!Number.isSafeInteger(wallTimeoutMs)||wallTimeoutMs<10||wallTimeoutMs>2147483647||
     !Number.isSafeInteger(heapMb)||heapMb<64||heapMb>4096||
     signal!==undefined&&(!(signal instanceof AbortSignal)))
    throw new TypeError('Invalid isolated Test262 worker policy');
  return new Promise(resolveResult=>{
    const worker=fileURLToPath(new URL('../../tools/test262-original-worker.mjs',import.meta.url));
    const env=workerEnvironment(),args=['--max-old-space-size='+heapMb,worker];
    const settings={authority,wallTimeoutMs,heapMb,command:[process.execPath,...args],environment:env};
    if(signal?.aborted){resolveResult({status:'interrupted',reason:'Test262 worker was cancelled before dispatch',
      phase:'worker',caseId:options.variant.id,executionPerformed:false,
      worker:{...settings,started:false,exitCode:null,signal:null}});return;}
    const processHandle=spawn(process.execPath,args,{cwd:root,env,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',expired=false,oversized=false,spawnError=null,cancelled=false,started=false;
    const cancel=()=>{cancelled=true;processHandle.kill('SIGKILL');};
    signal?.addEventListener('abort',cancel,{once:true});
    processHandle.on('spawn',()=>{started=true;});
    const timer=setTimeout(()=>{expired=true;processHandle.kill('SIGKILL');},wallTimeoutMs);
    processHandle.on('error',error=>{spawnError=error;});
    processHandle.stdin.on('error',()=>{});
    processHandle.stdout.on('data',data=>{
      stdout+=data.toString('utf8');
      if(stdout.length>16*1024*1024){oversized=true;processHandle.kill('SIGKILL');}
    });
    processHandle.stderr.on('data',data=>{if(stderr.length<8192)stderr+=data.toString('utf8').slice(0,8192-stderr.length);});
    processHandle.on('close',(code,exitSignal)=>{
      clearTimeout(timer);
      signal?.removeEventListener('abort',cancel);
      const worker={...settings,started,exitCode:code,signal:exitSignal};
      const failure=(status,reason)=>resolveResult({status,reason,phase:'worker',caseId:options.variant.id,
        executionPerformed:started?null:false,worker});
      if(cancelled)return failure('interrupted','Test262 worker was cancelled before a complete result was received');
      if(expired||oversized||/heap out of memory|allocation failed/i.test(stderr))
        return failure('resource_limited',expired?'Isolated worker wall-time budget exceeded':oversized?
          'Isolated worker output budget exceeded':'Isolated worker heap budget exceeded');
      if(spawnError)return failure('environment_unavailable','Test262 worker could not start: '+spawnError.message);
      if(code!==0){
        let diagnostic;try{diagnostic=JSON.parse(stdout);}catch{}
        return failure('infrastructure_error',diagnostic?.caseId===options.variant.id&&diagnostic.status==='infrastructure_error'?
          diagnostic.reason:'Test262 worker did not complete successfully');
      }
      try{
        const result=JSON.parse(stdout);
        if(result.caseId!==options.variant.id||!['passed','failed','unsupported','resource_limited','environment_unavailable','infrastructure_error'].includes(result.status))
          throw new TypeError('Invalid worker result identity');
        resolveResult({...result,worker});
      }catch{return failure('infrastructure_error','Test262 worker returned an invalid result');}
    });
    processHandle.stdin.end(JSON.stringify({authority,options,implementation}));
  });
}
