// Statically registered teacher-only source adapters. Serving input cannot
// install these adapters, and the independent worker never imports this file.
import {createCompletionSourceAdapterV8} from './protocol-completion-source-v8.js';
import {memorySourceAdapterV8} from './protocol-memory-source-v8.js';
import {createConstructionSourceAdapterV8} from './protocol-construction-source-v8.js';
import {createIteratorSourceAdapterV8} from './protocol-iterator-source-v8.js';
import {createCustomIteratorSourceAdapterV8} from './protocol-custom-iterator-source-v8.js';
import {createPromiseJoinSourceAdapterV8} from './protocol-promise-join-source-v8.js';
import {createNumberSourceAdapterV8} from './protocol-number-source-v8.js';
import {createProxySourceAdapterV8} from './protocol-proxy-source-v8.js';
import {createGeneratorSourceAdapterV8} from './protocol-generator-source-v8.js';
import {createPromiseExecutorSourceAdapterV8} from './protocol-promise-executor-source-v8.js';
import {createArrayMapSourceAdapterV8} from './protocol-array-map-source-v8.js';
import {createEnumerationSourceAdapterV8} from './protocol-enumeration-source-v8.js';
export const PROTOCOL_SOURCE_ADAPTERS_V8=Object.freeze([memorySourceAdapterV8,createGeneratorSourceAdapterV8,createConstructionSourceAdapterV8,createIteratorSourceAdapterV8,createCustomIteratorSourceAdapterV8,createPromiseJoinSourceAdapterV8,createPromiseExecutorSourceAdapterV8,createNumberSourceAdapterV8,createProxySourceAdapterV8,createArrayMapSourceAdapterV8,createEnumerationSourceAdapterV8,createCompletionSourceAdapterV8]);
