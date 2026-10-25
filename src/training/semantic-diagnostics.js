// Read-only offline views over the committed public selected-harness tape.
import {isDeepStrictEqual} from 'node:util';
import {SelectedExecutionHarness} from './harness-v4.js';
import {decodeWitness} from './format.js';
import {renderOrchestration} from './render-orchestration.js';

const copy=value=>structuredClone(value);
const text=value=>typeof value==='string'?value:JSON.stringify(value);
const sourceId=programId=>'source-'+encodeURIComponent(String(programId));

function divergence(actual,expected){
  const a=actual?.public?.timeline??actual?.timeline??[];
  const e=expected?.public?.timeline??expected?.timeline??[];
  const count=Math.max(a.length,e.length);
  for(let index=0;index<count;index++){
    if(!isDeepStrictEqual(a[index]??null,e[index]??null))return {index,
      actual:a[index]??null,expected:e[index]??null};
  }
  return null;
}

function eventView(record){
  const view={sequence:record.sequence,kind:record.kind,mode:record.mode??null,
    track:record.track??null,invocationId:record.invocationId??null,
    programId:record.programId??null,raw:copy(record)};
  if(record.kind==='semantic'&&typeof record.line==='string'){
    try{const decoded=decodeWitness(record.line);view.witness=decoded.kind;view.fields=copy(decoded.fields);}
    catch(error){view.witnessError=String(error.message??error);}
  }
  return view;
}

function causalLinks(records){
  const requestsByEffect=new Map(),requestsByPromise=new Map(),awaitsByContinuation=new Map(),links=[];
  for(const record of records){
    if(record.kind==='semantic'&&typeof record.line==='string'){
      let witness;try{witness=decodeWitness(record.line);}catch{continue;}
      const f=witness.fields,owner=record.invocationId+'/';
      if(witness.kind==='request'){
        requestsByEffect.set(owner+f.effect,record);
        if(f.promise)requestsByPromise.set(owner+f.promise,record);
      }
      if(witness.kind==='await'){
        const awaitKey=owner+f.promise;
        awaitsByContinuation.set(owner+f.continuation,record);
        const request=requestsByPromise.get(awaitKey);
        if(request)links.push({kind:'request-await',from:request.sequence,to:record.sequence,label:'request awaited'});
      }
      if(witness.kind==='resume'){
        const awaitRecord=awaitsByContinuation.get(owner+f.continuation);
        if(awaitRecord)links.push({kind:'await-resume',from:awaitRecord.sequence,to:record.sequence,label:'await resumed'});
      }
    }
    if(record.kind==='result'){
      const request=requestsByEffect.get(record.invocationId+'/'+record.effectId);
      if(request)links.push({kind:'request-result',from:request.sequence,to:record.sequence,
        label:`${record.status} result`});
    }
  }
  return links;
}

function stateChanges(records){
  const changes=[];
  for(const record of records){
    const item={sequence:record.sequence,track:record.track??null,invocationId:record.invocationId??null,
      kind:record.kind,change:null};
    if(record.kind==='invocation')item.change=`invoke ${record.entry} (${record.completionPolicy})`;
    else if(record.kind==='result')item.change=`${record.effectId} settled ${record.status}`;
    else if(record.kind==='cancel')item.change=`cancelled: ${record.reason}`;
    else if(record.kind==='reconcile')item.change=`${record.effectId}: ${record.disposition}`;
    else if(record.kind==='event')item.change=`delivered ${record.eventId}`;
    else if(record.kind==='handler'||record.kind==='handler-close')item.change=record.kind==='handler'?
      `registered ${record.subscriptionId}`:`closed ${record.subscriptionId}`;
    else if(record.kind==='semantic'){
      try{
        const w=decodeWitness(record.line);item.change=['write','allocate','bind','return','throw','end'].includes(w.kind)?
          `${w.kind}${w.fields.key?` ${w.fields.key}`:''}`:null;
      }catch{}
    }
    if(item.change)changes.push(item);
  }
  return changes;
}

/** Replay and inspect only public records; adapters are never called. Invalid
 * and nonterminal records stay attached to the result for forensic review. */
