// Audit the bytes a learner actually predicts, alongside their readable view.
// This is an inspection report, not a new admission authority or trace format.
import {createHash} from 'node:crypto';
import {decodeWitness,WITNESS_VERSION} from './format.js';
import {renderWitness} from './render.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from './engineering-fixtures.js';
import {verifyEffectfulTrainingCase} from './effectful-admit.js';

const bytes=value=>Buffer.byteLength(value,'utf8');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const claims={
  bind:'The named source cell has the stated value at this step.',
  compute:'The stated expression evaluates to the result in committed public state.',
  choose:'The condition has the stated value and selects the stated path.',
  allocate:'A fresh identity with the stated kind and initial properties exists.',
  read:'The property has the stated presence and value at this step.',
  write:'The named property changes to the stated presence and value.',
  call:'The named guest call begins with the stated receiver and arguments.',
  transfer:'The stated abrupt completion transfers to the stated handler.',
  return:'The guest invocation returns the stated value.',
  throw:'The guest invocation throws the stated value.',
  request:'The stated source call requests this external operation and arguments.',
  promise:'The stated owned Promise transition occurs.',
  job:'The stated owned job transition occurs.',
  await:'The invocation suspends on this Promise with this continuation.',
  resume:'The invocation resumes with the already observed settlement.',
  end:'The invocation has the stated completion and no blocking pending work.',
  summarize:'The bounded source region has the stated result and executed path.'
};

const engineering=(id,categories)=>({
  ...structuredClone(EFFECTFUL_ENGINEERING_FIXTURES.find(row=>row.id===id)),categories
});
const pure=(id,categories,source,args=[])=>({
  id,family:'trace-gallery-'+id,categories,source,entry:'run',args,fixture:{calls:[]}
});
export const SEMANTIC_GALLERY_FIXTURES=Object.freeze([
  engineering('compound-pure',['expressions']),
  engineering('branch-1',['branches','async-observations']),
  pure('object-alias',['object-construction','aliases'],
    '"use strict";function run(){const box={n:2};const alias=box;alias.n=alias.n+1;return box.n;}'),
  pure('pure-helper',['helper-calls'],
    '"use strict";function increment(value){return value+1;}function run(n){return increment(n);}',[4]),
  pure('dense-loop',['loops'],
    '"use strict";function run(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}',[[2,3,4]]),
  pure('throw-finally',['throws','finally'],
    '"use strict";function run(){let answer=0;try{throw 2;}catch(error){answer=error+1;}finally{answer=answer+4;}return answer;}'),
  engineering('counter-0',['async-observations']),
  engineering('rejection-finally',['throws','finally','async-observations']),
  engineering('callback-captured-write',['callbacks','captured-state']),
  engineering('persistent-external-trigger',['callbacks','retained-state']),
  pure('redundant-cell-write',['local-state'],
    '"use strict";function run(n){let value=n;value=n;value=n;return value;}',[3])
]);

// Exact wire-byte accounting for the canonical v6 source-shaped target.
// The old kind/JSON field partition no longer describes the learned string.
export function auditWitnessBytes(line){
  const {kind}=decodeWitness(line);
  return {kind,total:bytes(line)};
}

