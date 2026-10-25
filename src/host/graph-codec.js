// An explicit data-graph codec for boundaries that preserve JavaScript values.
// The JSON API codec intentionally remains narrower. This codec never invokes
// accessors, coercions, proxies or guest functions while taking a snapshot.
import {encode,decode} from '../values.js';
import {inspectDataObject} from '../training/data-graph-contract.js';

export const GRAPH_CODEC='owned-graph/1';
const own=Object.hasOwn;
const identity=/^[a-z][a-z0-9:_-]*$/;
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const callbackHandles=new WeakMap();
export const ownedCallbackId=value=>value&&typeof value==='object'?callbackHandles.get(value)??null:null;
function callbackHandle(id){const handle=Object.freeze({$ownedCallback:id});callbackHandles.set(handle,id);return handle;}
function requireValue(condition,message){if(!condition)throw new TypeError(message);}
function bounded(options={}){
  const limits={maxNodes:256,maxProperties:4096,maxDepth:64,maxBytes:65536,...options};
  for(const name of ['maxNodes','maxProperties','maxDepth','maxBytes'])
    requireValue(Number.isSafeInteger(limits[name])&&limits[name]>0,'Invalid graph codec '+name);
  return limits;
}
function scalar(value){
  requireValue(Array.isArray(value),'Graph values require canonical tags');
  let canonical;
  try{canonical=encode(decode(value));}catch{throw new TypeError('Unsupported graph scalar');}
  requireValue(JSON.stringify(canonical)===JSON.stringify(value),'Noncanonical graph scalar');
  return canonical;
}
function finish(graph,limits){
  const payload=JSON.stringify(graph),byteLength=Buffer.byteLength(payload,'utf8');
  if(byteLength>limits.maxBytes)throw new RangeError('External graph payload limit');
  return {codec:GRAPH_CODEC,payload,byteLength};
}

/** Snapshot already-owned values, including sparse arrays, aliases and cycles. */
export function materializeOwnedGraph(heap,args,options={}){
  const limits=bounded(options),callbacks=new Set(options.callbackIndices??[]);
  requireValue(isObject(heap)&&Array.isArray(args),'Expected owned heap and argument list');
  const objects=[],seen=new Set(),versions=[];
  let properties=0;
  function visit(value,depth){
    requireValue(Array.isArray(value),'Invalid owned graph value');
    if(value[0]!=='ref')return scalar(value);
    requireValue(value.length===2&&typeof value[1]==='string'&&identity.test(value[1]),
      'Invalid owned graph reference');
    const id=value[1];
    if(seen.has(id))return ['ref',id];
    if(depth>limits.maxDepth||seen.size>=limits.maxNodes)
      throw new RangeError('External graph depth or node limit');
    requireValue(own(heap,id),'Unresolved owned graph reference');
    const entity=heap[id];
    if(options.callbackGraph&&['function','closure'].includes(entity?.kind))return ['callback',id];
    requireValue(entity&&['object','array'].includes(entity.kind)&&isObject(entity.properties),
      'Only declared data identities cross this operation');
    requireValue(Object.keys(entity.accessors??{}).length===0,
      'Owned accessors cannot be materialized');
    const validPrototypes=entity.kind==='array'?
      [undefined,'ordinary','Array.prototype']:[undefined,null,'ordinary','Object.prototype'];
    requireValue(validPrototypes.includes(entity.prototype),'Custom graph prototype refused');
    seen.add(id);
    const node={id,kind:entity.kind,...(entity.prototype===null?{prototype:null}:{}),properties:[]};
    objects.push(node);
    const version={id,version:entity.version??0,shapeVersion:entity.shapeVersion??0,properties:{}};
    versions.push(version);
    for(const key of Object.keys(entity.properties)){
      if(++properties>limits.maxProperties)throw new RangeError('External graph property limit');
      requireValue(key!=='__proto__','Prototype mutation key refused');
      const slot=Object.getOwnPropertyDescriptor(entity.properties,key);
      requireValue(slot&&own(slot,'value')&&slot.value&&own(slot.value,'value'),
        'Owned properties require value descriptors');
      node.properties.push({key,value:visit(slot.value.value,depth+1)});
      version.properties[key]=entity.propertyVersions?.[key]??0;
    }
    if(entity.kind==='array'){
      const length=node.properties.find(p=>p.key==='length')?.value;
      requireValue(length?.[0]==='num'&&Number.isSafeInteger(length[1])&&
        length[1]>=0&&length[1]<=limits.maxProperties,'External array length limit');
      for(const prop of node.properties)
        requireValue(!/^(0|[1-9][0-9]*)$/.test(prop.key)||Number(prop.key)<length[1],
          'Array index outside declared length');
    }
    Object.freeze(version.properties);Object.freeze(version);
    return ['ref',id];
  }
  const roots=args.map((value,index)=>{
    if(!callbacks.has(index))return visit(value,0);
    const id=value?.[0]==='ref'&&value.length===2?value[1]:null;
    requireValue(typeof id==='string'&&['function','closure'].includes(heap[id]?.kind),
      'Callback argument requires an owned closure');
    return ['callback',id];
  });
  const graph={schema:GRAPH_CODEC,roots,objects};
  return Object.freeze({...finish(graph,limits),graphVersions:Object.freeze(versions)});
}

