// Statically registered teacher-only source adapters. Serving input cannot
// install these adapters, and the independent worker never imports this file.
import {memorySourceAdapterV8} from './protocol-memory-source-v8.js';
import {createIteratorSourceAdapterV8} from './protocol-iterator-source-v8.js';
export const PROTOCOL_SOURCE_ADAPTERS_V8=Object.freeze([memorySourceAdapterV8,createIteratorSourceAdapterV8]);
