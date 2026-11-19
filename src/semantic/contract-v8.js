import {REGION_LIMITS,REGION_PROGRAM_VERSION,REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,
  REGION_CONTEXT_VERSION,REGION_CONTINUATION_VERSION,REGION_PROFILE} from './regions.js';
import {ALGORITHM_V8_SCHEMA,ALGORITHM_V8_PROFILE,ALGORITHM_V8_LIMITS,ALGORITHM_V8_INPUT_TYPES,
  ALGORITHM_V8_OPERATION_METADATA,TRAVERSAL_MODES} from './algorithm-v8.js';
import {WITNESS_SCHEMA} from '../training/format.js';
import {hashAlgorithmData} from './program.js';
import {PROTOCOL_RECORD_V8_SCHEMA,PROTOCOL_RECORD_V8_FIELDS} from './protocol-codec-v8.js';
import {PROTOCOL_STATE_V8_SCHEMA,PROTOCOL_STATE_V8_FIELDS,PROTOCOL_V8_LIMITS} from './protocol-state-v8.js';

export const SEMANTIC_V8_DEFINITION=Object.freeze({
  execution:REGION_EXECUTION_VERSION,trace:REGION_TRACE_VERSION,context:REGION_CONTEXT_VERSION,
  continuation:REGION_CONTINUATION_VERSION,profile:REGION_PROFILE,representation:'mixed',
  publicFields:['schema','traceFormat','contextFormat','representation','profile','timeline'],
  envelopeFields:['sequence','mode','kind','fields'],
  program:{schema:REGION_PROGRAM_VERSION,fields:['schema','traceFormat','profile','source','entry','sourceDigest','regions','algorithm','definitionDigest'],
    sourceCorrespondence:'Independently rechecked producer evidence; public hashes alone do not certify source truth.'},
  entry:{fields:['definition','region','regionDigest','visibleThrough','stateDigest'],
    authority:'trusted-host-envelope',supervised:false,state:'entire shared continuation'},
  records:{
    region:{prefix:'region ',fields:['region','bindings','decisions','completion'],profile:'local-primitive-block/1',
      termKinds:['literal','local','unary','binary','logical','select'],completionKinds:['normal','return'],limits:REGION_LIMITS},
    algorithm:{prefix:'algorithm ',fields:['claims','allocations','completion'],profile:'pure-algorithm-region/1',
      allocationMapping:'Retain all input identities. Map new core identities in allocation order to the first unused oN identity. Preserve aliases and ECMAScript own-key order.'},
    detail:{prefix:'detail ',fields:['kind','fields'],witnessSchema:WITNESS_SCHEMA,
      meaning:'Existing checked selected-detailed/1 transitions, committed into the same shared machine.'},
    protocol:{schema:PROTOCOL_RECORD_V8_SCHEMA,prefix:'protocol ',fieldsByKind:PROTOCOL_RECORD_V8_FIELDS,
      profile:'symbols-ordinary-properties/1',limits:PROTOCOL_V8_LIMITS,
      meaning:'Checked Symbol identities, descriptors, receiver-aware access, scoped calls and completion in the same authoritative heap.'}
  },
  algorithm:{schema:ALGORITHM_V8_SCHEMA,profile:ALGORITHM_V8_PROFILE,limits:ALGORITHM_V8_LIMITS,
    inputTypes:ALGORITHM_V8_INPUT_TYPES,traversalModes:TRAVERSAL_MODES,operations:ALGORITHM_V8_OPERATION_METADATA},
  contextFields:['schema','representation','profile','invocationId','programs','input','state','regionCursor','obligations','visibleThrough','prefixDigest'],
  sharedStateFields:['heap','locals','stack','effects','jobs','ready','randomState','pending','lastReturn','completion',
    'receiver','captureAliases','continuations','reactionSequence','blockedSync','callReturn','activeJob','scheduler','frameFunctions','jobErrors','protocol'],
  protocolState:{schema:PROTOCOL_STATE_V8_SCHEMA,fields:PROTOCOL_STATE_V8_FIELDS,initial:null,
    heap:'Existing heap nodes with property and descriptor Maps serialized as entry arrays; Symbol keys remain tagged pairs.',
    lifecycle:'First protocol profile is one synchronous fresh invocation with no host work, jobs or asynchronous observations.'},
  checkpoint:{fields:['schema','profile','public','regionCursor','selected','integrity'],
    protocolSelected:{schema:'semantic-protocol-continuation/1',fields:['schema','invocations'],
      meaning:'Exact shared states and activation statuses independently reconstructed from the complete public v8 history.'},
    restore:'Validate public mixed replay and exact shared state. Restore existing intent/handler lifecycle without invoking adapters.'},
  supervision:{generated:'Only exact generated semantic line bytes and framing EOS.',
    observed:'Definitions, entry envelopes, inputs, dispatch receipts and external results have zero prediction loss.',
    private:'Source archives, correspondence maps, future observations, reference outcomes and receipt sidecars never enter prompts.'},
  promotion:{source:'required',intermediateClaims:'required',native:'exact pinned consumer required',
    tokenizer:'exact serialized input and whole-sequence encoding required',model:'external results or explicit untested disposition',
    default:'not promoted by engineering receipts alone'}
});
export function semanticV8Contract(fixtures=[],interoperability=[]){return {schema:'semantic-execution-contract/8',
  definition:SEMANTIC_V8_DEFINITION,digest:hashAlgorithmData(SEMANTIC_V8_DEFINITION),
  fixtureDigest:hashAlgorithmData(fixtures),fixtures,
  interoperabilityDigest:hashAlgorithmData(interoperability),interoperability};}
