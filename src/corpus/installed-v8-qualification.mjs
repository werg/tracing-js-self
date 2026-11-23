// Complete npm installation evidence. This driver may read the checkout to
// declare inputs; guest verification runs only in the separately installed app.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {cp,mkdir,readFile,readdir,readlink,lstat,writeFile,rm,access,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {generationEnvironment} from './generation-process.mjs';
import {readDependencyLock,PACKAGED_DEPENDENCY_LOCK} from '../dependency-lock.js';

export const LEGACY_V8_CLIENT_FILES=Object.freeze([
  ...['format','trace-text','harness-v4','controller','render','model-driver','effectful-compiler',
    'effectful-admit','effectful-session','admission-identity'].map(name=>'src/training/'+name+'.js'),
  ...['trace-codec','detailed-v7','causal-lm-v7','compiler','controller','harness','dataset-v7','native-v7']
    .map(name=>'src/semantic/'+name+'.js')
]);
export const installedSha256=value=>createHash('sha256').update(value).digest('hex');
export async function installedFileHash(path,algorithm='sha256'){
  const hash=createHash(algorithm);for await(const bytes of createReadStream(path))hash.update(bytes);
  return hash.digest('hex');
}
export async function installedFileTree(directory){
  const files=[];
  async function walk(path,prefix=''){
    for(const name of (await readdir(path)).sort()){
      const absolute=join(path,name),file=prefix+name,stat=await lstat(absolute);
      if(stat.isDirectory())await walk(absolute,file+'/');
      else if(stat.isSymbolicLink())files.push({path:file,kind:'symlink',target:await readlink(absolute)});
      else if(stat.isFile())files.push({path:file,kind:'file',bytes:stat.size,sha256:await installedFileHash(absolute)});
      else throw new TypeError('Unsupported package file kind: '+file);
    }
  }
  await walk(directory);return {files,sha256:installedSha256(JSON.stringify(files))};
}
export async function verifyInstalledArchiveIntegrity(path,integrity){
  if(typeof integrity!=='string')throw new TypeError('A locked dependency archive requires SRI');
  const tokens=integrity.split(/\s+/).map(value=>/^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+=*)$/.exec(value)).filter(Boolean);
  const strongest=['sha512','sha384','sha256','sha1'].find(algorithm=>tokens.some(token=>token[1]===algorithm));
  if(!strongest)throw new TypeError('Unsupported locked dependency archive integrity');
  const digest=Buffer.from(await installedFileHash(path,strongest),'hex').toString('base64');
  if(!tokens.some(token=>token[1]===strongest&&token[2]===digest))throw new Error('Locked dependency archive integrity mismatch: '+path);
  return true;
}
function lockedDependencyUrl(entry,name){
  if(typeof entry?.resolved!=='string')throw new TypeError('Locked dependency has no resolved tarball URL: '+name);
  let value;
  try{value=new URL(entry.resolved);}catch{throw new TypeError('Locked dependency URL is invalid: '+name);}
  if(!['http:','https:'].includes(value.protocol)||!value.hostname||value.username||value.password||
    value.search||value.hash||value.href!==entry.resolved)
    throw new TypeError('Locked dependency URL must be canonical HTTP(S) without credentials or fragments: '+name);
  return entry.resolved;
}
const inside=(root,path)=>{const rel=relative(root,path);return rel===''||!rel.startsWith('..'+sep)&&rel!=='..'&&!rel.startsWith(sep);};
function boundedInteger(value,minimum,maximum,name){
  if(!Number.isSafeInteger(value)||value<minimum||value>maximum)throw new TypeError('Invalid '+name);return value;
}
export function runInstalledCommand(command,args,{cwd,env=generationEnvironment(),timeoutMs=120000,maxBytes=16777216}={}){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false,
      detached:process.platform!=='win32'}),output=[],errors=[];let bytes=0,done=false,problem=null;
    const stop=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const fail=error=>{if(!problem){problem=error;stop();}};
    const timer=setTimeout(()=>fail(new Error(command+' exceeded '+timeoutMs+' ms')),timeoutMs);
    const collect=(target,chunk)=>{bytes+=chunk.length;if(bytes>maxBytes)fail(new Error(command+' output bound exceeded'));else target.push(chunk);};
    child.stdout.on('data',chunk=>collect(output,chunk));child.stderr.on('data',chunk=>collect(errors,chunk));
    child.once('error',error=>{if(done)return;done=true;clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{
      if(done)return;done=true;clearTimeout(timer);
      const stdout=Buffer.concat(output).toString('utf8'),stderr=Buffer.concat(errors).toString('utf8');
      if(problem||code!==0)reject(problem??new Error(command+' exited '+(signal??code)+': '+stderr.slice(-8192)));
      else resolveRun({stdout,stderr});
    });
  });
}

