// Reuse the generation campaign's locked, hash-checked append log. Completed
// cases are reusable only at the same source, environment, policy and bounds.
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CampaignStore,sha256,atomicWrite} from './campaign-store.mjs';

const artifactName=/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export function openQualificationProgress(directory,identity,{resume=false}={}){
  directory=resolve(directory);
  if(!resume&&existsSync(directory))throw new Error('Qualification output already exists; use --resume or a new directory');
  if(resume&&!existsSync(join(directory,'progress','campaign.json')))
    throw new Error('Cannot resume output without a committed qualification identity');
  mkdirSync(directory,{recursive:true});
  const store=new CampaignStore(join(directory,'progress'),identity,{resume});
  const path=name=>{
    if(typeof name!=='string'||!artifactName.test(name))throw new TypeError('Unsafe qualification artifact name');
    return join(directory,name);
  };
  const digest=name=>sha256(readFileSync(path(name)));
  return {
    digest:store.identityDigest,
    save(name,value){
      const bytes=JSON.stringify(value,null,2)+'\n';
      atomicWrite(path(name),bytes);return sha256(bytes);
    },
    cached(id,task){
      const entry=store.cached(id,task);
      if(!entry)return null;
      const result=store.readObject(entry.result);
      for(const [name,expected] of Object.entries(result.artifacts))
        if(digest(name)!==expected)throw new Error('Completed qualification artifact changed: '+name);
      return result;
    },
    complete(id,task,row,names){
      const artifacts=Object.fromEntries(names.map(name=>[name,digest(name)]));
      store.record(id,task,{status:row.status,row,artifacts},row);
      return {status:row.status,row,artifacts};
    },
    close(){store.close();}
  };
}

export async function mapQualificationCases(cases,workers,execute){
  if(!Number.isSafeInteger(workers)||workers<1||workers>16)
    throw new TypeError('Qualification workers must be an integer from 1 to 16');
  const results=new Array(cases.length);let next=0,failed=false;
  const settled=await Promise.allSettled(Array.from({length:Math.min(workers,cases.length)},async()=>{
    for(;;){
      if(failed)return;
      const index=next++;if(index>=cases.length)return;
      try{results[index]=await execute(cases[index],index);}
      catch(error){failed=true;throw error;}
    }
  }));
  const rejection=settled.find(row=>row.status==='rejected');
  if(rejection)throw rejection.reason;
  return results;
}
