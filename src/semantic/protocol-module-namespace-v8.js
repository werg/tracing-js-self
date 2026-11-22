// Public namespace transitions share the selected controller's actual lexical
// cells and heap. Original-source authority is provided separately by rechecking.
import {isDeepStrictEqual} from 'node:util';
import {assertAlgorithmFields,assertAlgorithmDataArray,assertAlgorithmValue} from './ir.js';
import {verifyExperimentalModuleNamespacePlan} from './module-namespace-state-v8.js';

export const MODULE_NAMESPACE_PROFILE_V8='module-namespace-live-cells/1';
export const MODULE_NAMESPACE_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'cell.initialize':['kind','cell','loweredName','value'],
  'cell.write':['kind','cell','loweredName','value'],
  'namespace.create':['kind','namespaceId','moduleFile'],
  'namespace.keys':['kind','namespaceId','names','resultId'],
  'namespace.read':['kind','namespaceId','exportName','value'],
  'namespace.descriptor':['kind','namespaceId','exportName','value','resultId']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const copy=structuredClone,eq=isDeepStrictEqual,ID=/^o[1-9][0-9]*$/;
const nodeFields=['id','kind','prototype','extensible','namespacePlanDigest','namespaceFile',
  'namespaceName','namespaceExports','namespaceExportNames','properties'];
