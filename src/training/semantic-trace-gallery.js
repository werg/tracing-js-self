// Audit the bytes a learner actually predicts, alongside their readable view.
// This is an inspection report, not a new admission authority or trace format.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {decodeWitness} from './format.js';
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
  end:'The invocation has the stated completion and no blocking pending work.'
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

// Exact top-level byte accounting. Nested expressions remain inside their
// field value; these categories do not pretend to measure semantic quality.
export function auditWitnessBytes(line){
  const {kind,fields}=decodeWitness(line);
  const entries=Object.entries(fields);
  const fieldBytes=entries.map(([name,value])=>({name,
    keyBytes:bytes(JSON.stringify(name))+1,valueBytes:bytes(JSON.stringify(value))}));
  const recordKindBytes=bytes(kind)+1;
  const punctuationBytes=2+Math.max(0,entries.length-1);
  const keyBytes=fieldBytes.reduce((n,field)=>n+field.keyBytes,0);
  const valueBytes=fieldBytes.reduce((n,field)=>n+field.valueBytes,0);
  const total=bytes(line);
  if(recordKindBytes+punctuationBytes+keyBytes+valueBytes!==total)
    throw new TypeError('Gallery requires canonical witness bytes');
  return {total,recordKindBytes,punctuationBytes,keyBytes,valueBytes,fields:fieldBytes};
}

function sourceNames(program){
  return new Set((program?.sites??[]).filter(site=>site.role==='Identifier')
    .map(site=>program.source.slice(site.start,site.end)));
}

export async function inspectSemanticEpisode(exported,{id,categories=[],tokenizer=null}={}){
  if(!Array.isArray(exported?.public?.timeline))throw new TypeError('A public episode is required');
  const timeline=exported.public.timeline,program=timeline.find(row=>row.kind==='program');
  if(!program)throw new TypeError('An exact observed source program is required');
  if(tokenizer&&(!tokenizer.identity||typeof tokenizer.encode!=='function'||
      typeof tokenizer.decode!=='function'))
    throw new TypeError('Tokenizer audit requires pinned identity, encode and decode');
  const names=sourceNames(program),certificateBySequence=new Map(
    (exported.sidecar?.compiler?.certificates??[]).map(row=>[row.sequence,row]));
  const records=[],prefix=[],kinds={},fields={},keyFrequency={};
  const declaredNames=new Set(),lastWrites=new Map();
  let generatedBytes=0,keyBytes=0,recordKindBytes=0,punctuationBytes=0,valueBytes=0;
  let observations=0,duplicateCellWrites=0,sourceNamedCells=0,generatedTokens=tokenizer?0:null;
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
      records.push(record);kinds[decoded.kind]=(kinds[decoded.kind]??0)+1;
      generatedBytes+=audit.total;keyBytes+=audit.keyBytes;valueBytes+=audit.valueBytes;
      recordKindBytes+=audit.recordKindBytes;punctuationBytes+=audit.punctuationBytes;
      for(const field of audit.fields){
        fields[field.name]=(fields[field.name]??0)+field.valueBytes;
        keyFrequency[field.name]=(keyFrequency[field.name]??0)+1;
      }
      const cell=decoded.kind==='bind'?decoded.fields.name:
        decoded.kind==='compute'?decoded.fields.bind:null;
      if(cell){
        declaredNames.add(cell);if(names.has(cell))sourceNamedCells++;
        const value=decoded.kind==='bind'?decoded.fields.value:decoded.fields.result;
        if(decoded.kind==='bind'&&lastWrites.has(cell)&&isDeepStrictEqual(lastWrites.get(cell),value))
          duplicateCellWrites++;
        lastWrites.set(cell,value);
      }
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
      scope:'Each semantic line encoded independently; excludes native transport and recurrent context.'}:
      {status:'unavailable',reason:'No qualified tokenizer adapter supplied; bytes are not token estimates.'},
    metrics:{generatedRecords:generatedBytes?Object.values(kinds).reduce((a,b)=>a+b,0):0,
      generatedBytes,recordKindBytes,punctuationBytes,keyBytes,valueBytes,
      generatedTokens,transportFragments:null,observedRows:observations,kinds,
      topLevelValueBytes:fields,topLevelKeyOccurrences:keyFrequency,
      distinctCells:declaredNames.size,exactSourceNamedBindingRecords:sourceNamedCells,
      repeatedEqualCellBindingRecords:duplicateCellWrites,
      overheadDefinition:'Record kind, top-level keys and punctuation are byte accounting, not dispensable semantic overhead.'},
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
  return {schema:'semantic-target-gallery/1',representation:'semantic-trace/5',
    purpose:'Actual target inspection; no model-learning or native-qualification claim.',
    projectionOptions:structuredClone(projectionOptions),
    categories:[...new Set(cases.flatMap(row=>row.categories))].sort(),
    totals:{cases:cases.length,generatedRecords:cases.reduce((n,row)=>n+row.metrics.generatedRecords,0),
      generatedBytes:cases.reduce((n,row)=>n+row.metrics.generatedBytes,0),
      generatedTokens:tokenizer?cases.reduce((n,row)=>n+row.metrics.generatedTokens,0):null},cases};
}

export function renderSemanticTraceGallery(gallery){
  const output=['# Actual semantic target gallery','',gallery.purpose,'',
    '| Case | Categories | Generated records | Target UTF-8 bytes | Token count |',
    '| --- | --- | ---: | ---: | ---: |'];
  for(const row of gallery.cases)output.push('| '+[row.id,row.categories.join(', '),
    row.metrics.generatedRecords,row.metrics.generatedBytes,row.metrics.generatedTokens??'unavailable'].join(' | ')+' |');
  output.push('','Byte counts exclude transport framing and observed context. Token counts, when available, encode each line independently; they do not measure native recurrent context or transport fragments.','');
  for(const row of gallery.cases){
    output.push('## '+row.id,'','```js',row.source,'```','',
      'Qualification: `'+row.qualification.status+'`. '+row.qualification.boundary,'',
      '### Exact generated targets','', '```text',...row.records.filter(record=>record.targetMask==='generated').map(record=>record.raw),'```','',
      '### Readable execution and observation boundaries','');
    for(const record of row.records)output.push('- '+record.sequence+' '+record.targetMask+': '+
      (record.readable??record.kind)+' '+(record.claim?'— '+record.claim:''));
    output.push('','### Byte and field accounting','','```json',JSON.stringify(row.metrics,null,2),'```','');
  }
  return output.join('\n')+'\n';
}
