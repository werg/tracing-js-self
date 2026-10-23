#!/usr/bin/env node
// Read-only quality audit of pinned real-source V8 diagnostic traces.
// This is NOT an owned semantic-execution/2 admission or proof of intermediate correctness.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const argv=process.argv.slice(2);
const arg=(flag,def)=>argv.includes(flag)?argv[argv.indexOf(flag)+1]:def;
const input=resolve(arg('--input','corpus/observations.jsonl'));
const report=resolve(arg('--output','corpus/quality.json'));
const review=resolve(arg('--review','corpus/quality.md'));
const count=Number(arg('--examples','16'));
if(!Number.isSafeInteger(count)||count<1||count>100)throw new TypeError('Invalid --examples');
const add=(row,key,n=1)=>row[key]=(row[key]??0)+n;
const lines=readFileSync(input,'utf8').split(/\r?\n/).filter(Boolean);
if(!lines.length)throw new Error('Empty observation corpus');
const totals={observations:0,verified:0,functions:0,events:0,reads:0,calls:0,
  branches:0,mutations:0,bytes:0,sourceBytes:0,opaqueResults:0,
  repeatedReadCandidates:0,sameValueWriteCandidates:0,lexicalWrites:0,
  returnedCallCandidates:0,unmappedSiteCandidates:0,limitations:0};
const byFunction={},kinds={},examples=[];
for(const [lineNumber,line] of lines.entries()){
  let x;try{x=JSON.parse(line);}catch(e){throw new SyntaxError('Invalid JSONL line '+(lineNumber+1));}
  if(x.schema!=='real-source-corpus/1'||typeof x.family!=='string'||
     !Array.isArray(x.observation?.events))throw new TypeError('Wrong corpus schema on line '+(lineNumber+1));
  const events=x.observation.events,text=x.observation.source?.text??'';
  const family=byFunction[x.family]??={invocations:0,verified:0,events:0,bytes:0,flags:{}};
  family.invocations++;totals.observations++;
  if(x.verified){family.verified++;totals.verified++;}
  family.events+=events.length;totals.events+=events.length;
  const bytes=Buffer.byteLength(JSON.stringify(events),'utf8');
  totals.bytes+=bytes;family.bytes+=bytes;
  totals.sourceBytes+=x.sourceBytes??Buffer.byteLength(text,'utf8');
  const gaps=(x.observation.limitations??[]).filter(x=>
    !x.startsWith('Native V8 observation is not owned replay')&&
    !x.startsWith('Native modules and unobserved host effects'));
  if(gaps.length)totals.limitations++;
  const flags={},flag=name=>{add(flags,name);add(totals,name);add(family.flags,name);};
  let prevRead=null,prevKind=null;
  for(const event of events){
    add(kinds,event.kind);
    if(event.kind==='read')totals.reads++;
    if(event.kind==='call')totals.calls++;
    if(event.kind==='branch')totals.branches++;
    const changes=event.effects??[];
    totals.mutations+=changes.length;
    if(event.kind==='write'&&event.binding!==undefined)
      totals.lexicalWrites++;
    if(event.kind==='write'&&event.binding===undefined&&!changes.length)
      flag('sameValueWriteCandidates');
    if(event.kind==='call'&&prevKind==='return')flag('returnedCallCandidates');
    if(event.result?.[0]==='unknown'||event.result?.[0]==='symbol')flag('opaqueResults');
    const site=event.site;
    if(event.kind!=='end'&&(!Number.isInteger(site?.start)||
       !Number.isInteger(site?.end)||site.start<0||
       site.end<site.start||site.end>text.length))flag('unmappedSiteCandidates');
    if(event.kind==='read'){
      const id=JSON.stringify([site?.start,site?.end,event.result]);
      if(id===prevRead)flag('repeatedReadCandidates');
      prevRead=id;
    }else if(event.kind!=='value')prevRead=null;
    prevKind=event.kind;
  }
  examples.push({family:x.family,index:x.index,verified:!!x.verified,
    events:events.length,bytes,flags,sourceURL:x.sourceURL,
    sample:events.slice(0,12).map(e=>({
      kind:e.kind,expression:text.slice(e.site?.start??0,e.site?.end??0)
        .replace(/\s+/g,' ').slice(0,100),
      result:e.result,effects:e.effects?.slice(0,2)??[]
    }))});
}
totals.functions=Object.keys(byFunction).length;
const scored=examples.map(e=>({...e,score:3*(e.flags.opaqueResults??0)+
  2*(e.flags.unmappedSiteCandidates??0)+(e.flags.returnedCallCandidates??0)+
  (e.flags.repeatedReadCandidates??0)+(e.flags.sameValueWriteCandidates??0)}))
  .sort((a,b)=>b.score-a.score||b.bytes-a.bytes||a.family.localeCompare(b.family));
const output={schema:'real-source-quality/1',admitted:false,
  authority:'native-V8-diagnostic-only',
  warnings:[
    'Verified means agreement with a separate uninstrumented V8 observable outcome, not independent intermediate-event verification.',
    'Candidate flags do not imply incorrect execution or authorize removal of no-op writes.',
    'The native V8 corpus is not an owned-interpreter semantic-execution/2 training dataset.'
  ],totals,kinds,byFunction,examples:scored.slice(0,count)};
mkdirSync(dirname(report),{recursive:true});mkdirSync(dirname(review),{recursive:true});
writeFileSync(report,JSON.stringify(output,null,2)+'\n');
const md=['# Real-source trace quality audit','','**Native V8 diagnostic only — not independently admitted training data.**','',
  '## Coverage',...Object.entries(totals).map(([k,v])=>'- '+k+': '+v),'',
  '## Event types',...Object.entries(kinds).map(([k,v])=>'- '+k+': '+v),'',
  '## Inspection candidates','',
  'Flags identify noisy or underspecified observations. A same-value write may still be semantically important; do not delete events on these metrics alone.',''];
for(const e of output.examples){
 md.push('### '+e.family+' #'+e.index,'',
   'Source: '+e.sourceURL,'',
   'Verified final state: '+e.verified+'; '+e.events+' events / '+e.bytes+' bytes.',
   'Candidate flags: '+JSON.stringify(e.flags),'','```text');
 for(const row of e.sample)md.push(row.kind+' '+row.expression+' → '+
   JSON.stringify(row.result)+(row.effects.length?' [effects: '+row.effects.length+']':''));
 md.push('```','');
}
writeFileSync(review,md.join('\n'));
console.log(JSON.stringify({observations:totals.observations,functions:totals.functions,
  verified:totals.verified,events:totals.events,report,review}));
