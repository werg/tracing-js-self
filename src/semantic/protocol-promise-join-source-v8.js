// Teacher-only bridge between exact owned join events and public scheduler
// operations. No later event can choose an earlier allocation identity.
import {isDeepStrictEqual as eq} from 'node:util';
import {compileEffectfulRegionWitnessV8} from './effectful-teacher-v8.js';
import {decodeDetailedRecord} from './detailed-v7.js';
import {decodeProtocolRecordV8} from './protocol-codec-v8.js';

const id='promise-join/1',copy=structuredClone;
const jobId=(result,index)=>'join'+result+'x'+index;
function teacher(){return {id,
  event(ctx,event,row){
    const changes=event.stateChanges,owner=ctx.rootFor(event.invocationId),
      callee=row?.operands?.[0],method=callee?.[0]==='method'?callee[1]:callee,
      mode=method?.[0]==='builtinfn'&&method[1].startsWith('Promise.')?method[1].slice(8):null;
    if(event.operation==='call.enter'&&['all','race'].includes(mode)){
      const result=row.result?.[0]==='promise'?row.result[1]:null,
        node=changes.find(change=>change.table==='promises'&&change.id===result)?.after;
      if(!node||mode!=='race'&&node.combinator?.kind!==mode)ctx.refuse('join result lacks exact owned combinator state');
      const array=ctx.state.heap[row.operands[1]?.[1]],length=array?.properties?.length?.value?.[1];
      if(row.operands[1]?.[0]!=='ref'||array?.kind!=='array'||!Number.isSafeInteger(length)||length<0||length>4096)
        ctx.refuse('join source requires a bounded ordinary array');
      const jobs=[];
      for(const change of changes){
        if(change.table==='control')for(const job of change.after?.queue??[])if(job.kind==='combinator'&&job.resultId===result)jobs.push(job);
        if(change.table==='promises')for(const observer of change.after?.observers??[])
          if(observer.kind==='combinator'&&observer.resultId===result)jobs.push({...observer,promiseId:change.id});
      }
      jobs.sort((a,b)=>a.index-b.index);
      if(jobs.length!==length||jobs.some((job,index)=>job.index!==index||job.mode!==mode))
        ctx.refuse('join source lacks one ordered dependency per input');
      const allocated=changes.filter(change=>change.table==='heap'&&change.before===null);
      const output=length===0&&mode==='all'?node.value?.value?.[1]:null;
      if(allocated.length!==(output===null?0:1)||output!==null&&allocated[0].id!==output)
        ctx.refuse('join registration has an undeclared allocation');
      ctx.emitProtocol(owner,{kind:'promise.join',mode,result,inputs:jobs.map(job=>job.promiseId),
        jobs:jobs.map(job=>jobId(result,job.index)),output:output===null?null:ctx.identity(output),error:null},event,'source-promise-join/1');
      if(output!==null)ctx.claimDataIdentity(output);
      return true;
    }
    const queued=ctx.state.control.a0.queue?.[0];
    if(event.operation!=='job.enter'||queued?.kind!=='combinator')return false;
    const result=queued.resultId,node=changes.find(change=>change.table==='promises'&&change.id===result)?.after??ctx.state.promises[result];
    if(!['all','race'].includes(queued.mode)||!node||queued.mode!=='race'&&!node.combinator)ctx.refuse('unqualified Promise join step');
    const allocated=changes.filter(change=>change.table==='heap'&&change.before===null);
    const output=allocated.length===1&&allocated[0].after.kind==='array'?allocated[0].id:null;
    if(allocated.length!==(output===null?0:1))ctx.refuse('join step has an undeclared allocation');
    ctx.emitProtocol(ctx.rootInvocation,{kind:'promise.join.step',result,job:jobId(result,queued.index),
      entry:null,output:output===null?null:ctx.identity(output),error:null,status:node.status,
      value:node.status==='pending'?null:ctx.tag(node.value.value)},event,'source-promise-join-step/1');
    if(output!==null)ctx.claimDataIdentity(output);
    return true;
  },
  checkEvent(ctx,event){
    const controller=ctx.controller(ctx.rootInvocation);
    for(const change of event.stateChanges){
      if(change.table==='promises'&&change.after){
        const selected=controller.heap.get(change.id),owned=change.after;
        if(selected&&(selected.state!==owned.status||!eq(selected.result,owned.value===null?null:ctx.tag(owned.value.value))))
          ctx.refuse('public Promise settlement differs from the current owned event');
        if(owned.combinator&&(!selected?.join||selected.join.mode!==owned.combinator.kind))
          ctx.refuse('owned join state has no public scheduler operation');
      }
      if(change.table==='heap'&&change.before===null&&controller.heap.has(ctx.identity(change.id))&&change.after.kind==='array'){
        const selected=controller.heap.get(ctx.identity(change.id)),owned=change.after;
        const properties=new Map(Object.entries(owned.properties).map(([key,value])=>[key,ctx.tag(value.value)]));
        if(!eq(selected.properties,properties))ctx.refuse('join output differs from current owned allocation');
      }
      if(change.table==='control'&&controller.protocol){
        const actual=controller.ready.filter(job=>controller.jobs.get(job)?.reaction==='join'),
          expected=(change.after.queue??[]).filter(job=>job.kind==='combinator').map(job=>jobId(job.resultId,job.index));
        if(!eq(actual,expected))ctx.refuse('join readiness differs from the current owned FIFO queue');
      }
    }
    return true;
  }
};}

export function createPromiseJoinSourceAdapterV8({bundle}={}){
  if(!bundle?.events?.some(event=>event.operation==='call.enter'&&['Promise.all','Promise.race'].includes(
    event.operands?.[0]?.[0]==='method'?event.operands[0][1]?.[1]:event.operands?.[0]?.[1])))return null;
  return {id,compile({maxGenerated}){
    const compiled=compileEffectfulRegionWitnessV8(bundle,{maxGenerated,extensions:[teacher()]}),
      certificates=new Map(compiled.certificates.map(row=>[row.sequence,row])),
      sites=new Map(bundle.sites.map(site=>[site.siteId,site])),timeline=compiled.exported.public.timeline,
      publication=timeline.find(row=>row.kind==='program').fields,entry=timeline.find(row=>row.kind==='invocation').fields;
    if(timeline.some(row=>row.mode==='observed'&&!['program','invocation'].includes(row.kind)))
      throw new TypeError('Promise source profile does not admit external observations');
    const claims=timeline.filter(row=>row.mode==='generated').map(row=>{
      const certificate=certificates.get(row.sequence),source=sites.get(certificate?.source?.siteId),
        kind=row.kind==='protocol'?'protocol':'detail';
      if(!certificate)throw new TypeError('Missing owned source certificate');
      return {kind,record:kind==='protocol'?decodeProtocolRecordV8(row.fields.line):decodeDetailedRecord(row.fields.line,{role:'generated'}),
        line:row.fields.line,certificate:{rule:certificate.rule,journalEvents:copy(certificate.journalEvents),
          source:source?{start:source.start,end:source.end}:null}};
    });
    return {schema:'semantic-protocol-source-projection/1',source:publication.source,entry:publication.entry,
      inputGraph:copy(entry.inputGraph),claims,outcome:compiled.outcome,sourceProfile:'promise-joins-source/1',extensions:[id],
      completionPolicy:'await-returned-promise',protocolRecords:claims.filter(row=>row.kind==='protocol').length,
      detailedRecords:claims.filter(row=>row.kind==='detail').length};
  }};
}
