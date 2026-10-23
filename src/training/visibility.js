// Public projection. Never serialize a checkpoint, future result, validation
// answer, arrival payload, event patch, archive hash or undispatched input.
import {describeOwnedGraph} from './graph.js';
import {encodeRecord} from './format.js';

export function trainingPrefix(bundle,{maxSourceBytes=2048}={}) {
  if(bundle.manifest?.profile!=='training-js/1' || bundle.entrySpec?.kind!=='function')
    throw new TypeError('Not a training-js/1 function invocation');
  if(bundle.sources.length!==1)throw new RangeError('Only single-source bundles are admitted in training-js/1');
  const source=bundle.sources[0];
  if(source.parser!=='acorn/8.15.0:training-js/1')
    throw new TypeError('Unverified training parser');
  if(Buffer.byteLength(source.text,'utf8')>maxSourceBytes)
    throw new RangeError('Source exceeds initial bundle limit; code-on-call is not enabled');
  const roots=bundle.entrySpec.arguments;
  const graph=describeOwnedGraph(bundle.initialState.heap,roots);
  const sites=bundle.sites.map(s=>({id:s.siteId,code:s.codeId,start:s.start,end:s.end}));
  const codes=Object.values(bundle.programs).map(p=>({id:p.id,params:p.params,async:p.async,
    restIndex:p.restIndex??-1}));
  const global=bundle.initialState.envs[bundle.initialState.control.a0.globalEnvId];
  const staticFunctions=Object.entries(global.bindings).flatMap(([name,binding])=>{
    const value=binding.token?.value;
    const fn=value?.[0]==='ref' && bundle.initialState.heap[value[1]];
    return fn?.kind==='function' ? [{name,identity:value[1],code:fn.codeId,
      captures:fn.closureEnvId}] : [];
  });
  const staticRegExps=Object.entries(global.bindings).flatMap(([name,binding])=>{
    const value=binding.token?.value;
    const regex=value?.[0]==='ref' && bundle.initialState.heap[value[1]];
    return regex?.kind==='regexp' ? [{name,identity:value[1],
      pattern:regex.properties['[[Source]]'].value[1],
      flags:regex.properties['[[Flags]]'].value[1]}] : [];
  });
  return {
    schema:'semantic-context/2',
    source:encodeRecord('code',{sourceId:source.sourceId,text:source.text,codes,sites,staticFunctions,
      ...(staticRegExps.length?{staticRegExps}:{}),
      ...(bundle.initialState.control.a0.randomSeed!==undefined ?
        {randomSeed:bundle.initialState.control.a0.randomSeed}: {})}),
    input:encodeRecord('value',{entry:bundle.entrySpec.functionName,
      invocation:bundle.initialState.control.a0.activeFrameId,graph})
  };
}

export function verifyVisibleExport(exported) {
  const allowed=['schema','profile','traceFormat','contextFormat','completionPolicy','groups'];
  const keys=Object.keys(exported.public??{});
  if(keys.length!==allowed.length || !keys.every(key=>allowed.includes(key)))
    throw new Error('Unexpected public export field');
  const descriptor=exported.public;
  if(descriptor.profile!=='training-js/1' || descriptor.traceFormat!=='semantic-trace/2' ||
     descriptor.contextFormat!=='semantic-context/2' ||
     descriptor.completionPolicy!=='immediate-return')
    throw new Error('Invalid public export descriptor');
  if(exported.public.schema!=='semantic-execution/2')throw new Error('Unknown training export');
  if(!Array.isArray(exported.public.groups)||!exported.public.groups.length)
    throw new Error('Missing meridians');
  if(exported.public.groups[0].mode!=='observed')
    throw new Error('Episode requires an observed source prefix');
  return true;
}
