import {REGION_LIMITS,REGION_PROGRAM_VERSION,REGION_EXECUTION_VERSION,REGION_TRACE_VERSION,
  REGION_CONTEXT_VERSION,REGION_CONTINUATION_VERSION,REGION_PROFILE} from './regions.js';
import {ALGORITHM_V8_SCHEMA,ALGORITHM_V8_PROFILE,ALGORITHM_V8_LIMITS,ALGORITHM_V8_INPUT_TYPES,
  ALGORITHM_V8_OPERATION_METADATA,TRAVERSAL_MODES} from './algorithm-v8.js';
import {SEMANTIC_RECORD_SCHEMA as WITNESS_SCHEMA} from './record-schema.js';
import {hashAlgorithmData} from './program.js';
import {V8_LIFECYCLE_CONTRACT} from './lifecycle-v8.js';
import {LIFECYCLE_RECORD_SCHEMAS,SELECTED_STATE_FIELDS} from './lifecycle-schema.js';
import {PROTOCOL_RECORD_V8_SCHEMA,PROTOCOL_RECORD_V8_FIELDS} from './protocol-codec-v8.js';
import {PROTOCOL_STATE_V8_SCHEMA,PROTOCOL_STATE_V8_FIELDS,PROTOCOL_V8_LIMITS} from './protocol-state-v8.js';
import {MEMORY_PROFILE_V8,MEMORY_HEAP_FIELDS_V8} from './protocol-memory-v8.js';
import {CONSTRUCTION_STATE_V8_SCHEMA,CONSTRUCTION_STATE_V8_FIELDS,CALLABLE_STATE_V8_FIELDS,
  CONSTRUCTION_FRAME_V8_FIELDS} from './protocol-construction-v8.js';
