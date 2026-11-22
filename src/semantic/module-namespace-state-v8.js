// Experimental, unadmitted source-bound module namespace state contract.
// This module is intentionally not registered with the public source projector.
// It describes only namespace identity, live export cells, own keys, reads and
// own descriptors. It does not authorize a producer/native admission claim.
import {isDeepStrictEqual} from 'node:util';
import {hashAlgorithmData} from './program.js';

const HASH=/^[a-f0-9]{64}$/;
const LOWERED_LOCAL=/^__traced_eval_m[1-9][0-9]*_[A-Za-z_$][A-Za-z0-9_$]*$/;
const copy=structuredClone;
const own=Object.hasOwn;
const fail=message=>{throw new TypeError('Experimental module namespace/1: '+message);};
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(key=>own(value,key));
const canonicalPath=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&
  !value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const arrayIndexName=value=>{
  if(!/^(0|[1-9][0-9]*)$/.test(value))return false;
  const number=Number(value);
  return Number.isSafeInteger(number)&&number<=0xfffffffe&&String(number)===value;
};
const name=value=>typeof value==='string'&&value.length>0&&!arrayIndexName(value);
const cmp=(left,right)=>left<right?-1:left>right?1:0;
const mutableKind=kind=>kind!=='const';
const canonicalValue=value=>{
  if(!Array.isArray(value))return false;
  if(value.length===1)return value[0]==='undefined'||value[0]==='null';
  if(value.length!==2)return false;
  if(value[0]==='bool')return typeof value[1]==='boolean';
  if(value[0]==='str')return typeof value[1]==='string';
  if(value[0]==='bigint')return typeof value[1]==='string'&&/^(?:0|-?[1-9][0-9]*)$/.test(value[1]);
  if(value[0]==='num')return typeof value[1]==='number'&&Number.isFinite(value[1])&&!Object.is(value[1],-0)||
    ['-0','NaN','+Infinity','-Infinity'].includes(value[1]);
  return false;
};
const cellId=(file,local)=>file+'#'+local;

/** Build the source/linker-owned export-to-cell table used by experimental
 * transition checks. Callers must obtain records from the canonical module
 * linker; accepting caller-created records does not confer admission. */
export function buildExperimentalModuleNamespacePlan({modules,entryModule,namespaces,cells}={}){
  if(!modules||typeof modules!=='object'||Array.isArray(modules)||
     !canonicalPath(entryModule)||!own(modules,entryModule)||!Array.isArray(namespaces)||!Array.isArray(cells))
    fail('module graph, entry or linker records are malformed');
  const files=Object.keys(modules).sort();
  if(files.length<1||files.length>64||files.some(file=>!canonicalPath(file)||
      typeof modules[file]!=='string'||modules[file].length>65536))
    fail('module graph exceeds bounds or contains an invalid source');
  const cellMap=new Map();
  for(const cell of cells){
    if(!exact(cell,['file','local','kind','mutable','loweredName'])||typeof cell.mutable!=='boolean'||!canonicalPath(cell.file)||
       !own(modules,cell.file)||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cell.local)||
       typeof cell.loweredName!=='string'||!LOWERED_LOCAL.test(cell.loweredName)||
       !['let','const','function','class','var'].includes(cell.kind)||cell.mutable!==mutableKind(cell.kind))
      fail('canonical source cell record is malformed');
    const id=cellId(cell.file,cell.local);
    if(cellMap.has(id)||[...cellMap.values()].some(row=>row.loweredName===cell.loweredName))
      fail('duplicate canonical source cell or lowered binding');
    cellMap.set(id,{id,file:cell.file,local:cell.local,kind:cell.kind,mutable:mutableKind(cell.kind),
      loweredName:cell.loweredName});
  }
  const namespaceMap=new Map();
  for(const record of namespaces){
    if(!exact(record,['file','exports'])||!canonicalPath(record.file)||!own(modules,record.file)||
       !Array.isArray(record.exports)||namespaceMap.has(record.file))
      fail('namespace link record is malformed or duplicated');
    let previous=null;
    const exports=record.exports.map(entry=>{
      if(!exact(entry,['name','file','local'])||!name(entry.name)||
         !canonicalPath(entry.file)||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry.local))
        fail('namespace export binding record is malformed');
      const id=cellId(entry.file,entry.local);
      if(!cellMap.has(id))fail('namespace export does not resolve to a declared source cell');
      if(previous!==null&&previous>=entry.name)fail('namespace exports must be unique and lexically sorted');
      previous=entry.name;
      return {name:entry.name,cell:id};
    });
    namespaceMap.set(record.file,{file:record.file,exports});
  }
  const body={schema:'semantic-module-namespace-plan/1',entryModule,
    modules:files.map(file=>({file,sourceDigest:hashAlgorithmData(modules[file])})),
    cells:[...cellMap.values()].sort((a,b)=>cmp(a.id,b.id)),
    namespaces:[...namespaceMap.values()].sort((a,b)=>cmp(a.file,b.file))};
  return {...body,digest:hashAlgorithmData(body)};
}

