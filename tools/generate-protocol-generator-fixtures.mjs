#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {createProtocolStateV8,applyProtocolRecordV8,PROTOCOL_MACHINE_API_V8 as api} from '../src/semantic/protocol-state-v8.js';
import {PROTOCOL_RECORD_V8_FIELDS,validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {validateGeneratorRecordV8,applyGeneratorRecordV8,restoreGeneratorStateV8,assertGeneratorNextV8} from '../src/semantic/protocol-generator-v8.js';
const ref=id=>['ref',id],num=n=>['num',n],U=['undefined'];
const start=[{kind:'allocate',name:'fn',objectKind:'closure',length:null,properties:[],code:'g',captures:[],functionKind:'ordinary',lexicalReceiver:null},
  {kind:'generator.function',object:'fn',prototype:'proto',name:'g',length:1},
  {kind:'generator.create',name:'it',child:'generator1',callee:ref('fn'),receiver:U,arguments:[num(3)]},
  {kind:'generator.start',object:'it'}];
const resume=argument=>[{kind:'generator.resume',object:'it',method:'next',argument},{kind:'generator.receive',object:'it',bind:null}];
const terminal=[{kind:'return',invocation:'invocation1',value:num(3)},{kind:'end',completion:'return'}];
const inputs=[
  {id:'normal-sent-value-and-completion',checkpoints:[4,7,8],records:[...start,...resume(num(99)),{kind:'generator.yield',object:'it',value:num(3),name:'yielded'},
    {kind:'generator.resume',object:'it',method:'next',argument:num(7)},{kind:'generator.receive',object:'it',bind:'sent'},
    {kind:'compute',expr:{op:'binary',operator:'+',left:{op:'local',name:'sent'},right:{op:'literal',value:num(1)}},result:num(8),bind:'answer'},
    {kind:'generator.finish',object:'it',completion:{kind:'return',value:num(8)},name:'returned'},
    {kind:'generator.completed',object:'it',method:'next',argument:U,name:'done'},...terminal]},
  {id:'return-before-body-start',checkpoints:[4],records:[...start,{kind:'generator.completed',object:'it',method:'return',argument:num(9),name:'returned'},...terminal]},
  {id:'throw-after-yield',checkpoints:[7,8],records:[...start,...resume(U),{kind:'generator.yield',object:'it',value:num(1),name:'yielded'},
    {kind:'generator.resume',object:'it',method:'throw',argument:num(4)},
    {kind:'generator.finish',object:'it',completion:{kind:'throw',value:num(4)},name:null},
    {kind:'generator.completed',object:'it',method:'next',argument:U,name:'done'},...terminal]}
];
function wire(c){return JSON.parse(JSON.stringify(Object.fromEntries(['heap','locals','captureAliases','receiver','stack','frameFunctions','pending','lastReturn','completion','protocol']
  .map(key=>[key,key==='heap'?[...c.heap].map(([id,node])=>[id,{...node,properties:[...node.properties],...(node.descriptors?{descriptors:[...node.descriptors]}:{})}]):
    c[key] instanceof Map?[...c[key]]:c[key]]))));}
const cases=inputs.map(({id,checkpoints,records})=>{
  const c={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:U,stack:['invocation1'],frameFunctions:new Map([['invocation1','run']]),
    pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};const initialState=wire(c),lines=[];
  for(const record of records){
    assertGeneratorNextV8(c,record,api);
    if(PROTOCOL_RECORD_V8_FIELDS[record.kind])applyProtocolRecordV8(c,record);
    else{validateGeneratorRecordV8(record,{value:validateProtocolValueV8});const staged=structuredClone(c);
      if(applyGeneratorRecordV8(staged,record,api)!==true)throw new TypeError('Unknown generator fixture record');staged.protocol.sequence++;Object.assign(c,staged);}
    restoreGeneratorStateV8(c,api);lines.push('protocol '+stableAlgorithmJSON(record));
  }
  return {id,qualification:'controller-contract-fixture',source:null,entry:'run',args:[],initialState,lines,checkpoints,expected:wire(c)};
});
writeFileSync(new URL('../test/fixtures/semantic-generator-v8.json',import.meta.url),JSON.stringify({schema:'semantic-protocol-fixtures/1',profile:'synchronous-generator/1',cases},null,2)+'\n');
console.log('Generated '+cases.length+' synchronous generator fixtures.');
