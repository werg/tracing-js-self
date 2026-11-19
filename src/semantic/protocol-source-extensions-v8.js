// Statically registered teacher-only source adapters. Serving input cannot
// install these adapters, and the independent worker never imports this file.
import {memorySourceAdapterV8} from './protocol-memory-source-v8.js';
import {createConstructionSourceAdapterV8} from './protocol-construction-source-v8.js';
import {createIteratorSourceAdapterV8} from './protocol-iterator-source-v8.js';
import {createPromiseJoinSourceAdapterV8} from './protocol-promise-join-source-v8.js';
import {createNumberSourceAdapterV8} from './protocol-number-source-v8.js';
import {createProxySourceAdapterV8} from './protocol-proxy-source-v8.js';
import {createGeneratorSourceAdapterV8} from './protocol-generator-source-v8.js';
export const PROTOCOL_SOURCE_ADAPTERS_V8=Object.freeze([memorySourceAdapterV8,createGeneratorSourceAdapterV8,createConstructionSourceAdapterV8,createIteratorSourceAdapterV8,createPromiseJoinSourceAdapterV8,createNumberSourceAdapterV8,createProxySourceAdapterV8]);