/** Convert the canonical linker's explicit module-source plan into the
 * independent experimental state plan. The linker output is rederived from
 * supplied source by module-v8 before this helper may be called. */
export function buildExperimentalModuleNamespacePlanFromLinker(linked){
  const metadata=linked?.metadata,modules=metadata?.modules,sourcePlan=metadata?.namespaceSourcePlan;
  if(metadata?.profile!=='evaluated-module/1'||!Array.isArray(modules)||
     !sourcePlan||!Array.isArray(sourcePlan.cells)||!Array.isArray(sourcePlan.namespaces))
    fail('canonical linker namespace source plan is missing');
  const sources=Object.create(null);
  for(const row of modules){
    if(!exact(row,['file','source','transpiler','sourceMap'])||own(sources,row.file))
      fail('canonical linker module source table is malformed');
    sources[row.file]=row.source;
  }
  return buildExperimentalModuleNamespacePlan({
    modules:sources,entryModule:metadata.entryModule,
    cells:sourcePlan.cells,namespaces:sourcePlan.namespaces
  });
}

export function createExperimentalModuleNamespaceState(plan,initialCells={}){
  verifyExperimentalModuleNamespacePlan(plan);
  if(!initialCells||typeof initialCells!=='object'||Array.isArray(initialCells))fail('initial cells are malformed');
  const declared=new Map(plan.cells.map(cell=>[cell.id,cell]));
  if(Object.keys(initialCells).some(id=>!declared.has(id)))fail('initial state contains an undeclared source cell');
  const cells=Object.create(null);
  for(const cell of plan.cells){
    const initial=initialCells[cell.id];
    if(initial===undefined){
      cells[cell.id]={initialized:false,value:null,version:0};
    }else{
      if(!exact(initial,['initialized','value'])||typeof initial.initialized!=='boolean'||
         initial.initialized&&!canonicalValue(initial.value))fail('initial cell value is malformed');
      cells[cell.id]={initialized:initial.initialized,value:initial.initialized?copy(initial.value):null,version:0};
    }
  }
  return {schema:'semantic-module-namespace-state/1',planDigest:plan.digest,cells,namespaces:Object.create(null)};
}

export function verifyExperimentalModuleNamespacePlan(plan){
  const fields=['schema','entryModule','modules','cells','namespaces','digest'];
  if(!exact(plan,fields)||plan.schema!=='semantic-module-namespace-plan/1'||
     !HASH.test(plan.digest??'')||!Array.isArray(plan.modules)||plan.modules.length<1||plan.modules.length>64||
     !Array.isArray(plan.cells)||plan.cells.length>4096||
     !Array.isArray(plan.namespaces)||plan.namespaces.length>64)
    fail('namespace plan integrity differs');
  let prior=null;const files=new Set();
  for(const row of plan.modules){
    if(!exact(row,['file','sourceDigest'])||!canonicalPath(row.file)||!HASH.test(row.sourceDigest??'')||
       prior!==null&&prior>=row.file)fail('namespace plan module table is malformed');
    prior=row.file;files.add(row.file);
  }
  if(!files.has(plan.entryModule))fail('namespace plan entry is absent');
  prior=null;const cells=new Set(),loweredNames=new Set();
  for(const row of plan.cells){
    if(!exact(row,['id','file','local','kind','mutable','loweredName'])||!canonicalPath(row.file)||!files.has(row.file)||
       !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(row.local)||!['let','const','function','class','var'].includes(row.kind)||
       typeof row.mutable!=='boolean'||row.mutable!==mutableKind(row.kind)||row.id!==cellId(row.file,row.local)||
       typeof row.loweredName!=='string'||!LOWERED_LOCAL.test(row.loweredName)||
       prior!==null&&prior>=row.id)fail('namespace plan cell table is malformed');
    if(loweredNames.has(row.loweredName))fail('namespace plan lowered binding is duplicated');
    prior=row.id;cells.add(row.id);loweredNames.add(row.loweredName);
  }
  prior=null;const namespaceFiles=new Set();
  for(const row of plan.namespaces){
    if(!exact(row,['file','exports'])||!canonicalPath(row.file)||!files.has(row.file)||
       namespaceFiles.has(row.file)||prior!==null&&prior>=row.file||!Array.isArray(row.exports))
      fail('namespace plan namespace table is malformed');
    prior=row.file;namespaceFiles.add(row.file);
    let previous=null;
    for(const entry of row.exports){
      if(!exact(entry,['name','cell'])||!name(entry.name)||!cells.has(entry.cell)||
         previous!==null&&previous>=entry.name)fail('namespace plan export table is malformed');
      previous=entry.name;
    }
  }
  const body=Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='digest'));
  if(plan.digest!==hashAlgorithmData(body))fail('namespace plan integrity differs');
  return true;
}