export async function inspectSemanticEpisode(exported,{id,categories=[],tokenizer=null}={}){
  if(!Array.isArray(exported?.public?.timeline))throw new TypeError('A public episode is required');
  const timeline=exported.public.timeline,program=timeline.find(row=>row.kind==='program');
  if(!program)throw new TypeError('An exact observed source program is required');
  if(tokenizer&&(!tokenizer.identity||typeof tokenizer.identity.name!=='string'||
      !tokenizer.identity.name||!(typeof tokenizer.identity.revision==='string'&&tokenizer.identity.revision||
      typeof tokenizer.identity.digest==='string'&&tokenizer.identity.digest)||typeof tokenizer.encode!=='function'||
      typeof tokenizer.decode!=='function'))
    throw new TypeError('Tokenizer audit requires pinned identity, encode and decode');
  const certificateBySequence=new Map(
    (exported.sidecar?.compiler?.certificates??[]).map(row=>[row.sequence,row]));
  const records=[],prefix=[],kinds={};
  let generatedBytes=0,observations=0,generatedTokens=tokenizer?0:null;
  for(const row of timeline){
    if(row.kind==='semantic'){
      if(row.mode!=='generated')throw new TypeError('A semantic target is not marked generated');
      const decoded=decodeWitness(row.line),audit=auditWitnessBytes(row.line);
      const record={sequence:row.sequence,invocationId:row.invocationId,kind:decoded.kind,
        raw:row.line,readable:renderWitness(row.line),claim:claims[decoded.kind],
        targetMask:'generated',priorPublicRows:prefix.length,priorObservations:observations,
        publicPrefixDigest:digest(prefix),bytes:audit,
        privateCertificateRule:certificateBySequence.get(row.sequence)?.rule??null};
      if(!record.claim)throw new TypeError('Missing claim description for '+decoded.kind);
      if(tokenizer){
        const ids=await tokenizer.encode(row.line);
        if(!Array.isArray(ids)||!ids.every(Number.isSafeInteger))throw new TypeError('Invalid tokenizer IDs');
        if(await tokenizer.decode(ids)!==row.line)throw new Error('Tokenizer changes actual target bytes');
        record.tokenIds=ids;generatedTokens+=ids.length;
      }
      record.bytes={total:audit.total};
      records.push(record);kinds[decoded.kind]=(kinds[decoded.kind]??0)+1;
      generatedBytes+=audit.total;
    }else if(row.mode==='observed'){
      observations++;
      records.push({sequence:row.sequence,kind:row.kind,targetMask:'observed',
        ...(typeof row.line==='string'?{raw:row.line,readable:renderWitness(row.line)}:{}),
        observation:structuredClone(row)});
    }
    prefix.push(row);
  }
  return {id:id??program.entry,categories:[...categories],source:program.source,sourceDigest:program.digest,
    invocationInputs:timeline.filter(row=>row.kind==='invocation').map(row=>({
      entry:row.entry,invocationId:row.invocationId,inputGraph:row.inputGraph,activation:row.activation})),
    qualification:{status:exported.sidecar?.admission??'projected',
      independentSourceChecks:exported.sidecar?.reference?.sourceChecks??null,
      nativeAdmission:exported.sidecar?.admission==='admitted',
      boundary:'Private certificates, source checks and native admission are separate authorities; this gallery grants none.'},
    tokenization:tokenizer?{status:'measured',identity:structuredClone(tokenizer.identity),
      scope:'Each exact generated line encoded independently; excludes native transport and recurrent context.'}:
      {status:'unavailable',reason:'No qualified tokenizer adapter supplied; bytes are not token estimates.'},
    metrics:{generatedRecords:Object.values(kinds).reduce((a,b)=>a+b,0),
      generatedBytes,generatedTokens,transportFragments:null,observedRows:observations,kinds,
      byteDefinition:'Sum of the exact generated UTF-8 target lines; excludes transport framing and observed context.'},
    records};
}

export async function buildSemanticTraceGallery({fixtures=SEMANTIC_GALLERY_FIXTURES,
    tokenizer=null,projectionOptions={}}={}){
  const cases=[];
  for(const fixture of fixtures){
    const checked=await verifyEffectfulTrainingCase({...fixture,
      projectionOptions:{...fixture.projectionOptions,...projectionOptions}});
    if(!['locally_verified','admitted'].includes(checked.status))
      throw new Error('Gallery fixture '+fixture.id+' failed: '+checked.status+' '+checked.reason);
    cases.push(await inspectSemanticEpisode(checked.exported,{id:fixture.id,
      categories:fixture.categories,tokenizer}));
  }
  return {schema:'semantic-target-gallery/2',representation:WITNESS_VERSION,
    purpose:'Actual target inspection; no model-learning or native-qualification claim.',
    projectionOptions:structuredClone(projectionOptions),
    categories:[...new Set(cases.flatMap(row=>row.categories))].sort(),
    totals:{cases:cases.length,generatedRecords:cases.reduce((n,row)=>n+row.metrics.generatedRecords,0),
      generatedBytes:cases.reduce((n,row)=>n+row.metrics.generatedBytes,0),
      generatedTokens:tokenizer?cases.reduce((n,row)=>n+row.metrics.generatedTokens,0):null},cases};
}

function targetLines(row){
  if(!Array.isArray(row?.records))throw new TypeError('Gallery case must retain its exact target lines');
  return row.records.filter(record=>record.targetMask==='generated').map(record=>{
    if(typeof record.raw!=='string')throw new TypeError('Generated target raw text is missing');
    return record.raw;
  });
}

