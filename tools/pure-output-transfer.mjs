#!/usr/bin/env node
// Experimental output-transfer boundary. This is never a production trace
// exporter: the public request carries only source and initial invocation data.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateOwnedGraph} from '../src/host/graph-codec.js';
import {traceGraph} from '../src/training/evaluation-graph.js';

export const PURE_REQUEST_SCHEMA='semantic-pure-output-request/1';
export const PURE_COHORT_SCHEMA='semantic-pure-output-cohort/1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>structuredClone(value);
const keys=(value,names)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')===[...names].sort().join(',');

function checkedGraph(graph){
  if(!keys(graph,['roots','objects']))throw new TypeError('Outcome graph needs exactly roots and objects');
  validateOwnedGraph({schema:'owned-graph/1',...graph});
  const nodes=new Map(graph.objects.map(node=>[node.id,node])),reachable=new Set();
  function visit(value){if(value[0]!=='ref'||reachable.has(value[1]))return;
    reachable.add(value[1]);for(const prop of nodes.get(value[1]).properties)visit(prop.value);}
  graph.roots.forEach(visit);
  if(reachable.size!==nodes.size)throw new TypeError('Outcome graph contains unreachable identities');
  return nodes;
}

export function pureOutputCase(frozen,{decoderSeed=17}={}){
  const {request}=frozen.envelope??{};
  if(!request?.program||!request.invocation||request.programs||request.invocations||
    request.program.capabilities.length||request.fixture.calls.length||
    frozen.expected.effects.length||frozen.expected.callbacks.length||
    Object.values(frozen.expected.cleanup).some(Boolean)||
    !['return','throw'].includes(frozen.expected.completion.kind))
    throw new TypeError('Pure transfer requires one independently completed effect-free invocation');
  if(!isDeepStrictEqual(request.invocation.receiverValue,['undefined']))
    throw new TypeError('Pure transfer currently observes positional argument graphs, not bound receivers');
  if(![17,29,43].includes(decoderSeed))throw new TypeError('Invalid pure transfer decoder seed');
  const inputGraph=traceGraph(request.invocation.inputGraph);
  checkedGraph(inputGraph);
  const expected={kind:frozen.expected.completion.kind,graph:traceGraph(frozen.expected.state)};
  checkedGraph(expected.graph);
  if(expected.graph.roots.length!==inputGraph.roots.length+1)
    throw new TypeError('Independent completion must preserve argument roots and append return/throw value');
  const envelope={schema:PURE_REQUEST_SCHEMA,caseId:frozen.id,source:request.program.source,
    entry:request.program.entry,inputGraph,randomSeed:request.program.randomSeed??null,
    decoderSeed,completionPolicy:request.invocation.completionPolicy,
    outputContract:'pure-observable-outcome/1'};
  return {id:frozen.id,family:frozen.family,sourceCluster:frozen.sourceCluster,split:frozen.split,
    identityDigest:frozen.identityDigest,slices:[...frozen.slices.filter(slice=>slice!=='pure-selected'),'pure-output-transfer'],
    envelope,expected};
}

export function validatePureRequest(request){
  if(!keys(request,['schema','caseId','source','entry','inputGraph','randomSeed','decoderSeed','completionPolicy','outputContract'])||
    request.schema!==PURE_REQUEST_SCHEMA||typeof request.caseId!=='string'||!request.caseId||
    typeof request.source!=='string'||!request.source||Buffer.byteLength(request.source)>2000000||
    typeof request.entry!=='string'||!/^[$A-Z_a-z][$\w]*$/.test(request.entry)||
    request.randomSeed!==null&&!Number.isSafeInteger(request.randomSeed)||
    ![17,29,43].includes(request.decoderSeed)||
    request.completionPolicy!=='await-returned-promise'||request.outputContract!=='pure-observable-outcome/1')
    throw new TypeError('Invalid source/input-only pure-output request');
  checkedGraph(request.inputGraph);return request;
}

