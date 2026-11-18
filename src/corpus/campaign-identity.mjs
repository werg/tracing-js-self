import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256,identityHash} from './campaign-store.mjs';

export function generationIdentity(root,{producerRevision,recipe,native=null,bounds={},registryDigest=null}={}){
  const files=[];
  function walk(directory){
    for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=join(directory,entry.name);
      if(entry.isDirectory())walk(path);
      else if(entry.isFile()&&/\.(?:mjs|js|json)$/.test(entry.name))
        files.push([relative(root,path),sha256(readFileSync(path))]);
    }
  }
  for(const directory of ['src','tools','contracts','profiles'])walk(join(root,directory));
  for(const entry of readdirSync(join(root,'corpus'),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))
    if(entry.isFile()&&/\.(?:mjs|json)$/.test(entry.name))files.push(['corpus/'+entry.name,sha256(readFileSync(join(root,'corpus',entry.name)))]);
  const dependencies=Object.fromEntries(['acorn','typescript'].map(name=>[name,
    JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'),'utf8')).version]));
  let consumerEnvironment=null;
  if(native){
    const python=execFileSync(native.python,['-c',
      'import importlib.metadata,json,platform,sys; print(json.dumps({"python":sys.version,"platform":platform.platform(),"packages":sorted((d.metadata["Name"],d.version) for d in importlib.metadata.distributions())}))'],
    {encoding:'utf8',timeout:30000,maxBuffer:4194304});
    const tree=execFileSync('git',['-C',native.megatoken,'ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)
      .map(path=>[path,sha256(readFileSync(join(native.megatoken,path)))]);
    consumerEnvironment={...JSON.parse(python),sourceTreeDigest:identityHash(tree)};
  }
  return {schema:'semantic-generation-identity/1',producerRevision,recipe,
    producerSourceTreeDigest:identityHash(files),dependencyLockSha256:sha256(readFileSync(join(root,'package-lock.json'))),
    runtime:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,
      dependencies,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale:Intl.DateTimeFormat().resolvedOptions().locale},
    nativePolicy:native?.policy??null,consumerEnvironment,bounds,registryDigest,
    trace:'semantic-trace/5',profile:'training-js/1',trust:'authored-or-pinned-reviewed-source-only'};
}
