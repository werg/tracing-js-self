import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';

const [source,output]=process.argv.slice(2);
if(!source||!output)throw new Error('Usage: node verify-superseded-inputs.mjs SOURCE NEW_OUTPUT');
const root=path.resolve(source),out=path.resolve(output),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=name=>JSON.parse(fs.readFileSync(name,'utf8'));
const lines=name=>fs.readFileSync(name,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const canonical=value=>{
  const encode=(item,seen)=>{
    if(item===undefined)return ['undefined'];
    if(typeof item==='number'&&(!Number.isFinite(item)||Object.is(item,-0)))return ['number',Object.is(item,-0)?'-0':String(item)];
    if(item===null||typeof item!=='object')return ['scalar',item];
    if(seen.has(item))return ['reference',seen.get(item)];
    const index=seen.size;seen.set(item,index);
    if(Array.isArray(item))return ['array',index,item.map(value=>encode(value,seen))];
    return ['object',index,Object.keys(item).sort().map(key=>[key,encode(item[key],seen)])];
  };
  return JSON.stringify(encode(value,new Map()));
};
fs.mkdirSync(out);
const populations=[];
for(const population of ['native-all','native-interoperability']){
  const directory=path.join(root,population),rows=lines(path.join(directory,'attempts.jsonl')),
    campaign=read(path.join(directory,'progress/campaign.json')),entries=lines(path.join(directory,'progress/campaign.jsonl'));
  assert.equal(sha(canonical(campaign.identity)),campaign.identityDigest);
  assert.equal(rows.length,entries.length);
  let previous=null;
  for(const [index,entry] of entries.entries()){
    const {entryDigest,...payload}=entry;
    assert.equal(entry.previous,previous);previous=entryDigest;
    assert.equal(entry.campaignDigest,campaign.identityDigest);
    assert.equal(sha(canonical(payload)),entryDigest);
    const objects={};
    for(const name of ['candidate','result']){
      const ref=entry[name],raw=fs.readFileSync(path.join(directory,'progress',ref.path));
      assert.equal(raw.length,ref.bytes);assert.equal(sha(raw),ref.sha256);
      const content=ref.encoding==='gzip'?gunzipSync(raw):raw;
      assert.equal(content.length,ref.uncompressedBytes);assert.equal(sha(content),ref.contentSha256);
      objects[name]=JSON.parse(content);
    }
    assert.deepEqual(objects.result.row,rows[index]);
    for(const [name,digest] of Object.entries(objects.result.artifacts))
      assert.equal(sha(fs.readFileSync(path.join(directory,name))),digest,name);
  }
  const destination=path.join(out,population);fs.mkdirSync(destination);
  const bindings=[];
  for(const row of rows){
    assert.equal(row.native,'passed');assert.equal(row.source,'passed');
    const artifact=read(path.join(directory,row.sourceArtifact)),receipt=read(path.join(directory,row.id+'.native.json'));
    assert.deepEqual(receipt,row.nativeReceipt);
    assert.equal(receipt.consumerRevision,campaign.identity.nativePolicy.consumerRevision);
    assert.equal(receipt.sourceVerification.producerRevision,campaign.identity.producerRevision);
    const bytes=JSON.stringify(artifact)+'\n',digest=sha(bytes),name=row.id+'.native-input.json';
    assert.equal(digest,receipt.sourceVerification.artifactSha256);
    fs.writeFileSync(path.join(destination,name),bytes,{flag:'wx'});
    bindings.push({id:row.id,sourceArtifact:row.sourceArtifact,nativeInput:population+'/'+name,
      nativeInputSha256:digest,nativeInputBytes:Buffer.byteLength(bytes)});
  }
  populations.push({population,producerRevision:campaign.identity.producerRevision,
    consumerRevision:campaign.identity.nativePolicy.consumerRevision,committedAttempts:rows.length,
    journalDigest:previous,journalHashesAndLinks:true,journalObjectHashes:true,
    journalRowsEqualAttemptLog:true,committedArtifactHashes:true,exactNativeInputsChecked:bindings.length,bindings});
}
const result={schema:'superseded-prefix-integrity-check/1',status:'superseded-not-final-evidence',
  freshNativeExecution:false,nativeInputEncoding:'JSON.stringify(source) plus newline, checked against each exact retained sourceVerification receipt',
  populations,optimizerSteps:0,learningClaim:null};
fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({populations:populations.map(({population,committedAttempts,exactNativeInputsChecked})=>({population,committedAttempts,exactNativeInputsChecked}))}));
