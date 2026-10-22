// Public projection. Never serialize a checkpoint, future result, validation
// answer, arrival payload, event patch, archive hash or undispatched input.
import {realizeGraph,describeGraph} from './graph.js';
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
  const graph=describeGraph(realizeGraph(bundle.initialState.heap,roots));
  const sites=bundle.sites.map(s=>({id:s.siteId,code:s.codeId,start:s.start,end:s.end}));
  const codes=Object.values(bundle.programs).map(p=>({id:p.id,params:p.params,async:p.async}));
  return {
    schema:'semantic-context/1',
    source:encodeRecord('code',{sourceId:source.sourceId,text:source.text,codes,sites}),
    input:encodeRecord('value',{entry:bundle.entrySpec.functionName,
      invocation:bundle.initialState.control.a0.activeFrameId,graph})
  };
}

export function verifyVisibleExport(exported) {
  const serialized=JSON.stringify(exported.public);
  for(const forbidden of ['finalState','initialState','checkpoints','stateChanges',
    'inputArrivals','referenceOutcome','journalMapping','archiveHash','part_count']){
    if(Object.hasOwn(exported.public,forbidden))
      throw new Error('Private state exposed in public record: '+forbidden);
  }
  if(exported.public.schema!=='semantic-execution/1')throw new Error('Unknown training export');
  if(!Array.isArray(exported.public.groups)||!exported.public.groups.length)
    throw new Error('Missing meridians');
  if(exported.public.groups[0].mode!=='observed')
    throw new Error('Episode requires an observed source prefix');
  if(!serialized.includes('semantic-context/1'))
    throw new Error('Missing source/input context');
  return true;
}