function verifyState(plan,state){
  if(!exact(state,['schema','planDigest','cells','namespaces'])||
     state.schema!=='semantic-module-namespace-state/1'||state.planDigest!==plan.digest||
     !state.cells||typeof state.cells!=='object'||Array.isArray(state.cells)||
     !state.namespaces||typeof state.namespaces!=='object'||Array.isArray(state.namespaces)||
     !isDeepStrictEqual(Object.keys(state.cells).sort(),plan.cells.map(row=>row.id).sort()))
    fail('state is not bound to the canonical source plan');
  for(const cell of plan.cells){
    const value=state.cells[cell.id];
    if(!exact(value,['initialized','value','version'])||typeof value.initialized!=='boolean'||
       !Number.isSafeInteger(value.version)||value.version<0||
       value.initialized&&!canonicalValue(value.value)||!value.initialized&&value.value!==null)
      fail('source cell state is malformed');
  }
  const namespaceFiles=new Set();
  for(const [id,row] of Object.entries(state.namespaces)){
    if(!/^obj[1-9][0-9]*$/.test(id)||!exact(row,['file','exports'])||
       !isDeepStrictEqual(plan.namespaces.find(item=>item.file===row.file),row))
      fail('namespace identity state is malformed');
  }
}

/** Apply exactly one bounded namespace/cell transition, returning a new state
 * only after all checks pass. Malformed transitions never partially mutate. */
export function applyExperimentalModuleNamespaceTransition(plan,state,transition){
  verifyExperimentalModuleNamespacePlan(plan);verifyState(plan,state);
  const next=copy(state),answer={state:next,result:null};
  const requireCell=id=>{
    const declared=plan.cells.find(row=>row.id===id);
    if(!declared||!own(next.cells,id))fail('transition references an undeclared source cell');
    return {declared,current:next.cells[id]};
  };
  const requireNamespace=id=>{
    if(typeof id!=='string'||!own(next.namespaces,id))fail('transition references an uncreated namespace');
    const bound=plan.namespaces.find(row=>row.file===next.namespaces[id].file);
    if(!bound||!isDeepStrictEqual(next.namespaces[id].exports,bound.exports))
      fail('namespace identity or source export table changed');
    return bound;
  };
  if(transition?.kind==='namespace.create'){
    if(!exact(transition,['kind','namespaceId','moduleFile'])||
       typeof transition.namespaceId!=='string'||!/^obj[1-9][0-9]*$/.test(transition.namespaceId)||
       own(next.namespaces,transition.namespaceId)||Object.values(next.namespaces).some(row=>row.file===transition.moduleFile))
      fail('namespace allocation identity is malformed or duplicated');
    const planned=plan.namespaces.find(row=>row.file===transition.moduleFile);
    if(!planned)fail('namespace allocation has no source-owned link');
    next.namespaces[transition.namespaceId]=copy(planned);
    return answer;
  }
  if(transition?.kind==='cell.initialize'||transition?.kind==='cell.write'){
    if(!exact(transition,['kind','cell','value'])||!canonicalValue(transition.value))
      fail('cell transition is malformed');
    const {declared,current}=requireCell(transition.cell);
    if(transition.kind==='cell.initialize'){
      if(current.initialized)fail('source cell was initialized more than once');
    }else{
      if(!current.initialized||!declared.mutable)fail('write is not allowed for the initialized source cell kind');
    }
    current.initialized=true;current.value=copy(transition.value);current.version++;
    return answer;
  }
  if(transition?.kind==='namespace.keys'||transition?.kind==='namespace.read'||
     transition?.kind==='namespace.descriptor'){
    const fields=transition.kind==='namespace.keys'?['kind','namespaceId','names']:
      ['kind','namespaceId','exportName','value'];
    if(!exact(transition,fields))fail('namespace observation record is malformed');
    const planned=requireNamespace(transition.namespaceId);
    if(transition.kind==='namespace.keys'){
      const names=planned.exports.map(row=>row.name);
      if(!isDeepStrictEqual(transition.names,names))fail('own-key result differs from source export names');
      answer.result=copy(names);return answer;
    }
    const binding=planned.exports.find(row=>row.name===transition.exportName);
    if(!binding)fail('namespace read names a missing export');
    const {current}=requireCell(binding.cell);
    if(!current.initialized)fail('namespace read occurs before its source binding is initialized');
    if(transition.kind==='namespace.read'){
      if(!isDeepStrictEqual(transition.value,current.value))fail('namespace read differs from the current live cell');
      answer.result=copy(current.value);return answer;
    }
    const descriptor={value:copy(current.value),writable:true,enumerable:true,configurable:false};
    if(!isDeepStrictEqual(transition.value,descriptor))fail('namespace descriptor differs from the live namespace data descriptor');
    answer.result=descriptor;return answer;
  }
  fail('unsupported namespace transition kind');
}
