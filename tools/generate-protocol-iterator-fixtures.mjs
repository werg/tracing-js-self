#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {createProtocolStateV8,applyProtocolRecordV8,PROTOCOL_MACHINE_API_V8 as api} from '../src/semantic/protocol-state-v8.js';
import {PROTOCOL_RECORD_V8_FIELDS,validateProtocolValueV8} from '../src/semantic/protocol-codec-v8.js';
import {validateIteratorRecordV8,applyIteratorRecordV8,restoreIteratorStateV8} from '../src/semantic/protocol-iterator-v8.js';

const array=(name,length,properties=[])=>({kind:'allocate',name,objectKind:'array',length,properties,
  code:null,captures:[],functionKind:null,lexicalReceiver:null});
const write=(object,key,value)=>({kind:'property.set',object,key:['str',key],receiver:['ref',object],value,success:true});
const next=(object,name,result,done=false,entry=null)=>({kind:'iterator.next',object,name,entry,result,done});
const terminal=[{kind:'return',invocation:'invocation1',value:['num',3]},{kind:'end',completion:'return'}];
const inputs=[
  {id:'holes-live-length-and-exhaustion',records:[array('o1',2,[{key:['str','1'],value:['num',2]}]),
    {kind:'iterator.lookup',receiver:['ref','o1'],key:['str','values'],method:'Array.prototype.values'},
    {kind:'iterator.create',name:'o2',iterated:['ref','o1'],iterationKind:'values'},
    next('o2','o3',['undefined']),next('o2','o4',['num',2]),write('o1','2',['num',3]),
    next('o2','o5',['num',3]),next('o2','o6',['undefined'],true),write('o1','3',['num',4]),
    next('o2','o7',['undefined'],true),...terminal]},
  {id:'entry-pair-allocation',records:[array('o1',2,[{key:['str','0'],value:['num','-0']},{key:['str','1'],value:['num','NaN']}]),
    {kind:'iterator.create',name:'o2',iterated:['ref','o1'],iterationKind:'entries'},
    next('o2','o4',['ref','o3'],false,'o3'),next('o2','o6',['ref','o5'],false,'o5'),next('o2','o7',['undefined'],true),...terminal]},
  {id:'unicode-string-cursor',records:[{kind:'iterator.create',name:'o1',iterated:['str','a😀\ud800'],iterationKind:'string'},
    next('o1','o2',['str','a']),next('o1','o3',['str','😀']),next('o1','o4',['str','\ud800']),
    next('o1','o5',['undefined'],true),{kind:'iterator.identity',object:'o1',result:['ref','o1']},...terminal]}
];
function wire(c){return JSON.parse(JSON.stringify(Object.fromEntries(['heap','locals','captureAliases','receiver','stack',
  'frameFunctions','pending','lastReturn','completion','protocol'].map(key=>[key,key==='heap'?[...c.heap].map(([id,node])=>[id,
    {...node,properties:[...node.properties],...(node.descriptors?{descriptors:[...node.descriptors]}:{})}]):
    c[key] instanceof Map?[...c[key]]:c[key]]))));}
const cases=inputs.map(({id,records})=>{
  const c={heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],stack:['invocation1'],
    frameFunctions:new Map([['invocation1','run']]),pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8()};
  const initialState=wire(c),lines=[];
  for(const record of records){
    if(PROTOCOL_RECORD_V8_FIELDS[record.kind])applyProtocolRecordV8(c,record);
    else{validateIteratorRecordV8(record,{value:validateProtocolValueV8});const staged=structuredClone(c);
      if(applyIteratorRecordV8(staged,record,api)!==true)throw new TypeError('Unknown iterator fixture record');
      staged.protocol.sequence++;Object.assign(c,staged);}
    restoreIteratorStateV8(c,api);lines.push('protocol '+stableAlgorithmJSON(record));
  }
  return {id,qualification:'controller-contract-fixture',source:null,entry:'run',args:[],initialState,lines,checkpoints:[3],expected:wire(c)};
});
writeFileSync(new URL('../test/fixtures/semantic-iterator-v8.json',import.meta.url),JSON.stringify({
  schema:'semantic-protocol-fixtures/1',profile:'builtin-iterator/1',cases},null,2)+'\n');
console.log('Generated '+cases.length+' builtin iterator protocol fixtures.');