/** Validate before constructing any native data; arbitrary native objects are
 * never treated as callable handles. Callback markers need a separate bridge. */
export function validateOwnedGraph(graph,options={}){
  const limits=bounded(options);
  requireValue(isObject(graph)&&Object.keys(graph).sort().join(',')==='objects,roots,schema'&&
    graph.schema===GRAPH_CODEC&&Array.isArray(graph.roots)&&Array.isArray(graph.objects),
    'Invalid owned graph envelope');
  requireValue(graph.objects.length<=limits.maxNodes,'External graph node limit');
  const known=new Map();let count=0;
  for(const node of graph.objects){
    requireValue(isObject(node)&&typeof node.id==='string'&&identity.test(node.id)&&
      !known.has(node.id)&&['object','array'].includes(node.kind)&&Array.isArray(node.properties)&&
      Object.keys(node).every(k=>['id','kind','prototype','properties'].includes(k))&&
      (!own(node,'prototype')||(node.kind==='object'&&node.prototype===null)),
      'Invalid owned graph identity');
    known.set(node.id,node);
  }
  function value(v,callback=false){
    if(v?.[0]==='ref')requireValue(v.length===2&&known.has(v[1]),'Dangling owned graph reference');
    else if((callback||options.callbackGraph)&&v?.[0]==='callback')requireValue(v.length===2&&typeof v[1]==='string'&&
      identity.test(v[1]),'Invalid callback identity');
    else scalar(v);
  }
  for(const [index,root] of graph.roots.entries())value(root,(options.callbackIndices??[]).includes(index));
  for(const node of graph.objects){
    const keys=new Set();
    for(const prop of node.properties){
      requireValue(isObject(prop)&&Object.keys(prop).sort().join(',')==='key,value'&&
        typeof prop.key==='string'&&prop.key!=='__proto__'&&!keys.has(prop.key),
        'Invalid owned graph property');
      if(++count>limits.maxProperties)throw new RangeError('External graph property limit');
      keys.add(prop.key);value(prop.value);
    }
    if(node.kind==='array'){
      const length=node.properties.find(p=>p.key==='length')?.value;
      requireValue(length?.[0]==='num'&&Number.isSafeInteger(length[1])&&length[1]>=0&&
        length[1]<=limits.maxProperties,'Invalid owned array length');
      for(const key of keys)requireValue(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)<length[1],
        'Array index outside declared length');
    }
  }
  finish(graph,limits);
  return graph;
}

export function decodeOwnedGraph(payload,options={}){
  requireValue(typeof payload==='string','Owned graph payload must be text');
  const limits=bounded(options);
  if(Buffer.byteLength(payload,'utf8')>limits.maxBytes)throw new RangeError('External graph payload limit');
  const graph=JSON.parse(payload);
  requireValue(JSON.stringify(graph)===payload,'Noncanonical owned graph bytes');
  validateOwnedGraph(graph,options);
  const values=new Map(graph.objects.map(node=>[node.id,node.kind==='array'?
    new Array(node.properties.find(p=>p.key==='length').value[1]):
    node.prototype===null?Object.create(null):{}]));
  const visit=value=>value[0]==='ref'?values.get(value[1]):value[0]==='callback'?
    callbackHandle(value[1]):decode(value);
  for(const node of graph.objects)for(const prop of node.properties)
    if(node.kind!=='array'||prop.key!=='length')Object.defineProperty(values.get(node.id),prop.key,
      {value:visit(prop.value),enumerable:true,writable:true,configurable:true});
  return graph.roots.map(visit);
}

/** Snapshot trusted adapter results using descriptor inspection, not JSON
 * serialization of native objects. The returned graph is plain transport data. */
export function encodeNativeGraph(roots,options={}){
  const limits=bounded(options),seen=new WeakMap(),objects=[];let count=0;
  requireValue(Array.isArray(roots),'Native graph roots must be an argument list');
  function visit(value,depth){
    if(value===null||typeof value!=='object')return encode(value);
    if(seen.has(value))return ['ref',seen.get(value)];
    if(depth>limits.maxDepth||objects.length>=limits.maxNodes)
      throw new RangeError('External graph depth or node limit');
    const {kind,prototype,descriptors}=inspectDataObject(value);
    const id='o'+objects.length;seen.set(value,id);
    const node={id,kind,...(prototype===null?{prototype:null}:{}),properties:[]};objects.push(node);
    for(const [key,desc] of descriptors){
      if(++count>limits.maxProperties)throw new RangeError('External graph property limit');
      node.properties.push({key,value:visit(desc.value,depth+1)});
    }
    return ['ref',id];
  }
  const graph={schema:GRAPH_CODEC,roots:roots.map(v=>visit(v,0)),objects};
  validateOwnedGraph(graph,limits);return graph;
}
