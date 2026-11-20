// Retokenize the exact historical serializer output. This module never runs a
// source producer, reconstructs a prompt, or grants a native/model admission.
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hashAlgorithmData} from './program.js';
import {validateOwnedGraph} from '../host/graph-codec.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new TypeError('Retained serving costs: '+message);};
const require=(condition,message)=>{if(!condition)fail(message);};
const safe=name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
const sum=(rows,key)=>rows.reduce((total,row)=>total+row[key],0);

export function rootedInputGraphIdentity(input){
  const graph={schema:'owned-graph/1',roots:input?.roots,objects:input?.objects};validateOwnedGraph(graph);
  const nodes=new Map(graph.objects.map(node=>[node.id,node])),seen=new Map(),objects=[];
  function value(tag){
    if(tag[0]!=='ref')return structuredClone(tag);
    if(seen.has(tag[1]))return ['ref',seen.get(tag[1])];
    const original=nodes.get(tag[1]),id='o'+seen.size;seen.set(tag[1],id);
    const node={id,kind:original.kind,...(original.prototype===null?{prototype:null}:{}),properties:[]};objects.push(node);
    node.properties=original.properties.map(property=>({key:property.key,value:value(property.value)}));
    return ['ref',id];
  }
  const roots=graph.roots.map(value);
  return {digest:hashAlgorithmData({roots,objects}),reachableObjects:objects.length,
    unreachableObjects:graph.objects.length-objects.length};
}

export function readRetainedServingInputs(directory,{population='all'}={}){
  directory=resolve(directory);
  const summaryBytes=readFileSync(join(directory,'summary.json')),summary=JSON.parse(summaryBytes);
  require(summary.schema==='semantic-expansion-retained-evidence/1'&&/^[a-f0-9]{40}$/.test(summary.producerRevision??'')&&
    Array.isArray(summary.archives)&&Array.isArray(summary.populations),'historical retained-evidence summary required');
  const selected=population==='all'?summary.populations:summary.populations.filter(row=>row.id===population);
  require(selected.length>0&&new Set(selected.map(row=>row.id)).size===selected.length,'unknown or duplicate retained population');
  const populations=selected.map(population=>{
    require(safe(population.id),'unsafe population identity');
    const archive=summary.archives.find(row=>row.file===population.id+'.tar.xz');
    require(archive&&Array.isArray(archive.files)&&safe(archive.file),'missing retained archive');
    const path=join(directory,archive.file),archiveBytes=readFileSync(path);
    require(sha(archiveBytes)===archive.sha256&&archiveBytes.length===archive.compressedBytes,'archive bytes changed: '+archive.file);
    const names=execFileSync('tar',['-tf',path],{encoding:'utf8',maxBuffer:1048576}).trimEnd().split('\n'),
      declared=archive.files.map(row=>row.name);
    require(names.every(safe)&&declared.every(safe)&&new Set(names).size===names.length&&
      JSON.stringify(names.slice().sort())===JSON.stringify(declared.slice().sort()),'archive member inventory changed');
    const readArtifact=name=>{
      require(safe(name),'unsafe retained artifact path');
      const file=archive.files.find(row=>row.name===name);require(file,'undeclared retained artifact: '+name);
      const bytes=execFileSync('tar',['-xOf',path,name],{maxBuffer:268435456});
      require(sha(bytes)===file.sha256,'retained artifact bytes changed: '+name);
      return JSON.parse(bytes);
    };
    const coverage=readArtifact('coverage.json'),report=readArtifact('report.json'),costs=readArtifact('serving-costs.json');
    require(coverage.producerRevision===summary.producerRevision&&report.producerRevision===summary.producerRevision&&
      costs.producerRevision===summary.producerRevision&&report.manifestDigest===summary.manifestDigest&&
      report.registryDigest===summary.registryDigest&&costs.manifestDigest===summary.manifestDigest,
    'source producer or frozen manifest identity differs');
    require(coverage.schema==='semantic-capability-ledger/3'&&Array.isArray(coverage.rows)&&
      coverage.rows.length===population.coverage?.episodes?.declared&&
      coverage.rows.length===coverage.coverage?.episodes?.declared,'declared historical denominator differs');
    require(Array.isArray(costs.rows)&&new Set(costs.rows.map(row=>row.id)).size===costs.rows.length&&
      costs.rows.length===population.costs?.measuredCases,'retained serializer denominator differs');
    const costIds=new Set(costs.rows.map(row=>row.id)),ids=coverage.rows.map(row=>row.id);
    require(new Set(ids).size===ids.length&&[...costIds].every(id=>ids.includes(id)),'retained case identities differ');
    const servingFiles=archive.files.filter(row=>row.name.startsWith('serving-')&&row.name!=='serving-costs.json');
    require(servingFiles.length===costIds.size&&[...costIds].every(id=>safe(id)&&
      servingFiles.some(row=>row.name==='serving-'+id+'.json')),'serializer files differ from measured case identities');
    return {id:population.id,coverage,report,archive:{file:archive.file,sha256:archive.sha256},readArtifact,
      rows:coverage.rows.map(row=>({...row,servingArtifact:costIds.has(row.id)?
        archive.files.find(file=>file.name==='serving-'+row.id+'.json'):null}))};
  });
  return {directory,summary,summarySha256:sha(summaryBytes),populations};
}

