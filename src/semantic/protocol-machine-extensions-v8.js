// Explicit public operation/state extensions. Registration changes the pinned
// contract and requires independent consumer parity before production admission.
import {MEMORY_PROFILE_V8,MEMORY_RECORD_FIELDS,validateMemoryRecordV8,applyMemoryRecordV8,restoreMemoryStateV8} from './protocol-memory-v8.js';
import {isBinaryMemoryKind} from '../binary-memory-validation.js';
export const PROTOCOL_MACHINE_ADAPTERS_V8=Object.freeze([Object.freeze({
  id:MEMORY_PROFILE_V8,recordFields:MEMORY_RECORD_FIELDS,validateRecord:validateMemoryRecordV8,applyRecord:applyMemoryRecordV8,
  hasRichState:node=>isBinaryMemoryKind(node.kind),
  restoreState:(controller,_snapshot,api)=>restoreMemoryStateV8(controller,api)
})]);