export function compareSemanticGalleryToV5(gallery,archivedV5,{v5TokenCounts=null}={}){
  if(gallery?.representation!==WITNESS_VERSION||archivedV5?.representation!=='semantic-trace/5'||
     !Array.isArray(gallery.cases)||!Array.isArray(archivedV5.cases))
    throw new TypeError('The comparison requires current v6 targets and archived raw v5 targets');
  const oldById=new Map(archivedV5.cases.map(row=>[row.id,row]));
  const cases=gallery.cases.map(current=>{
    const old=oldById.get(current.id);
    if(!old)throw new TypeError('The archived v5 gallery is missing case '+current.id);
    const oldLines=targetLines(old),currentLines=targetLines(current);
    const oldBytes=oldLines.reduce((total,line)=>total+bytes(line),0);
    const currentBytes=currentLines.reduce((total,line)=>total+bytes(line),0);
    if(oldBytes!==old.metrics.generatedBytes||currentBytes!==current.metrics.generatedBytes)
      throw new TypeError('Stored raw target bytes disagree with gallery metrics for '+current.id);
    const v5Tokens=v5TokenCounts?.[current.id]??old.metrics.generatedTokens??null;
    const v6Tokens=current.metrics.generatedTokens??null;
    return {id:current.id,
      v5:{generatedRecords:oldLines.length,generatedBytes:oldBytes,generatedTokens:v5Tokens},
      v6:{generatedRecords:currentLines.length,generatedBytes:currentBytes,generatedTokens:v6Tokens},
      delta:{generatedRecords:currentLines.length-oldLines.length,
        generatedBytes:currentBytes-oldBytes,
        generatedTokens:v5Tokens===null||v6Tokens===null?null:v6Tokens-v5Tokens}};
  });
  const totalTokens=key=>cases.every(row=>row[key].generatedTokens!==null)?
    cases.reduce((total,row)=>total+row[key].generatedTokens,0):null;
  const v5Records=cases.reduce((total,row)=>total+row.v5.generatedRecords,0);
  const v6Records=cases.reduce((total,row)=>total+row.v6.generatedRecords,0);
  const v5Bytes=cases.reduce((total,row)=>total+row.v5.generatedBytes,0);
  const v6Bytes=cases.reduce((total,row)=>total+row.v6.generatedBytes,0);
  const v5Tokens=totalTokens('v5'),v6Tokens=totalTokens('v6');
  return {schema:'semantic-target-gallery-baseline-comparison/1',
    baselineRepresentation:'semantic-trace/5',currentRepresentation:WITNESS_VERSION,
    decodeArchivedV5Records:false,
    interpretation:'V5 records contribute only their stored raw-line bytes and optional same-tokenizer counts; the v6 decoder is never applied to them.',
    cases,totals:{v5:{generatedRecords:v5Records,generatedBytes:v5Bytes,generatedTokens:v5Tokens},
      v6:{generatedRecords:v6Records,generatedBytes:v6Bytes,generatedTokens:v6Tokens},
      delta:{generatedRecords:v6Records-v5Records,generatedBytes:v6Bytes-v5Bytes,
        generatedTokens:v5Tokens===null||v6Tokens===null?null:v6Tokens-v5Tokens}}};
}

export function renderSemanticTraceGallery(gallery){
  const output=['# Actual semantic target gallery','',gallery.purpose,'',
    '| Case | Categories | Generated records | Target UTF-8 bytes | Token count |',
    '| --- | --- | ---: | ---: | ---: |'];
  for(const row of gallery.cases)output.push('| '+[row.id,row.categories.join(', '),
    row.metrics.generatedRecords,row.metrics.generatedBytes,row.metrics.generatedTokens??'unavailable'].join(' | ')+' |');
  output.push('','Byte counts sum the exact generated UTF-8 target lines and exclude transport framing. Token counts, when available, encode each line independently; they do not measure native recurrent context or transport fragments.','');
  if(gallery.v5BaselineComparison){
    output.push('## Archived v5 comparison','','The archived v5 targets are compared as raw stored lines. They are not decoded or reinterpreted under the v6 grammar.','','| Case | v5 records | v6 records | Record change | v5 bytes | v6 bytes | Byte change | v5 tokens | v6 tokens | Token change |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for(const row of gallery.v5BaselineComparison.cases){
      const show=value=>value===null||value===undefined?'unavailable':String(value);
      output.push('| '+[row.id,row.v5.generatedRecords,row.v6.generatedRecords,
        row.delta.generatedRecords,row.v5.generatedBytes,row.v6.generatedBytes,
        row.delta.generatedBytes,show(row.v5.generatedTokens),show(row.v6.generatedTokens),
        show(row.delta.generatedTokens)].join(' | ')+' |');
    }
    const total=gallery.v5BaselineComparison.totals;
    output.push('',`Overall: ${total.v5.generatedRecords} → ${total.v6.generatedRecords} generated records; ${total.v5.generatedBytes} → ${total.v6.generatedBytes} UTF-8 bytes; ${total.v5.generatedTokens??'token count unavailable'} → ${total.v6.generatedTokens??'token count unavailable'} tokens.`,'');
  }
  for(const row of gallery.cases){
    output.push('## '+row.id,'','```js',row.source,'```','',
      'Qualification: `'+row.qualification.status+'`. '+row.qualification.boundary,'',
      '### Exact generated targets','', '```text',...row.records.filter(record=>record.targetMask==='generated').map(record=>record.raw),'```','',
      '### Readable execution and observation boundaries','');
    for(const record of row.records)output.push('- '+record.sequence+' '+record.targetMask+': '+
      (record.readable??record.kind)+' '+(record.claim?'— '+record.claim:''));
    output.push('','### Exact target measurements','','```json',JSON.stringify(row.metrics,null,2),'```','');
  }
  return output.map(line=>line.trimEnd()).join('\n').trimEnd()+'\n';
}