/** Identity of the source and initial graph embedded in the original prompt. */
export function retainedServingSourceIdentity(report){
  const prompt=report.rows?.[0]?.prompt,prefix='Predict one complete semantic-trace/7 record from this public execution context.\n',
    suffix='\nNext record:\n';
  require(typeof prompt==='string'&&prompt.startsWith(prefix)&&prompt.endsWith(suffix),'historical serializer framing changed');
  const context=JSON.parse(prompt.slice(prefix.length,-suffix.length));
  require(context.schema==='semantic-context/7'&&context.representation===report.representation,'historical context identity differs');
  const program=report.representation==='algorithm'?context.program:context.prefix,
    invocation=report.representation==='detailed'?context.prefix?.committed?.find(row=>
      row.kind==='invocation'&&row.invocationId===context.prefix.invocationId):null,
    input=report.representation==='algorithm'?context.inputGraph:invocation?.inputGraph;
  require(typeof program?.source==='string'&&typeof program.entry==='string'&&Array.isArray(input?.roots)&&Array.isArray(input.objects),
    'source, entry or initial input graph absent from retained serializer');
  return {sourceDigest:hashAlgorithmData(program.source),sourceUtf8Sha256:sha(program.source),entry:program.entry,
    initialInputGraphDigest:hashAlgorithmData({roots:input.roots,objects:input.objects}),
    rootedInputGraph:rootedInputGraphIdentity(input),
    scope:'Exact source and entry; rooted initial values retain aliases, cycles, property order and null prototypes under identity renaming. The exact full graph digest is also retained. Unreachable internal allocations and the complete host fixture schedule are not used as initial-input equivalence claims.'};
}

