// One reading view of the actual coordinator tape and selected guest witness.
// This is a renderer, not an execution or reference authority.
import {SelectedExecutionHarness} from './harness-v4.js';
import {renderWitness} from './render.js';

const printable=value=>JSON.stringify(value);
const valueText=value=>renderWitness('return '+JSON.stringify({value})).replace(/^return /,'');

function coordinatorText(value,role,owner,{includeTransport}){
  if(role==='assistant'&&typeof value?.name==='string'){
    const a=value.arguments??{};
    if(value.name==='track_create')return 'generated: create child for '+a.execution.program_id+
      '/'+a.execution.invocation_id+' in realm '+a.execution.realm_id;
    if(value.name==='track_join')return 'generated: join child '+a.completion_dependency.track+
      '/'+a.completion_dependency.invocation+' through '+a.completion_dependency.id;
    if(value.name==='track_progress')return 'generated: publish child completion '+a.progress;
    if(value.name==='track_complete')return 'generated: complete coordinator '+a.address;
    return 'generated: '+value.name+' '+printable(a);
  }
  if(value?.schema==='semantic-orchestration-input/4')return 'observed: admit '+value.children.length+
    ' child source/invocation proposal'+(value.children.length===1?'':'s');
  if(value?.schema==='semantic-completion/4')return 'observed: child '+value.dependency.track+
    '/'+value.dependency.invocation+' '+value.kind+' '+valueText(value.value)+'; wake '+value.target;
  if(role==='tool'&&value?.track){
    const t=value.track;
    if(value.completion_dependency)return 'observed: created '+t.address+' for '+t.execution.invocation_id+
      '; parent '+t.parent+'; completion dependency '+value.completion_dependency.id;
    return 'observed: '+t.address+' is '+t.status+
      (t.status==='waiting'?'; waiting on '+t.prerequisites.join(', '):'');
  }
  if(role==='system'&&typeof value?.status==='string')return 'observed: '+owner+' is '+value.status;
  if(includeTransport||role==='tool')return 'observed: '+role+' '+printable(value);
  return null;
}

/** Reassemble exact native payload fragments, then interleave their readable
 * lifecycle receipts with the existing canonical semantic witness renderer.
 * Track filtering retains source publication; it never invents missing events. */
export function renderOrchestration(evidence,{trackId=null,includeTransport=false}={}){
  if(evidence?.schema!=='semantic-evaluation-result/4'||
    evidence.orchestration?.schema!=='semantic-orchestration-evidence/4')
    throw new TypeError('An actual orchestration evaluation receipt is required');
  const harness=SelectedExecutionHarness.replay(evidence.episode);
  const semantic=new Map(harness.inspect(null,{includeTransport}).map(line=>[
    Number(line.match(/^\d+/)[0]),line.replace(/^\d+\s*/,'' )]));
  const pending=new Map(),lines=[];
  let previous=0;
  for(const item of evidence.orchestration.timeline){
    if(!Number.isSafeInteger(item.sequence)||item.sequence<=previous)
      throw new TypeError('Orchestration reading order is not committed order');
    previous=item.sequence;
    if(item.channel==='semantic'){
      const line=semantic.get(item.record.sequence);
      if(line&&(trackId===null||item.owner===trackId||item.record.kind==='program'))
        lines.push({sequence:item.sequence,line});
      continue;
    }
    if(item.channel!=='coordinator')throw new TypeError('Unknown orchestration reading channel');
    const record=item.record;
    if(typeof record.payloadHex!=='string'||!/^(?:[0-9a-f]{2})*$/.test(record.payloadHex))
      throw new TypeError('Coordinator payload lost its original bytes');
    const key=item.owner+'/'+record.role;
    const parts=pending.get(key)??{owner:item.owner,role:record.role,sequence:item.sequence,bytes:[]};
    parts.bytes.push(Buffer.from(record.payloadHex,'hex'));pending.set(key,parts);
    if(record.terminal!==true)continue;
    pending.delete(key);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts.bytes));
    let value;try{value=JSON.parse(text);}catch{
      throw new TypeError('Committed coordinator payload is not complete JSON');
    }
    const rendered=coordinatorText(value,parts.role,parts.owner,{includeTransport});
    if(rendered&&(trackId===null||parts.owner===trackId))
      lines.push({sequence:parts.sequence,line:'['+parts.owner+'] '+rendered});
  }
  if(pending.size)throw new TypeError('Coordinator transcript has an incomplete native payload');
  return lines.sort((a,b)=>a.sequence-b.sequence)
    .map(item=>String(item.sequence).padStart(4,'0')+' '+item.line);
}
