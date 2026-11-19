// Rooted observable graphs preserve aliases, absence, property order and input
// identity, while irrelevant private allocations and their labels disappear.
import {isDeepStrictEqual} from 'node:util';
import {assertAlgorithmValue,assertAlgorithmId,stableAlgorithmJSON,isAlgorithmDataRecord,
  assertAlgorithmDataArray} from './ir.js';

export const OBSERVATION_CONTRACT_VERSION='semantic-observation/1';
const copy=value=>structuredClone(value);
const plain=isAlgorithmDataRecord;

function canonicalGraph(graph,{inputIds=[]}={}){
  if(!plain(graph)||!Array.isArray(graph.roots)||!Array.isArray(graph.objects)||
    Object.keys(graph).some(key=>!['roots','objects'].includes(key)))throw new TypeError('Observable graph schema');
  assertAlgorithmDataArray(graph.roots,'observable roots');assertAlgorithmDataArray(graph.objects,'observable objects');
  const source=new Map(),ids=new Map(),objects=[],active=new Set();
  for(const node of graph.objects){
    if(!plain(node)||!['object','array'].includes(node.kind)||!Array.isArray(node.properties)||
      Object.keys(node).some(key=>!['id','kind','prototype','properties','shapeVersion'].includes(key)))
      throw new TypeError('Observable object schema');
    assertAlgorithmDataArray(node.properties,'observable properties');
    assertAlgorithmId(node.id);
    if(source.has(node.id))throw new TypeError('Duplicate observable identity');
    if(node.prototype!==undefined&&node.prototype!==null)throw new TypeError('Observable prototype profile');
    if(node.kind==='array'&&node.prototype===null)throw new TypeError('Observable array prototype');
    source.set(node.id,node);
  }
  if(!Array.isArray(inputIds)||new Set(inputIds).size!==inputIds.length)
    throw new TypeError('Observable input identity anchors');
  assertAlgorithmDataArray(inputIds,'input identity anchors');
  inputIds.forEach((id,i)=>{if(!source.has(id))throw new TypeError('Missing input identity anchor');ids.set(id,'i'+i);});
  let fresh=0;
  function value(tag){
    assertAlgorithmValue(tag);
    if(tag[0]!=='ref')return copy(tag);
    const id=tag[1],node=source.get(id);
    if(!node)throw new TypeError('Dangling observable identity '+id);
    if(!ids.has(id))ids.set(id,'g'+fresh++);
    if(!active.has(id)){
      active.add(id);
      const row={id:ids.get(id),kind:node.kind,...(node.prototype===null?{prototype:null}:{}),properties:[]};
      objects.push(row);
      const keys=new Set();
      for(const prop of node.properties){
        let key,child;
        if(Array.isArray(prop)&&prop.length===2){assertAlgorithmDataArray(prop,'observable property');[key,child]=prop;}
        else if(plain(prop)&&Object.hasOwn(prop,'key')&&Object.hasOwn(prop,'value')&&
          Object.keys(prop).every(field=>['key','value','version'].includes(field))){key=prop.key;child=prop.value;}
        else throw new TypeError('Observable data property');
        if(typeof key!=='string'||key==='__proto__'||keys.has(key))throw new TypeError('Observable property identity');
        keys.add(key);row.properties.push([key,value(child)]);
      }
      if(node.kind==='array'){
        const length=row.properties.find(([key])=>key==='length')?.[1];
        if(length?.[0]!=='num'||!Number.isSafeInteger(length[1])||length[1]<0)
          throw new TypeError('Observable array length');
      }
    }
    return ['ref',ids.get(id)];
  }
  // Input anchors are roots of the observation contract even if the returned
  // value is a scalar. This keeps mutation of otherwise unreturned inputs.
  inputIds.forEach(id=>value(['ref',id]));
  const roots=graph.roots.map(value);
  return {graph:{roots,objects},ids,rewrite:value};
}

export function canonicalObservableGraph(graph,options={}){return canonicalGraph(graph,options).graph;}
export function compareObservableGraphs(left,right,{leftInputIds=[],rightInputIds=[]}={}){
  try{
    if(leftInputIds.length!==rightInputIds.length)return {equal:false,reason:'Input identity anchor arity differs'};
    const a=canonicalObservableGraph(left,{inputIds:leftInputIds}),b=canonicalObservableGraph(right,{inputIds:rightInputIds});
    const equal=isDeepStrictEqual(a,b);
    return {equal,...(equal?{}:{reason:'Rooted observable state or alias relationship differs'}),left:a,right:b};
  }catch(error){return {equal:false,reason:error.message};}
}

export function canonicalObservables(observation,{inputIds=[]}={}){
  if(!plain(observation)||observation.schema!==OBSERVATION_CONTRACT_VERSION||
    !plain(observation.completion)||!Array.isArray(observation.effects)||!Array.isArray(observation.observations)||
    !Object.hasOwn(observation,'continuation')||
    Object.keys(observation).some(key=>!['schema','completion','graph','effects','observations','continuation'].includes(key)))
    throw new TypeError('Observation contract schema');
  assertAlgorithmDataArray(observation.effects,'observable effects');
  assertAlgorithmDataArray(observation.observations,'observable deliveries');
  const graph=canonicalGraph(observation.graph,{inputIds}),effectIds=new Map();
  function rewrite(value){
    if(Array.isArray(value)){
      assertAlgorithmDataArray(value,'observable data');
      if(['undefined','null','bool','str','num','bigint','ref'].includes(value[0]))return graph.rewrite(value);
      return value.map(rewrite);
    }
    if(value!==null&&typeof value==='object'){
      if(!plain(value))throw new TypeError('Observable data must have no hooks');
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item)]));
    }
    return value;
  }
  const completion=observation.completion;
  if(!['return','throw','suspend','unsupported','internal-failure'].includes(completion.kind))
    throw new TypeError('Observation completion kind');
  if(['return','throw'].includes(completion.kind))assertAlgorithmValue(completion.value);
  if(completion.kind==='suspend'&&observation.continuation===null)throw new TypeError('Suspension needs live continuation state');
  const effects=observation.effects.map((effect,index)=>{
    if(!plain(effect)||typeof effect.id!=='string'||effectIds.has(effect.id)||
      typeof effect.operation!=='string'||!effect.operation||!Array.isArray(effect.arguments))
      throw new TypeError('Observable effect contract');
    effectIds.set(effect.id,'e'+index);
    return {...rewrite(effect),id:'e'+index};
  });
  const delivered=new Set();
  const observations=observation.observations.map(row=>{
    if(!plain(row)||!effectIds.has(row.effect)||delivered.has(row.effect)||
      !['fulfilled','rejected','completed'].includes(row.status))
      throw new TypeError('Observable response correlation');
    delivered.add(row.effect);
    return {...rewrite(row),effect:effectIds.get(row.effect)};
  });
  const result={schema:OBSERVATION_CONTRACT_VERSION,completion:rewrite(completion),graph:graph.graph,
    effects,observations,continuation:rewrite(observation.continuation)};
  stableAlgorithmJSON(result);return result;
}
export function compareObservables(left,right,{leftInputIds=[],rightInputIds=[]}={}){
  try{
    if(leftInputIds.length!==rightInputIds.length)return {equal:false,reason:'Input identity anchor arity differs'};
    const a=canonicalObservables(left,{inputIds:leftInputIds}),b=canonicalObservables(right,{inputIds:rightInputIds});
    const equal=isDeepStrictEqual(a,b);
    return {equal,...(equal?{}:{reason:'Completion, visible state, effects, observations, or continuation differs'})};
  }catch(error){return {equal:false,reason:error.message};}
}