export async function prepareInstalledV8Package({root,output,dependencyArchiveDirectory=null,dependencyCache=null,
  timeoutMs=300000,legacyFiles=LEGACY_V8_CLIENT_FILES}={}){
  root=await realpath(resolve(root));output=resolve(output);
  if(inside(root,output))throw new Error('Installed qualification output must be outside the source checkout');
  const command=(name,args,options={})=>runInstalledCommand(name,args,{cwd:root,timeoutMs,...options});
  const status=(await command('git',['status','--porcelain=v1','--untracked-files=all'])).stdout.trim();
  if(status)throw new Error('Installed qualification requires a completely committed clean checkout');
  const revision=(await command('git',['rev-parse','HEAD'])).stdout.trim(),
    tree=(await command('git',['rev-parse','HEAD^{tree}'])).stdout.trim(),
    trackedFiles=(await command('git',['ls-tree','-r','--name-only','-z','HEAD'])).stdout.split('\0').filter(Boolean);
  const archives=join(output,'archives'),work=join(output,'.work'),staging=join(work,'source'),
    application=join(work,'application'),snapshot=join(work,'source.tar');
  await mkdir(archives,{recursive:true});await mkdir(staging,{recursive:true});await mkdir(application,{recursive:true});
  // git archive materializes every tracked input, including skip-worktree files
  // in a sparse checkout. No hand-selected runtime-asset staging is permitted.
  await command('git',['archive','--format=tar','--output',snapshot,revision]);
  const sourceArchiveSha256=await installedFileHash(snapshot);
  await command('tar',['-xf',snapshot,'-C',staging]);await rm(snapshot);
  const metadata=JSON.parse(await readFile(join(staging,'package.json'),'utf8')),
    lockBytes=readDependencyLock(staging),lock=JSON.parse(lockBytes);
  if(Object.keys(metadata.scripts??{}).some(name=>['prepack','prepare','postpack'].includes(name)))
    throw new Error('Complete package gate requires lifecycle-free packaging; pack hooks are not executed');
  if(lock.lockfileVersion!==3||lock.packages?.['']?.name!==metadata.name)
    throw new Error('Exact npm dependency lock metadata is required');
  const inheritedCache=resolve(dependencyCache??(await command('npm',['config','get','cache'])).stdout.trim());
  const npmEnv={...generationEnvironment(),npm_config_cache:inheritedCache,npm_config_offline:'true',
    npm_config_ignore_scripts:'true',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false'};
  const packed=await command('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],
    {cwd:staging,env:npmEnv});
  const manifest=Object.values(JSON.parse(packed.stdout));
  if(manifest.length!==1||!manifest[0].files.some(file=>file.path===PACKAGED_DEPENDENCY_LOCK)||
    manifest[0].files.some(file=>file.path==='package-lock.json'))throw new Error('Incomplete publishable package lock evidence');
  const pack=manifest[0],packageArchive=join(archives,pack.filename);
  if(dirname(packageArchive)!==archives)throw new Error('Unsafe npm package archive name');
  await verifyInstalledArchiveIntegrity(packageArchive,pack.integrity);
  await writeFile(join(output,'npm-pack.json'),JSON.stringify(pack,null,2)+'\n');
  await writeFile(join(output,'package-lock.json'),lockBytes);
  await rm(staging,{recursive:true,force:true});
  const packageCheck=join(work,'package-check');await mkdir(packageCheck);
  await command('tar',['-xzf',packageArchive,'-C',packageCheck]);
  const packageTree=await installedFileTree(join(packageCheck,'package'));
  await rm(packageCheck,{recursive:true,force:true});
  const dependencies=[];
  for(const [path,entry]of Object.entries(lock.packages).filter(([path,entry])=>path&&!entry.dev)){
    if(!/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(path)||entry.link)
      throw new Error('Dependency archive layout requires an explicit supported top-level package: '+path);
    const name=path.slice('node_modules/'.length),filename=name.replace(/^@/,'').replaceAll('/','-')+'-'+entry.version+'.tgz',
      archive=join(archives,filename),resolved=lockedDependencyUrl(entry,name);
    let source;
    if(dependencyArchiveDirectory){
      await cp(join(resolve(dependencyArchiveDirectory),filename),archive);source='provided-locked-archive';
    }else{
      // npm 12 classifies pack's second fetch of this explicit archive as a
      // non-root request. This one offline command consumes only the locked
      // URL from cache; it performs no dependency install or lifecycle scripts.
      const result=await command('npm',['pack',resolved,'--offline','--allow-remote=all',
        '--ignore-scripts','--json','--pack-destination',archives],{cwd:application,env:npmEnv});
      const packedDependency=Object.values(JSON.parse(result.stdout));
      if(packedDependency.length!==1||packedDependency[0].filename!==filename)
        throw new Error('Unexpected dependency archive identity for locked URL: '+name);
      source='offline-locked-tarball-url';
    }
    await verifyInstalledArchiveIntegrity(archive,entry.integrity);
    dependencies.push({name,version:entry.version,lockIntegrity:entry.integrity,archive:'archives/'+filename,
      resolved:entry.resolved,sha256:await installedFileHash(archive),source});
  }
  if(!Object.keys(metadata.dependencies??{}).every(name=>dependencies.some(row=>row.name===name)))
    throw new Error('A required production dependency is absent from the locked archive inventory');
  await writeFile(join(application,'package.json'),JSON.stringify({name:'installed-v8-qualification',private:true,type:'module'})+'\n');
  const installEnv={...npmEnv,npm_config_cache:join(work,'empty-install-cache')};
  await command('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--omit=dev','--save-exact','--allow-file=root',
    packageArchive,...dependencies.map(row=>join(output,row.archive))],{cwd:application,env:installEnv});
  const installed=join(application,'node_modules',metadata.name),before=await installedFileTree(installed);
  if(before.sha256!==packageTree.sha256)throw new Error('Installed package files differ from the complete npm archive');
  const installedLock=await readFile(join(installed,PACKAGED_DEPENDENCY_LOCK));
  if(!lockBytes.equals(installedLock)||!Buffer.from(JSON.stringify(metadata)).equals(
    Buffer.from(JSON.stringify(JSON.parse(await readFile(join(installed,'package.json'),'utf8'))))))
    throw new Error('Installed package metadata or dependency lock bytes differ');
  for(const dependency of dependencies){
    const path=join(application,'node_modules',dependency.name),value=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
    if(value.name!==dependency.name||value.version!==dependency.version)throw new Error('Installed dependency version differs');
    const stage=join(work,'dependency-check');await mkdir(stage);
    try{
      await command('tar',['-xzf',join(output,dependency.archive),'-C',stage]);
      const expected=await installedFileTree(join(stage,'package')),actual=await installedFileTree(path);
      if(expected.sha256!==actual.sha256)throw new Error('Installed dependency bytes differ from its locked archive: '+dependency.name);
      dependency.installedTree=actual;
    }finally{await rm(stage,{recursive:true,force:true});}
  }
  const removed=[];
  for(const path of legacyFiles){
    const absolute=join(installed,path);
    if(!inside(installed,absolute))throw new Error('Unsafe legacy client path');
    removed.push({path,sha256:await installedFileHash(absolute)});await rm(absolute);
    try{await access(absolute);throw new Error('Legacy client remains installed: '+path);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const after=await installedFileTree(installed),worker=join(application,'installed-v8-worker.mjs');
  await cp(join(installed,'tools','installed-v8-worker.mjs'),worker);
  await cp(join(application,'package.json'),join(output,'installed-application-package.json'));
  await cp(join(application,'package-lock.json'),join(output,'installed-application-lock.json'));
  await rm(join(work,'empty-install-cache'),{recursive:true,force:true});
  const evidence={schema:'semantic-installed-v8-package/1',producerRevision:revision,gitTree:tree,
    cleanCheckout:true,source:{method:'complete-git-archive',trackedFiles,sourceArchiveSha256},
    package:{name:metadata.name,version:metadata.version,archive:'archives/'+pack.filename,
      sha256:await installedFileHash(packageArchive),integrity:pack.integrity,packManifest:'npm-pack.json',
      packManifestSha256:await installedFileHash(join(output,'npm-pack.json'))},
    packageLockSha256:installedSha256(lockBytes),applicationLockSha256:await installedFileHash(join(application,'package-lock.json')),
    dependencies,installation:{offline:true,ignoreScripts:true,emptyInstallCache:true,legacyClientsRemoved:removed,
      packageBeforeRemoval:before,packageAfterRemoval:after},
    runtime:{node:process.version,v8:process.versions.v8,npm:(await command('npm',['--version'])).stdout.trim(),
      platform:process.platform,arch:process.arch}};
  await writeFile(join(output,'package-installation.json'),JSON.stringify(evidence,null,2)+'\n');
  return {evidence,application,installed,worker};
}

export async function restoreInstalledV8Package({output}={}){
  output=resolve(output);const evidence=JSON.parse(await readFile(join(output,'package-installation.json'),'utf8')),
    application=join(output,'.work','application'),installed=join(application,'node_modules',evidence.package.name),
    worker=join(application,'installed-v8-worker.mjs');
  if(evidence.schema!=='semantic-installed-v8-package/1'||!evidence.installation?.offline||!evidence.cleanCheckout)
    throw new Error('Incomplete installed qualification package identity');
  if(await installedFileHash(join(output,evidence.package.archive))!==evidence.package.sha256||
    await installedFileHash(join(output,'npm-pack.json'))!==evidence.package.packManifestSha256||
    await installedFileHash(join(output,'package-lock.json'))!==evidence.packageLockSha256||
    await installedFileHash(join(installed,PACKAGED_DEPENDENCY_LOCK))!==evidence.packageLockSha256||
    await installedFileHash(join(output,'installed-application-lock.json'))!==evidence.applicationLockSha256||
    await installedFileHash(join(application,'package-lock.json'))!==evidence.applicationLockSha256||
    (await installedFileTree(installed)).sha256!==evidence.installation.packageAfterRemoval.sha256)
    throw new Error('Installed package or archived evidence changed; cannot resume');
  for(const dependency of evidence.dependencies)if(await installedFileHash(join(output,dependency.archive))!==dependency.sha256||
    (await installedFileTree(join(application,'node_modules',dependency.name))).sha256!==dependency.installedTree.sha256)
    throw new Error('Installed dependency or archive changed; cannot resume');
  if(await installedFileHash(worker)!==await installedFileHash(join(installed,'tools','installed-v8-worker.mjs')))
    throw new Error('Installed qualification worker changed');
  return {evidence,application,installed,worker};
}

export async function runInstalledV8Worker({application,installed,worker,task,producerRevision,output,
  timeoutMs=120000,memoryMb=768,maxOutputBytes=268435456,mode='case',candidate=null}={}){
  boundedInteger(timeoutMs,10,3600000,'installed worker timeout');boundedInteger(memoryMb,64,8192,'installed worker memory');
  boundedInteger(maxOutputBytes,1024,1073741824,'installed worker output bound');await mkdir(dirname(output),{recursive:true});
  return new Promise(resolveRun=>{
    const start=performance.now(),child=spawn(process.execPath,['--max-old-space-size='+memoryMb,worker],
      {cwd:application,env:generationEnvironment(),stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32'});
    let stdout='',stderr='',failure=null,closed=false;
    const stop=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const fail=(status,reason)=>{if(!failure){failure={status,reason};stop();}};
    const timer=setTimeout(()=>fail('worker_timeout','Installed worker exceeded '+timeoutMs+' ms'),timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>16384)fail('worker_output_limit','Installed worker metadata bound');});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
    child.on('error',error=>fail('worker_failure',error.message));
    child.stdin.on('error',error=>fail('worker_failure',error.message));
    child.once('close',async(code,signal)=>{
      if(closed)return;closed=true;clearTimeout(timer);
      let result,peakRssBytes=null;
      try{
        if(failure)result=failure;
        else if(code!==0)result={status:'worker_failure',reason:'Installed worker exited '+(signal??code)+': '+stderr};
        else{
          const metadata=JSON.parse(stdout),bytes=await readFile(output);
          if(bytes.length>maxOutputBytes)throw new Error('Compressed installed evidence exceeded bound');
          result=JSON.parse(gunzipSync(bytes,{maxOutputLength:maxOutputBytes}).toString('utf8'));
          if(typeof result.status!=='string'||!Number.isFinite(metadata.peakRssBytes))throw new Error('Invalid installed worker result');
          peakRssBytes=metadata.peakRssBytes;
        }
      }catch(error){result={status:'worker_failure',reason:error.message};}
      resolveRun({result,peakRssBytes,durationMs:performance.now()-start});
    });
    child.stdin.end(JSON.stringify({mode,task,producerRevision,packageRoot:installed,output,maxOutputBytes,candidate})+'\n');
  });
}
