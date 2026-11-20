#!/usr/bin/env node
// Re-evaluate the declared public component programs against the current state
// definition. These component fixtures do not claim independent source admission.
import {readFileSync,writeFileSync} from 'node:fs';
import {createProtocolStateV8,applyProtocolRecordV8,restoreProtocolStateV8,snapshotProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';

const check=process.argv.slice(2).includes('--check');
if(process.argv.slice(2).some(arg=>arg!=='--check'))throw Error('Usage: generate-protocol-machine-fixtures.mjs [--check]');
const path=new URL('../test/fixtures/semantic-protocol-v8.json',import.meta.url);
const document=JSON.parse(readFileSync(path,'utf8'));
for(const row of document.cases){
  const initial=structuredClone(row.initialState),old=initial.protocol;
  if(old.sequence!==0||old.pendingCalls.length||old.callFrames.length||old.symbols.some(symbol=>symbol.kind!=='well-known'))
    throw Error('Component fixture requires an explicit fresh protocol entry: '+row.id);
  initial.protocol=createProtocolStateV8();
  const controller={...initial,ready:[],effects:new Map(),jobs:new Map(),strictRequests:false};
  for(const key of ['locals','captureAliases','frameFunctions'])controller[key]=new Map(initial[key]);
  controller.heap=new Map(initial.heap.map(([id,node])=>[id,{...node,properties:new Map(node.properties),
    ...(node.descriptors?{descriptors:new Map(node.descriptors)}:{})}]));
  restoreProtocolStateV8(controller,initial.protocol);
  for(const line of row.lines)applyProtocolRecordV8(controller,decodeProtocolRecordV8(line));
  const expected=Object.fromEntries(Object.keys(initial).map(key=>[key,key==='heap'?[...controller.heap].map(([id,node])=>[id,
    {...node,properties:[...node.properties],...(node.descriptors?{descriptors:[...node.descriptors]}:{})}]):
    key==='protocol'?snapshotProtocolStateV8(controller):controller[key] instanceof Map?[...controller[key]]:controller[key]]));
  row.initialState=initial;row.expected=JSON.parse(JSON.stringify(expected));
}
const bytes=JSON.stringify(document,null,2)+'\n';
if(check){if(readFileSync(path,'utf8')!==bytes)throw Error('Regenerate protocol machine fixtures');}
else writeFileSync(path,bytes);
console.log(JSON.stringify({valid:true,cases:document.cases.length,mode:check?'checked':'generated'}));
