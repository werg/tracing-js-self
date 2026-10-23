// Source clone audit for independently verified owned execution families.
// Lexical similarity is a leakage guard, never proof of semantic equivalence.
import {tokenizer} from 'acorn';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const digest=/^[0-9a-f]{64}$/;
export function fingerprintOwnedSource(source){
 if(typeof source!=='string'||!source||source.length>2000000)
  throw new TypeError('Invalid or oversized owned source');
 const scanner=tokenizer(source,{ecmaVersion:'latest',sourceType:'script'});
 const exact=[],alpha=[],names=new Map();
 for(;;){
  const token=scanner.getToken(),kind=token.type.label;
  if(kind==='eof')break;
  if(exact.length>=50000)throw new Error('Excessive owned source tokens');
  const raw=source.slice(token.start,token.end);
  const item=kind==='name'?'name:'+token.value:
   ['string','num','bigint'].includes(kind)?kind+':'+String(token.value):
   kind+':'+raw;
  exact.push(item);
  if(kind==='name'){
   if(!names.has(token.value))names.set(token.value,names.size);
   alpha.push('id:'+names.get(token.value));
  }else alpha.push(item);
 }
 if(!exact.length)throw new Error('Empty owned source');
 const shingles=new Set();
 for(let i=0;i+5<=alpha.length;i++)shingles.add(hash(alpha.slice(i,i+5)).slice(0,24));
 return {schema:'owned-source-fingerprint/1',tokenCount:exact.length,
  exactHash:hash(exact),alphaHash:hash(alpha),shingles:[...shingles].sort()};
}
const valid=x=>x?.schema==='owned-source-fingerprint/1'&&
 Number.isSafeInteger(x.tokenCount)&&x.tokenCount>0&&x.tokenCount<=50000&&
 digest.test(x.exactHash??'')&&digest.test(x.alphaHash??'')&&
 Array.isArray(x.shingles)&&x.shingles.length<=50000&&
 x.shingles.every(s=>typeof s==='string'&&/^[a-f0-9]{24}$/.test(s));
function similarity(a,b){
 const x=a.shingles,y=b.shingles;
 let i=0,j=0,n=0;
 while(i<x.length&&j<y.length){
  if(x[i]===y[j]){n++;i++;j++;}
  else if(x[i]<y[j])i++;else j++;
 }
 return n/(x.length+y.length-n||1);
}
export function clusterOwnedSources(profiles,{nearThreshold=0.92}={}){
 if(!Array.isArray(profiles)||profiles.length>10000||
   !Number.isFinite(nearThreshold)||nearThreshold<0.8||nearThreshold>1)
  throw new TypeError('Invalid source cluster inventory');
 const families=new Map();
 for(const row of profiles){
  if(typeof row?.family!=='string'||!row.family||
    !['train','validation','test'].includes(row.split)||!valid(row.sourceFingerprint))
   throw new TypeError('Invalid owned source profile');
  const prev=families.get(row.family);
  if(prev){
   if(prev.split!==row.split||
      prev.fp.exactHash!==row.sourceFingerprint.exactHash)
    throw new Error('Conflicting owned source-family identity or split');
  }else families.set(row.family,{family:row.family,split:row.split,
   fp:row.sourceFingerprint});
 }
 const rows=[...families.values()].sort((a,b)=>a.family.localeCompare(b.family));
 const parents=rows.map((_,i)=>i);
 const find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
 const union=(i,j)=>{i=find(i);j=find(j);if(i!==j)parents[Math.max(i,j)]=Math.min(i,j);};
 const exact=new Map(),alpha=new Map();
 for(let i=0;i<rows.length;i++){
  const f=rows[i].fp;
  for(const [index,key] of [[exact,f.exactHash],
   [alpha,f.tokenCount>=20?f.alphaHash:null]]){
   if(!key)continue;
   if(index.has(key))union(i,index.get(key));else index.set(key,i);
  }
 }
 const postings=new Map();
 for(let i=0;i<rows.length;i++)if(rows[i].fp.tokenCount>=60){
  for(const shingle of rows[i].fp.shingles){
   const ids=postings.get(shingle)??[];
   if(ids.length<=128)ids.push(i);
   postings.set(shingle,ids);
  }
 }
 const candidates=new Map();
 for(const ids of postings.values()){
  if(ids.length>128)continue;
  for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++){
   const key=ids[a]+':'+ids[b];
   candidates.set(key,(candidates.get(key)??0)+1);
   if(candidates.size>100000)throw new Error('Source-clone comparison budget exceeded');
  }
 }
 let nearPairs=0;
 for(const [key,shared] of candidates){
  if(shared<10)continue;
  const [i,j]=key.split(':').map(Number),a=rows[i].fp,b=rows[j].fp;
  if(Math.min(a.tokenCount,b.tokenCount)/Math.max(a.tokenCount,b.tokenCount)<0.85)
   continue;
  if(similarity(a,b)>=nearThreshold){nearPairs++;union(i,j);}
 }
 const groups=new Map(),keyByFamily={};
 for(let i=0;i<rows.length;i++){
  const root=find(i),members=groups.get(root)??[];
  members.push(rows[i]);groups.set(root,members);
 }
 const clusters=[...groups.values()].map(group=>{
  const members=group.map(x=>x.family).sort();
  const splits=[...new Set(group.map(x=>x.split))].sort();
  if(splits.length>1)throw new Error('Potential source-clone train/evaluation leakage: '+
   members.join(', ')+' ('+splits.join('/')+')');
  const id=hash(members).slice(0,24);
  for(const member of members)keyByFamily[member]=id;
  return {id,members,split:splits[0]};
 }).sort((a,b)=>a.members[0].localeCompare(b.members[0]));
 return {schema:'owned-source-clusters/1',distinctFamilies:rows.length,
  distinctSourceClusters:clusters.length,nearPairs,
  clusters:clusters.filter(x=>x.members.length>1),keyByFamily,
  warnings:['Source-token similarity is a lexical heuristic, not a proof of semantic equivalence.',
   'Heuristic near-duplicate detection can miss altered or short program clones.']};
}