export function buildSemanticDiagnostics(evidence,{expected=null,trackId=null,includeTransport=false}={}){
  const episode=evidence?.episode??evidence;
  const records=Array.isArray(episode?.public?.timeline)?episode.public.timeline:[];
  let replayValid=false,replayError=null,rendered=[],replay=null;
  try{
    replay=SelectedExecutionHarness.replay(episode,{requireTerminal:false});
    replayValid=true;
    rendered=evidence?.orchestration?renderOrchestration(evidence,{trackId,includeTransport}):
      replay.inspect(null,{trackId,includeTransport});
  }catch(error){replayError=String(error.message??error);}
  const programs=new Map(records.filter(record=>record.kind==='program').map(record=>[record.programId,{
    id:record.programId,digest:record.digest,entry:record.entry,source:record.source,
    sourceAnchor:sourceId(record.programId),sequence:record.sequence}]));
  const invocations=records.filter(record=>record.kind==='invocation').map(record=>({
    id:record.invocationId,track:record.track,programId:record.programId,entry:record.entry,
    triggerId:record.triggerId,parentInvocationId:record.parentInvocationId,realmId:record.realmId,
    sourceAnchor:sourceId(record.programId),sequence:record.sequence}));
  const selectedRecords=records.filter(record=>trackId===null||record.track===trackId||
    record.kind==='program').map(eventView);
  const visibleSequences=new Set(selectedRecords.map(record=>record.sequence));
  const links=causalLinks(records).filter(link=>visibleSequences.has(link.from)&&visibleSequences.has(link.to));
  const expectedDivergence=expected===null?null:divergence(episode,expected);
  return {schema:'semantic-diagnostics/1',readOnly:true,replayValid,replayError,
    sourceLineage:episode?.sidecar?.sourceLineage??null,split:episode?.sidecar?.split??null,
    selectionOrigin:episode?.sidecar?.selectionOrigin??null,programs:[...programs.values()],invocations,
    records:selectedRecords,rendered,links,stateChanges:stateChanges(records).filter(item=>visibleSequences.has(item.sequence)),
    firstDivergence:expectedDivergence,partial:records.length>0&&(!replayValid||
      [...(replay?.invocations?.values?.()??[])].some(invocation=>
        !['completed','cancelled','failed'].includes(invocation.status))),
    publicEpisode:copy(episode?.public??null),metadata:{sourceLineage:episode?.sidecar?.sourceLineage??null,
      split:episode?.sidecar?.split??null,selectionOrigin:episode?.sidecar?.selectionOrigin??null,
      referenceStatus:episode?.sidecar?.referenceStatus??null}};
}

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** Standalone HTML: no script, style, font, or image request leaves the file. */
export function renderSemanticDiagnosticsHtml(report){
  const sources=report.programs.map(program=>`<section id="${esc(program.sourceAnchor)}"><h2>Source · ${esc(program.id)}</h2><p>Entry <code>${esc(program.entry)}</code> · digest <code>${esc(program.digest)}</code></p><pre>${esc(program.source)}</pre></section>`).join('');
  const invocations=report.invocations.map(invocation=>`<li id="inv-${esc(invocation.id)}"><a href="#${esc(invocation.sourceAnchor)}">${esc(invocation.programId)}.${esc(invocation.entry)}</a> · ${esc(invocation.id)} · track ${esc(invocation.track)} · trigger ${esc(invocation.triggerId)} · realm ${esc(invocation.realmId)}</li>`).join('');
  const links=report.links.map(link=>`<li><a href="#rec-${esc(link.from)}">${esc(link.from)}</a> → <a href="#rec-${esc(link.to)}">${esc(link.to)}</a> · ${esc(link.label)}</li>`).join('');
  const changes=report.stateChanges.map(item=>`<li><a href="#rec-${esc(item.sequence)}">${esc(item.sequence)}</a> · ${esc(item.track)} · ${esc(item.change)}</li>`).join('');
  const records=report.records.map(item=>`<li id="rec-${esc(item.sequence)}"><strong>${esc(item.sequence)} ${esc(item.kind)}</strong> · ${esc(item.track)} · ${item.invocationId?`<a href="#inv-${esc(item.invocationId)}">${esc(item.invocationId)}</a>`:''}<pre>${esc(JSON.stringify(item.raw,null,2))}</pre></li>`).join('');
  const divergence=report.firstDivergence?`<section><h2>First divergence · index ${esc(report.firstDivergence.index)}</h2><h3>Actual</h3><pre>${esc(JSON.stringify(report.firstDivergence.actual,null,2))}</pre><h3>Expected</h3><pre>${esc(JSON.stringify(report.firstDivergence.expected,null,2))}</pre></section>`:'';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Semantic trace diagnostics</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#202124}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:1rem;border-radius:.4rem}li{margin:.5rem 0}section{border-top:1px solid #ccd;padding-top:1rem}code{overflow-wrap:anywhere}.status{padding:.75rem;background:${report.replayValid?'#e9f7ef':'#fff0e8'}}</style><h1>Semantic trace diagnostics</h1><p class="status">Read-only replay: ${report.replayValid?'valid':'invalid or incomplete'} · ${report.partial?'partial trace retained':'terminal trace'} · records ${esc(report.records.length)}</p>${report.replayError?`<p>Replay finding: ${esc(report.replayError)}</p>`:''}<p>Lineage ${esc(report.sourceLineage)} · split ${esc(report.split)} · selection origin ${esc(report.selectionOrigin)}</p><section><h2>Invocations and source</h2><ul>${invocations}</ul></section>${sources}<section><h2>Request, await, and result links</h2><ul>${links}</ul></section><section><h2>Visible state changes</h2><ul>${changes}</ul></section>${divergence}<section><h2>Committed trace records</h2><ol>${records}</ol></section></html>`;
}
