// A whole pure /2 core is one region of the shared v8 execution contract.
// Fresh allocations are retained identities, committed through the same heap
// operations as detailed execution. No source is evaluated by this module.
import {isDeepStrictEqual} from 'node:util';
import {evaluateAlgorithmV8,validateAlgorithmV8} from './algorithm-v8.js';
import {assertAlgorithmFields,assertAlgorithmValue,assertAlgorithmDataArray,stableAlgorithmJSON} from './ir.js';
import {algorithmHeapNode} from './operations.js';
import {hashAlgorithmData} from './program.js';
import {regionEntry} from './regions.js';
import {protocolOrdinaryHeapViewV8,protocolReservedIdentitiesV8} from './protocol-state-v8.js';

export const PURE_REGION_PROFILE='pure-algorithm-region/1';
const copy=structuredClone;
function fail(message){const error=new TypeError('Pure region: '+message);error.category='unsupported.pure-region';throw error;}
export function pureRegionEntry(program,controller,cutoff){
  if(!program.algorithm)fail('source has no certified pure core');
  return regionEntry(program,{id:'whole',digest:hashAlgorithmData(program.algorithm)},controller,cutoff);
}
export function evaluatePureRegion(program,controller){
  if(!program.algorithm)fail('source has no certified pure core');validateAlgorithmV8(program.algorithm);
  if(controller.generated!==0||controller.stack.length!==1||controller.stack[0]!==controller.rootInvocation||
    controller.completion||controller.pending||controller.effects.size||controller.jobs.size||controller.continuations.size||
    controller.input.retained?.length||controller.protocol?.sequence)fail('whole pure core requires the untouched invocation entry');
  protocolOrdinaryHeapViewV8(controller,{roots:controller.input.graph.roots});
  const result=evaluateAlgorithmV8(program.algorithm,null,{inputGraph:controller.input.graph});
  // Algorithm-local allocations and detailed allocations have different
  // lexical namespaces. Anchor existing objects, then allocate one fresh
  // detailed identity per new core identity in allocation order.
  const mapping=new Map(),reserved=controller.protocol?protocolReservedIdentitiesV8(controller):new Set(controller.heap.keys());let next=0;
  for(const node of result.graph.objects)if(!reserved.has(node.id)){
    let identity;do{identity='o'+next++;}while(reserved.has(identity));
    reserved.add(identity);mapping.set(node.id,identity);
  }
  const value=tag=>tag[0]==='ref'&&mapping.has(tag[1])?['ref',mapping.get(tag[1])]:copy(tag);
  const ordered=properties=>{
    const index=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
    return [...properties.filter(row=>index(row.key)).sort((a,b)=>Number(a.key)-Number(b.key)),
      ...properties.filter(row=>!index(row.key))];
  };
  const graph={roots:result.graph.roots.map(value),objects:result.graph.objects.map(node=>({...copy(node),
    id:mapping.get(node.id)??node.id,properties:ordered(node.properties).map(property=>({key:property.key,value:value(property.value)}))}))};
  const allocations=graph.objects.filter(node=>!controller.heap.has(node.id));
  const completion={kind:result.completion.kind,value:value(result.completion.value)};
  const claims=result.claims.map(claim=>({...copy(claim),...(claim.kind==='compute'?{result:value(claim.result)}:{value:value(claim.value)})}));
  const records=[];
  for(const node of allocations){
    const properties=node.properties.filter(property=>node.kind!=='array'||property.key!=='length');
    records.push({kind:'allocate',fields:{name:node.id,kind:node.kind,properties:copy(properties),
      ...(node.kind==='array'?{length:node.properties.find(property=>property.key==='length').value[1]}:{})}});
  }
  records.push({kind:completion.kind,fields:{value:completion.value,invocation:controller.rootInvocation}});
  return {record:{claims,allocations:copy(allocations),completion},
    records,graph,allocator:result.allocator,identityMap:[...mapping],work:result.work};
}
export function encodePureRegionRecord(record){
  assertAlgorithmFields(record,['claims','allocations','completion'],'pure region');
  assertAlgorithmDataArray(record.claims,'pure claims');assertAlgorithmDataArray(record.allocations,'pure allocations');
  assertAlgorithmFields(record.completion,['kind','value'],'pure completion');
  if(!['return','throw'].includes(record.completion.kind))fail('completion kind');assertAlgorithmValue(record.completion.value);
  for(const claim of record.claims){
    assertAlgorithmFields(claim,claim.kind==='compute'?['step','kind','id','result']:['step','kind','value'],'pure claim');
    if(!Number.isSafeInteger(claim.step)||claim.step<0)fail('claim step');
    if(claim.kind==='compute'){if(typeof claim.id!=='string')fail('claim identity');assertAlgorithmValue(claim.result);}
    else {if(!['return','throw'].includes(claim.kind))fail('claim kind');assertAlgorithmValue(claim.value);}
  }
  const ids=new Set();
  for(const node of record.allocations){
    if(ids.has(node.id))fail('duplicate allocation');ids.add(node.id);
    algorithmHeapNode(new Map([[node.id,node]]),node.id);
  }
  const line='algorithm '+stableAlgorithmJSON(record);if(Buffer.byteLength(line)>65536)fail('record byte bound');return line;
}
export function decodePureRegionRecord(line){
  if(typeof line!=='string'||!line.startsWith('algorithm ')||/[\r\n]/.test(line)||Buffer.byteLength(line)>65536)fail('canonical algorithm record required');
  let record;try{record=JSON.parse(line.slice(10));}catch{fail('algorithm record JSON');}
  if(encodePureRegionRecord(record)!==line)fail('noncanonical algorithm record');return record;
}