export function comparePureOutcome(expected,actual,{inputRootCount}={}){
  if(!keys(expected,['kind','graph'])||!['return','throw'].includes(expected.kind))
    throw new TypeError('Invalid private independently verified outcome');
  const want=checkedGraph(expected.graph);
  if(!keys(actual,['kind','graph'])||!['return','throw'].includes(actual.kind))
    return {correct:false,valid:false,firstDivergence:{path:'outcome',reason:'invalid-outcome-envelope'}};
  let got;try{got=checkedGraph(actual.graph);}catch(error){return {correct:false,valid:false,
    firstDivergence:{path:'graph',reason:'invalid-output-graph',message:error.message}};}
  if(!Number.isSafeInteger(inputRootCount)||inputRootCount<0||expected.graph.roots.length!==inputRootCount+1)
    throw new TypeError('Independent root arity differs from the public input contract');
  if(actual.kind!==expected.kind)return {correct:false,valid:true,firstDivergence:{path:'kind',reason:'return-throw-mismatch'}};
  if(actual.graph.roots.length!==expected.graph.roots.length)return {correct:false,valid:true,
    firstDivergence:{path:'graph.roots',reason:'argument-or-completion-root-missing'}};
  const forward=new Map(),reverse=new Map();let divergence=null;
  const fail=(path,reason)=>{divergence??={path,reason};return false;};
  function value(a,b,path){
    if(a[0]!=='ref'||b[0]!=='ref')return isDeepStrictEqual(a,b)||fail(path,'value-mismatch');
    if(forward.has(a[1]))return forward.get(a[1])===b[1]||fail(path,'alias-or-cycle-mismatch');
    if(reverse.has(b[1]))return fail(path,'distinct-identities-collapsed');
    forward.set(a[1],b[1]);reverse.set(b[1],a[1]);
    const left=want.get(a[1]),right=got.get(b[1]);
    if(left.kind!==right.kind)return fail(path,'object-array-kind-mismatch');
    if((left.prototype===null)!==(right.prototype===null))return fail(path,'prototype-mismatch');
    if(left.properties.length!==right.properties.length)return fail(path,'property-or-hole-mismatch');
    for(let index=0;index<left.properties.length;index++){
      const property=left.properties[index],candidate=right.properties[index];
      if(property.key!==candidate.key)return fail(path+'.properties['+index+']','property-order-or-key-mismatch');
      if(!value(property.value,candidate.value,path+'.'+property.key))return false;
    }
    return true;
  }
  for(let i=0;i<expected.graph.roots.length;i++)if(!value(expected.graph.roots[i],actual.graph.roots[i],`graph.roots[${i}]`))break;
  return {correct:divergence===null,valid:true,firstDivergence:divergence,
    comparedReachableIdentities:forward.size,identityPolicy:'rooted-bijection-preserving-aliases-cycles-properties-and-prototypes'};
}

function main(){
  const [operation,...raw]=process.argv.slice(2),flags=new Map();
  for(let i=0;i<raw.length;i+=2){if(!raw[i+1]||flags.has(raw[i]))throw new TypeError('Invalid arguments');flags.set(raw[i],raw[i+1]);}
  if(operation==='score'){
    const {expected,actual,inputRootCount}=JSON.parse(readFileSync(0,'utf8'));
    process.stdout.write(JSON.stringify(comparePureOutcome(expected,actual,{inputRootCount}))+'\n');return;
  }
  if(operation==='validate-request'){
    validatePureRequest(JSON.parse(readFileSync(0,'utf8')));process.stdout.write('{"valid":true}\n');return;
  }
  if(operation!=='freeze'||!flags.has('--experiment')||!flags.has('--out')||
    [...flags.keys()].some(flag=>!['--experiment','--out','--split'].includes(flag)))
    throw new TypeError('Usage: pure-output-transfer.mjs freeze --experiment PRIVATE.json --out PRIVATE-PURE.json [--split test|validation]');
  const input=readFileSync(resolve(flags.get('--experiment'))),experiment=JSON.parse(input);
  if(experiment.schema!=='semantic-learning-experiment/1')throw new TypeError('Frozen learning experiment required');
  const split=flags.get('--split')??'test';
  if(!['test','validation'].includes(split))throw new TypeError('Pure transfer uses frozen validation or test membership');
  const cases=[],refusals=[];
  for(const row of experiment[split])try{cases.push(pureOutputCase(row,{decoderSeed:experiment.decoderSeed}));}
  catch(error){refusals.push({id:row.id,family:row.family,reason:error.message});}
  if(!cases.length)throw new TypeError('No single-invocation effect-free cases in this frozen split');
  const cohort={schema:PURE_COHORT_SCHEMA,experimentSha256:hash(input),producerRevision:experiment.producerRevision,
    sourceRegistryDigest:experiment.sourceRegistryDigest,nativePolicy:experiment.nativePolicy,
    split,decoderSeed:experiment.decoderSeed,baseOrigin:experiment.baseOrigin,
    frozenAt:new Date().toISOString(),endpoint:'source-and-input-to-observable-outcome',
    privateExpectedOutcomes:true,sourceTraceInModelRequest:false,injectedSelections:false,cases,refusals,
    scope:'Separate exploratory endpoint; does not inherit selected-execution accuracy or its confirmatory gate.'};
  const out=resolve(flags.get('--out'));mkdirSync(dirname(out),{recursive:true});
  const bytes=JSON.stringify(cohort,null,2)+'\n';writeFileSync(out,bytes,{flag:'wx'});
  process.stdout.write(JSON.stringify({cohort:out,sha256:hash(bytes),cases:cases.length,
    independentComponents:new Set(cases.map(row=>row.sourceCluster)).size,refusals:refusals.length})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  try{main();}catch(error){process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;}