export async function meterRetainedServingCase(report,{tokenizer,eosTokenId,maxContextTokens=1048576}={}){
  require(report.schema==='semantic-flat-serving-costs/1'&&report.path==='actual-semantic-causal-lm/3'&&
    report.byteMeasurement==='passed'&&['algorithm','detailed'].includes(report.representation)&&
    Array.isArray(report.rows)&&report.rows.length>0&&report.rows.length===report.predictions,
  'exact historical flat serializer rows required');
  require(tokenizer&&/^[a-f0-9]{64}$/.test(tokenizer.identity??'')&&typeof tokenizer.encode==='function'&&
    typeof tokenizer.decode==='function'&&Number.isSafeInteger(eosTokenId)&&eosTokenId>=0&&
    Number.isSafeInteger(maxContextTokens)&&maxContextTokens>1,'pinned exact tokenizer, EOS and context budget required');
  async function segment(text){
    const ids=await tokenizer.encode(text);
    require(Array.isArray(ids)&&ids.length>0&&ids.every(id=>Number.isSafeInteger(id)&&id>=0),
      'tokenizer must emit nonempty integer segments');
    require(!ids.includes(eosTokenId),'public text injects EOS');
    require(Buffer.from(await tokenizer.decode(ids)).equals(Buffer.from(text,'utf8')),'tokenizer changed exact serializer bytes');
    return ids;
  }
  const rows=[];
  for(const [index,row]of report.rows.entries()){
    require(row.prediction===index&&typeof row.prompt==='string'&&typeof row.target==='string'&&
      row.promptBytes===Buffer.byteLength(row.prompt)&&row.targetBytes===Buffer.byteLength(row.target)&&
      row.promptSha256===hashAlgorithmData(row.prompt)&&row.targetSha256===hashAlgorithmData(row.target)&&
      row.detail===(report.representation==='detailed'),'retained prompt, target or original byte digest differs');
    const promptIds=await segment(row.prompt),targetIds=await segment(row.target),totalTokens=promptIds.length+targetIds.length+1;
    if(totalTokens>maxContextTokens)throw new RangeError('Retained serving flat context budget exceeded; truncation is forbidden');
    rows.push({prediction:index,invocationId:row.invocationId,visibleThrough:row.visibleThrough,
      promptUtf8Sha256:sha(row.prompt),targetUtf8Sha256:sha(row.target),
      promptBytes:row.promptBytes,targetBytes:row.targetBytes,detail:row.detail,
      promptIds,targetIds,terminalIds:[eosTokenId],promptTokens:promptIds.length,generatedTokens:targetIds.length,
      terminalTokens:1,totalTokens,lossMaskRuns:[{value:0,count:promptIds.length},{value:1,count:targetIds.length+1}]});
  }
  const generatedBytes=sum(rows,'targetBytes'),detailedBytes=sum(rows.filter(row=>row.detail),'targetBytes'),
    cumulativeContext=sum(rows,'promptBytes'),peakContext=Math.max(...rows.map(row=>row.promptBytes));
  require(report.bytes?.generated===generatedBytes&&report.bytes.detailed===detailedBytes&&
    report.bytes.cumulativeContext===cumulativeContext&&report.bytes.peakContext===peakContext,'historical byte totals differ');
  const generated=sum(rows,'generatedTokens'),detailed=sum(rows.filter(row=>row.detail),'generatedTokens'),
    observedAndContext=sum(rows,'promptTokens');
  return {schema:'semantic-retained-flat-token-costs/1',status:'passed',serializer:report.path,
    representation:report.representation,episodeDigest:report.episodeDigest,contextsDigest:report.contextsDigest,
    sourceIdentity:retainedServingSourceIdentity(report),tokenizerIdentity:tokenizer.identity,eosTokenId,maxContextTokens,
    predictions:rows.length,bytes:{generated:generatedBytes,detailed:detailedBytes,cumulativeContext,peakContext},
    tokens:{generated,detailed,detailedShare:generated?detailed/generated:null,observedAndContext,
      terminal:rows.length,total:sum(rows,'totalTokens'),peakContext:Math.max(...rows.map(row=>row.promptTokens))},
    encoding:'independent-context-and-target-segments/1',
    accounting:'Concatenate promptIds, targetIds and terminalIds. Only target and EOS positions have loss; exact original strings remain in the hash-bound baseline archive. No cache saving or native framing is inferred.',
    model:{status:'unmeasured',nextStep:null,completedExecution:null,latencyMs:null},nativeServing:{status:'unmeasured'},rows};
}

export function summarizeRetainedServingCosts(rows){
  const measured=rows.filter(row=>row.cost?.status==='passed'),costs=measured.map(row=>row.cost),
    tokens=key=>costs.reduce((n,row)=>n+row.tokens[key],0),bytes=key=>costs.reduce((n,row)=>n+row.bytes[key],0),
    generated=tokens('generated'),detailed=tokens('detailed');
  return {declared:rows.length,serializerRetained:rows.filter(row=>row.servingArtifact).length,
    tokenMeasured:measured.length,unmeasured:rows.length-measured.length,
    sourceDispositions:Object.fromEntries([...new Set(rows.map(row=>row.sourceDisposition))]
      .map(value=>[value,rows.filter(row=>row.sourceDisposition===value).length])),
    predictions:costs.reduce((n,row)=>n+row.predictions,0),
    bytes:{generated:bytes('generated'),detailed:bytes('detailed'),cumulativeContext:bytes('cumulativeContext'),
      peakContext:Math.max(0,...costs.map(row=>row.bytes.peakContext))},
    tokens:{generated,detailed,detailedShare:generated?detailed/generated:null,observedAndContext:tokens('observedAndContext'),
      terminal:tokens('terminal'),total:tokens('total'),peakContext:Math.max(0,...costs.map(row=>row.tokens.peakContext))},
    scope:'Totals cover measured retained serializer cases only. Every original source disposition remains in the denominator.'};
}
