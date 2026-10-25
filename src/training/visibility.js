// Immutable initial context: static source and supplied entry graph only.
// No executed-site filtering or future result/dispatch metadata.
import {describeOwnedGraph} from './graph.js';
import {analyzeSemanticProgram} from './semantic-program.js';
import {encodeWitness,EXECUTION_VERSION,CONTEXT_VERSION,WITNESS_VERSION} from './format.js';

export function trainingPrefix(bundle,{maxSourceBytes=65536}={}){
  if(bundle.manifest?.profile!=='training-js/1'||bundle.entrySpec?.kind!=='function')
    throw new TypeError('Missing owned training entry');
  const source=bundle.sources.find(s=>s.sourceId===bundle.entrySpec.sourceId);
  if(!source)throw new TypeError('Entry source is unavailable');
  if(Buffer.byteLength(source.text,'utf8')>maxSourceBytes)
    throw new RangeError('Static source exceeds declared publication bound');
  const program=analyzeSemanticProgram(source.text);
  const initial=describeOwnedGraph(bundle.initialState.heap,bundle.entrySpec.arguments);
  const named=new Map(),objects=[];
  for(const obj of initial.objects)named.set(obj.id,'o'+(named.size+1));
  function translate(v) {
    return v[0]==='ref'?['ref',named.get(v[1])]:structuredClone(v);
  }
  const graph={roots:initial.roots.map(translate),
    objects:initial.objects.map(x=>({id:named.get(x.id),kind:x.kind,
      ...(x.prototype===null?{prototype:null}:{}),
      properties:x.properties.map(p=>({key:p.key,value:translate(p.value)}))}))};
  return {schema:CONTEXT_VERSION,program,
    source:encodeWitness('code',{entry:bundle.entrySpec.functionName,
      // Source positions and AST inventory remain private compiler evidence.
      // The model can read the source itself without a redundant site table.
      source:source.text,sites:[],
      ...(bundle.initialState.control.a0.randomSeed!==undefined?
        {randomSeed:bundle.initialState.control.a0.randomSeed}:{})}),
    input:encodeWitness('input',{graph})};
}

export function verifyVisibleExport(exported) {
  const pub=exported?.public;
  if(!pub||pub.schema!==EXECUTION_VERSION||pub.traceFormat!==WITNESS_VERSION||
     pub.contextFormat!==CONTEXT_VERSION||
     pub.completionPolicy!=='immediate-root'||
     !Array.isArray(pub.groups)||pub.groups.length<4)
    throw new TypeError('Only complete version-three public demonstrations are permitted');
  if(Object.keys(pub).some(key=>!
    ['schema','profile','traceFormat','contextFormat','completionPolicy','groups'].includes(key)))
    throw new TypeError('Unexpected predictor-visible envelope');
  for(const group of pub.groups)
    if(!['observed','generated'].includes(group.mode)||
       group.loss!==(group.mode==='observed'?'none':'semantic'))
      throw new TypeError('Invalid observed/generated supervision ownership');
  return true;
}