const fail=message=>{throw new TypeError('Module namespace v8: '+message);};
const demand=(condition,message)=>{if(!condition)fail(message);};
const identity=value=>demand(typeof value==='string'&&ID.test(value),'fresh public heap identity required');
function scalar(value){
  demand(Array.isArray(value)&&['undefined','null','bool','str','num','bigint'].includes(value[0]),
    'namespace-backed cells require scalar values');
  assertAlgorithmValue(value,{allowReference:false});return value;
}
function plan(controller,required=false){
  const value=controller.moduleNamespacePlan;
  if(value===undefined||value===null){demand(!required,'source-derived namespace plan is required');return null;}
  verifyExperimentalModuleNamespacePlan(value);return value;
}
function resolved(controller,name){
  demand(typeof name==='string'&&name.length>0&&name.length<=256,'binding identity');
  const target=controller.captureAliases?.get(name)??name;
  demand(typeof target==='string'&&target.length>0&&target.length<=256,'captured binding identity');
  return target;
}
function backedCells(value){
  const ids=new Set(value.namespaces.flatMap(row=>row.exports.map(item=>item.cell)));
  return value.cells.filter(cell=>ids.has(cell.id));
}
function protectedNames(controller,value){
  return new Set([...backedCells(value).map(cell=>cell.loweredName),
    ...value.namespaces.map(row=>row.namespaceName)].map(name=>resolved(controller,name)));
}
function namespace(value,file){
  const row=value.namespaces.find(item=>item.file===file);
  demand(row,'namespace has no source-owned linker row');
  const cells=new Map(value.cells.map(cell=>[cell.id,cell]));
  return {file:row.file,namespaceName:row.namespaceName,exports:row.exports.map(item=>{
    const cell=cells.get(item.cell);
    return {name:item.name,cell:item.cell,loweredName:cell.loweredName,mutable:cell.mutable};
  })};
}
function checkNode(controller,value,id){
  const node=controller.heap.get(id);
  demand(node,'namespace heap object is absent');
  assertAlgorithmFields(node,nodeFields,'module namespace heap node');
  const expected=namespace(value,node.namespaceFile);
  demand(node.id===id&&node.kind==='module-namespace'&&node.prototype===null&&node.extensible===false&&
    node.namespacePlanDigest===value.digest&&node.namespaceName===expected.namespaceName&&
    eq(node.namespaceExports,expected.exports)&&eq(node.namespaceExportNames,expected.exports.map(item=>item.name))&&
    node.properties instanceof Map&&eq([...node.properties],[[['symbol','well-known:toStringTag'],['str','Module']]]),
    'namespace heap object differs from its source-owned plan');
  return expected;
}
function currentCell(controller,cell){
  const name=resolved(controller,cell.loweredName);
  demand(controller.locals.has(name),'TDZ namespace read');
  return scalar(controller.locals.get(name));
}
function descriptor(value){return {value:copy(value),writable:true,enumerable:true,configurable:false};}
export function validateModuleNamespaceRecordV8(record){
  const fields=MODULE_NAMESPACE_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'module namespace record');
  if(record.kind.startsWith('cell.')){
    demand(typeof record.cell==='string'&&record.cell.length>0&&typeof record.loweredName==='string'&&
      record.loweredName.length>0&&record.loweredName.length<=256,'source cell identity');
    scalar(record.value);return true;
  }
  identity(record.namespaceId);
  if(record.kind==='namespace.create'){
    demand(typeof record.moduleFile==='string'&&record.moduleFile.length>0,'namespace module file');
  }else if(record.kind==='namespace.keys'){
    identity(record.resultId);assertAlgorithmDataArray(record.names,'namespace keys');
    demand(record.names.length<=4096&&record.names.every(name=>typeof name==='string'),'namespace keys');
  }else{
    demand(typeof record.exportName==='string'&&record.exportName.length>0,'namespace export name');
    if(record.kind==='namespace.read')scalar(record.value);
    else{
      identity(record.resultId);
      assertAlgorithmFields(record.value,['value','writable','enumerable','configurable'],'namespace descriptor');
      scalar(record.value.value);
      demand(record.value.writable===true&&record.value.enumerable===true&&record.value.configurable===false,
        'namespace descriptor flags');
    }
  }
  return true;
}
export function assertModuleNamespaceNextV8(controller,record){
  const value=plan(controller);
  if(!value)return true;
  const fields=record.fields??record;
  const target=record.kind==='bind'?fields.name:
    ['compute','symbol.read'].includes(record.kind)?fields.bind:null;
  if(target!==undefined&&target!==null)
    demand(!protectedNames(controller,value).has(resolved(controller,target)),
      'namespace owner and source cells require their declared lifecycle records');
  return true;
}
export function applyModuleNamespaceRecordV8(controller,record,api){
  if(!Object.hasOwn(MODULE_NAMESPACE_RECORD_FIELDS,record.kind))return false;
  const value=plan(controller,true);
  demand(controller.stack.length>0&&!controller.completion&&!api.state(controller).pendingCalls.length,
    'namespace transitions require an active invocation without pending property calls');
  if(record.kind.startsWith('cell.')){
    const cell=backedCells(value).find(item=>item.id===record.cell);
    demand(cell&&cell.loweredName===record.loweredName,'source cell identity differs from linker');
    const storage=resolved(controller,cell.loweredName);
    if(record.kind==='cell.initialize')demand(!controller.locals.has(storage),'duplicate source cell initialization');
    else demand(cell.mutable&&controller.locals.has(storage),
      cell.mutable?'source cell write before initialization':'write to immutable source cell');
    controller.locals.set(storage,copy(scalar(record.value)));return true;
  }
  if(record.kind==='namespace.create'){
    const expected=namespace(value,record.moduleFile),owner=resolved(controller,expected.namespaceName);
    api.fresh(controller,record.namespaceId);
    demand(!controller.locals.has(owner),'namespace owner binding already exists');
    demand(![...controller.heap.values()].some(node=>node.kind==='module-namespace'&&
      node.namespaceFile===expected.file),'duplicate namespace identity');
    controller.heap.set(record.namespaceId,{id:record.namespaceId,kind:'module-namespace',prototype:null,
      extensible:false,namespacePlanDigest:value.digest,namespaceFile:expected.file,
      namespaceName:expected.namespaceName,namespaceExports:copy(expected.exports),
      namespaceExportNames:expected.exports.map(item=>item.name),
      properties:new Map([[['symbol','well-known:toStringTag'],['str','Module']]])});
    controller.locals.set(owner,['ref',record.namespaceId]);return true;
  }
  const expected=checkNode(controller,value,record.namespaceId);
  let properties,objectKind,length;
  if(record.kind==='namespace.keys'){
    const names=expected.exports.map(item=>item.name);
    demand(eq(record.names,names),'namespace keys differ from source order');
    // Object.keys reads each export descriptor, including TDZ checks.
    for(const cell of expected.exports)currentCell(controller,cell);
    objectKind='array';length=names.length;
    properties=names.map((name,index)=>({key:['str',String(index)],value:['str',name]}));
  }else{
    const cell=expected.exports.find(item=>item.name===record.exportName);
    demand(cell,'namespace export absent');
    const current=currentCell(controller,cell);
    if(record.kind==='namespace.read'){
      demand(eq(record.value,current),'namespace read differs from current source cell');return true;
    }
    demand(eq(record.value,descriptor(current)),'namespace descriptor differs from current source cell');
    objectKind='object';length=0;
    properties=[{key:['str','value'],value:copy(current)},
      {key:['str','writable'],value:['bool',true]},
      {key:['str','enumerable'],value:['bool',true]},
      {key:['str','configurable'],value:['bool',false]}];
  }
  api.allocate(controller,{kind:'allocate',name:record.resultId,objectKind,length,properties,
    code:null,captures:[],functionKind:null,lexicalReceiver:null});
  return true;
}
export function restoreModuleNamespaceStateV8(controller){
  const value=plan(controller),nodes=[...controller.heap].filter(([,node])=>node.kind==='module-namespace');
  if(!value){demand(nodes.length===0,'namespace heap lacks its published source plan');return {valid:true};}
  const files=new Set(),names=new Set();
  for(const [id]of nodes){
    identity(id);const expected=checkNode(controller,value,id);
    demand(!files.has(expected.file)&&!names.has(expected.namespaceName),'duplicate restored namespace');
    files.add(expected.file);names.add(expected.namespaceName);
    demand(eq(controller.locals.get(resolved(controller,expected.namespaceName)),['ref',id]),
      'restored namespace binding differs from heap identity');
  }
  for(const cell of backedCells(value)){
    const name=resolved(controller,cell.loweredName);
    if(controller.locals.has(name))scalar(controller.locals.get(name));
  }
  return {valid:true};
}
export function assertModuleNamespaceTransitionV8(before,after,record){
  const value=plan(before);
  if(!value)return true;
  const logicalNames=[...backedCells(value).map(cell=>cell.loweredName),...value.namespaces.map(row=>row.namespaceName)];
  for(const name of logicalNames)demand(resolved(before,name)===resolved(after,name),
    'ordinary transition changed the source-owned cell mapping');
  if(!Object.hasOwn(MODULE_NAMESPACE_RECORD_FIELDS,record.kind)){
    const beforeNodes=[...before.heap].filter(([,node])=>node.kind==='module-namespace'),
      afterNodes=[...after.heap].filter(([,node])=>node.kind==='module-namespace');
    demand(eq(beforeNodes,afterNodes),'ordinary transition changed an exotic namespace heap object');
    const names=new Set([...protectedNames(before,value),...protectedNames(after,value)]);
    for(const name of names)demand(before.locals.has(name)===after.locals.has(name)&&
      eq(before.locals.get(name),after.locals.get(name)),
      'ordinary transition changed a namespace owner or live source cell');
  }
  restoreModuleNamespaceStateV8(after);return true;
}