import {ITERATOR_PROFILE_V8,ITERATOR_HEAP_FIELDS} from './protocol-iterator-v8.js';
import {ENUMERATION_PROFILE_V8,ENUMERATION_HEAP_FIELDS,ENUMERATION_LIMITS_V8} from './protocol-enumeration-v8.js';
import {PROMISE_JOIN_PROFILE_V8,PROMISE_JOIN_STATE_V8} from './protocol-promise-join-v8.js';
import {NUMBER_STATE_V8_SCHEMA,NUMBER_OPERATION_FIELDS} from './protocol-number-v8.js';
import {GENERATOR_PROFILE_V8,GENERATOR_HEAP_FIELDS,GENERATOR_INTRINSICS_V8} from './protocol-generator-v8.js';
import {PROXY_PROFILE_V8,PROXY_STATE_V8_SCHEMA,PROXY_HEAP_FIELDS,PROXY_CALL_FIELDS} from './protocol-proxy-v8.js';
import {PROTOCOL_MACHINE_ADAPTERS_V8} from './protocol-machine-extensions-v8.js';
import {PROMISE_EXECUTOR_PROFILE_V8,PROMISE_EXECUTOR_STATE_V8} from './protocol-promise-executor-v8.js';

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
      meaning:'Direct V8 detail codec over version-neutral typed selected transitions; no legacy wire conversion.'},
    protocol:{schema:PROTOCOL_RECORD_V8_SCHEMA,prefix:'protocol ',fieldsByKind:PROTOCOL_RECORD_V8_FIELDS,
      expressionKinds:['literal','local','unary','binary','logical-test'],
      logicalTest:{fields:['op','operator','arg'],operators:['&&','||','??'],
        decision:'Boolean derived only from the current operand: && tests falsiness, || tests truthiness, ?? tests non-nullishness. No future right operand is included.',
        logicalPaths:{true:'use-left',false:'evaluate-right'},optionalGuardPaths:{true:'then',false:'else'}},
      profile:'symbols-ordinary-properties/1',extensions:PROTOCOL_MACHINE_ADAPTERS_V8.map(adapter=>adapter.id),limits:PROTOCOL_V8_LIMITS,
      meaning:'Checked Symbol identities, descriptors, receiver-aware access, scoped calls, construction, iterators, ordinary enumeration, generators, Number conversion, Promise joins and executors, Proxy traps and binary memory in the same authoritative heap.'}
  },
  algorithm:{schema:ALGORITHM_V8_SCHEMA,profile:ALGORITHM_V8_PROFILE,limits:ALGORITHM_V8_LIMITS,
    inputTypes:ALGORITHM_V8_INPUT_TYPES,traversalModes:TRAVERSAL_MODES,operations:ALGORITHM_V8_OPERATION_METADATA},
  lifecycle:{...V8_LIFECYCLE_CONTRACT,records:LIFECYCLE_RECORD_SCHEMAS,selectedStateFields:SELECTED_STATE_FIELDS,
    intentRecord:'Original canonical V8 detail bytes',
    recovery:'Replay acknowledged lifecycle records; restored dispatched work is uncertain and is never redispatched without explicit reconciliation.'},
  contextFields:['schema','representation','profile','invocationId','programs','input','state','regionCursor','obligations','visibleThrough','prefixDigest'],
  sharedStateFields:['heap','locals','stack','effects','jobs','ready','randomState','pending','lastReturn','completion',
    'receiver','captureAliases','continuations','reactionSequence','blockedSync','callReturn','activeJob','scheduler','frameFunctions','jobErrors','protocol'],
  protocolState:{schema:PROTOCOL_STATE_V8_SCHEMA,fields:PROTOCOL_STATE_V8_FIELDS,initial:null,
    heap:'Existing heap nodes with property, descriptor and private-element Maps serialized as entry arrays; Symbol keys remain tagged pairs.',
    construction:{schema:CONSTRUCTION_STATE_V8_SCHEMA,fields:CONSTRUCTION_STATE_V8_FIELDS,initial:null,
      callableFields:CALLABLE_STATE_V8_FIELDS,frameFields:CONSTRUCTION_FRAME_V8_FIELDS,
      privateElementFields:['kind','value','version'],
      sourceCallables:'Explicit function source offsets and source-inventoried class:<offset>:constructor|instance|static bodies.',
      continuations:'Owned base/derived constructor receivers, newTarget, field initializers and captured superclass selection; private fields and methods retain declaring-class identities.'},
    iterators:{profile:ITERATOR_PROFILE_V8,heapFields:ITERATOR_HEAP_FIELDS,
      capabilities:'Builtin array keys/values/entries and Unicode string iteration, live array length, sticky exhaustion and explicit result/pair allocation identities.'},
    ordinaryCompletions:{schema:'semantic-handler-scopes/1',fields:['schema','frames'],
      frameFields:['invocation','handlers'],optionalFrameFields:['targets'],
      handlerFields:['id','catch','finally','phase','caught','pending'],
      targetFields:['id','continue'],pendingKinds:['normal','return','throw','break','continue'],
      pendingFields:['kind','value'],optionalPendingFields:['target'],maxHandlersPerFrame:64,maxTargetsPerFrame:64,
      capabilities:'Ordinary synchronous catch/finally scopes retain pending completion and bounded loop target identities. Break and continue targets belong to the same frame; only loop targets permit continue. Source qualification privately checks destinations without publishing bytecode.'},
    customIteration:{profile:'custom-iterator-source/1',
      capabilities:'Ordinary synchronous custom for-of and flat variable array bindings use checked properties, cached next and receiver cells, scoped calls, and ordinary cleanup. Independent observations check acquisition, done/value reads, and IteratorClose order and precedence.',
      boundaries:'Malformed intrinsic TypeErrors, asynchronous iteration, and nested or assignment pattern source projection require separate qualification; runtime execution alone does not admit them.'},
    enumeration:{profile:ENUMERATION_PROFILE_V8,heapFields:ENUMERATION_HEAP_FIELDS,limits:ENUMERATION_LIMITS_V8,
      chainFields:['id','prototype','keys'],
      capabilities:'Stable ordinary for-in snapshots preserve own-key order, prototype walks, nonenumerable shadowing and fresh per-step result identities. Value writes are live; changed key/prototype structure is refused on the next step.'},
    promiseJoins:{profile:PROMISE_JOIN_PROFILE_V8,schema:PROMISE_JOIN_STATE_V8,modes:['all','race'],
      fields:['schema','mode','inputs','jobs','observed','values','settled','output','error'],
      jobFields:['status','owner','promise','reaction','closure','rejectionClosure','target','sequence','joinResult','joinIndex','readySequence'],
      capabilities:'Ordered Promise dependencies, FIFO internal jobs, first settlement and explicit late no-op steps; fresh result arrays are named only when allocated.'},
    numberConversions:{profile:'number-conversion/1',schema:NUMBER_STATE_V8_SCHEMA,fields:['schema','operations'],initial:null,
      operationFields:NUMBER_OPERATION_FIELDS,phases:['select','call','builtin','waiting','convert','complete','abrupt'],
      capabilities:'Live data-method selection, original receiver and number hint, shared callback scopes, ordered ordinary fallback and checked primitive conversion. Synchronous callback throws preserve their completion through catch/finally and suppress fallback. Accessor selection, intrinsic TypeErrors and exotic conversion remain separate profiles.'},
    generators:{profile:GENERATOR_PROFILE_V8,heapFields:GENERATOR_HEAP_FIELDS,intrinsicPrototypes:GENERATOR_INTRINSICS_V8,
      phases:['initializing','suspendedStart','executing','suspendedYield','completed'],methods:['next','return','throw'],
      handlerFields:['name','catch','finally','phase','caught','pending'],
      delegationFields:['iterator','next','request','phase','result'],
      capabilities:'Retained invocations, receivers, arguments and captures; sent values, catch/finally cleanup, suspension and cached-next delegation through declared builtin iterators and synchronous generators.'},
    proxyCalls:{profile:PROXY_PROFILE_V8,schema:PROXY_STATE_V8_SCHEMA,fields:['schema','pending'],initial:null,
      heapFields:PROXY_HEAP_FIELDS,callFields:PROXY_CALL_FIELDS,
      capabilities:'Distinct Proxy, target and handler identities; ordinary data forwarding and synchronous owned get/set traps with live target invariants and exact pending callback completion. Callable or revoked proxies and other traps require explicit profiles.'},
    promiseExecutors:{profile:PROMISE_EXECUTOR_PROFILE_V8,schema:PROMISE_EXECUTOR_STATE_V8,
      fields:['schema','capabilities','executors'],capabilityFields:['promise','resolve','reject','called','resolution'],
      executorFields:['promise','parent','child','phase','completion'],
      resolverFields:['promise','mode'],
      capabilities:'Synchronous source executor calls, stable resolving function identities, a shared first-call cell, retained resolvers, primitive or owned Promise resolution, and executor throw rejection. Thenables, self resolution and async executor bodies require separate profiles.'},
    binaryMemory:{profile:MEMORY_PROFILE_V8,heapFields:MEMORY_HEAP_FIELDS_V8,maxBufferBytes:1024,
      typedArrayByteOrder:'little-endian',dataViewByteOrder:'explicit per operation',
      capabilities:'Fixed ordinary buffers and fixed/growable shared buffers; scalar conversions; shared view identities; bounded single-agent atomic operations. No detach, transfer, host buffers or cross-agent scheduling.'},
    lifecycle:'One fresh invocation without external host work. Declared ordinary catch/finally and loop cleanup use checked transfer detail. Declared Promise joins and executors may use internal Promise, await, resume, job and transfer detail; join steps require an empty stack and the FIFO ready head. External observations remain outside protocol profiles.'},
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
