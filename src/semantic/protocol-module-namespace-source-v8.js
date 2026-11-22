// Teacher-only experimental owner for bounded synchronous module namespaces.
// This adapter is never registered globally. Callers must pass a plan freshly
// rederived from original module sources; module-v8 performs that recheck.
import {verifyExperimentalModuleNamespacePlan} from './module-namespace-state-v8.js';
import {deriveExperimentalModuleNamespaceOwnersV8} from './module-namespace-source-owners-v8.js';

const fail=message=>{throw new TypeError('Experimental module namespace source: '+message);};
const copy=structuredClone,eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const cellId=(file,local)=>file+'#'+local;
const valueTag=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint'].includes(value[0]);
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const patched=(event,table,id,fallback)=>event.stateChanges.find(change=>change.table===table&&change.id===id)?.after??fallback;
const methodName=value=>value?.[0]==='method'?value[1]?.[1]:value?.[0]==='builtinfn'?value[1]:null;
const stateFromView=view=>view.components?.['experimental-module-namespace-source/1']??{};

export function createExperimentalModuleNamespaceSourceAdapterV8({source,moduleNamespacePlan,bundle}={}){
  verifyExperimentalModuleNamespacePlan(moduleNamespacePlan);
  const owners=deriveExperimentalModuleNamespaceOwnersV8({source,moduleNamespacePlan,bundle});
  const ownerBySite=new Map(owners.map(row=>[row.siteId,row]));
  const getterBySite=new Map();
  for(const owner of owners)for(const item of owner.exports){
    if(!item.getterSiteId)fail('namespace getter body must have one source-owned read site');
    if(getterBySite.has(item.getterSiteId))fail('namespace getter source site is ambiguous');
    getterBySite.set(item.getterSiteId,{file:owner.file,name:item.name,cell:item.cell});
  }
  const namespaceCellIds=new Set(moduleNamespacePlan.namespaces.flatMap(row=>row.exports.map(item=>item.cell)));
  const cells=new Map(moduleNamespacePlan.cells.filter(row=>namespaceCellIds.has(row.id)).map(row=>[row.loweredName,row]));
  const namespaces=new Map(moduleNamespacePlan.namespaces.map(row=>[row.namespaceName,row]));
  let pendingCreates=new Map(),namespaceFiles=new Map(),operations=new Map(),cellVersions=new Map(),syntheticFrames=new Set();
  const snapshot=()=>({ownerSiteIds:owners.map(row=>row.siteId),cellNames:[...cells.keys()],
    namespaceNames:[...namespaces.keys()],pendingCreates:[...pendingCreates],namespaceFiles:[...namespaceFiles],
    operations:[...operations].map(([id,row])=>[id,copy(row)]),cellVersions:[...cellVersions],syntheticFrames:[...syntheticFrames]});
  const restore=state=>{pendingCreates=new Map(state.pendingCreates);namespaceFiles=new Map(state.namespaceFiles);
    operations=new Map(state.operations.map(([id,row])=>[id,copy(row)]));cellVersions=new Map(state.cellVersions);
    syntheticFrames=new Set(state.syntheticFrames??[]);};
  const exportCell=(file,name)=>{
    const ns=moduleNamespacePlan.namespaces.find(row=>row.file===file);
    const entry=ns?.exports.find(row=>row.name===name);
    return entry?moduleNamespacePlan.cells.find(row=>row.id===entry.cell):null;
  };
  const frameAfter=(ctx,event,id)=>patched(event,'frames',id,ctx.state.frames[id]);
  const operationForChild=(id)=>[...operations].find(([,row])=>row.waitingFrameId===id)??null;
  const writeRows=row=>(row?.writes??[]).filter(write=>write.kind==='cell');
  const locateCellWrite=(row)=>{
    const matched=[];
    for(const write of writeRows(row)){
      const lowered=String(write.key??write.name??'');
      const spec=cells.get(lowered);
      if(spec)matched.push({write,spec});
    }
    return matched;
  };
  function ownedNamespace(ctx,id){
    const file=namespaceFiles.get(id)??[...pendingCreates.values()].find(row=>row.namespaceId===id)?.file;
    return file?moduleNamespacePlan.namespaces.find(row=>row.file===file):null;
  }
  function checkContinuationFrame(ctx,frame,event,frameId){
    if(!Object.hasOwn(frame,'pendingModuleNamespace'))return true;
    const pending=frame.pendingModuleNamespace;
    if(pending===null)return true;
    if(!pending||typeof pending!=='object'||Array.isArray(pending))return false;
    const ns=ownedNamespace(ctx,pending.namespaceId);
    if(!ns||typeof pending.waitingFrameId!=='string'||pending.waitingFrameId===frameId)return false;
    if(pending.kind==='descriptor'){
      if(!exactKeys(pending,['kind','namespaceId','key','waitingFrameId'])||
         typeof pending.key!=='string'||!ns.exports.some(item=>item.name===pending.key))return false;
    }else if(pending.kind==='namespace-inspection'){
      const expected=ns.exports.map(item=>item.name);
      if(!exactKeys(pending,['kind','namespaceId','key','waitingFrameId','operation','keys','index','phase','operationEventId'])||
         pending.operation!=='Object.keys'||pending.phase!=='read-export'||
         !eq(pending.keys,expected)||!Number.isSafeInteger(pending.index)||
         pending.index<0||pending.index>=expected.length||pending.key!==expected[pending.index]||
         typeof pending.operationEventId!=='string')return false;
    }else return false;
    const operation=operations.get(frameId);
    if(operation){
      if(operation.namespaceId!==pending.namespaceId||
         (operation.kind==='descriptor'&&pending.kind!=='descriptor')||
         (operation.kind==='keys'&&pending.kind!=='namespace-inspection'))return false;
      if(operation.kind==='descriptor'&&operation.keys[0]!==pending.key)return false;
      if(operation.kind==='keys'){
        const next=operation.index+
          (event?.operation==='call.return'&&event.invocationId===operation.waitingFrameId?1:0);
        if(pending.index!==next||pending.key!==operation.keys[next]||
           pending.operationEventId!==operation.operationEventId)return false;
      }
      if(event?.operation!=='call.return'||event.invocationId!==operation.waitingFrameId){
        if(operation.waitingFrameId!==pending.waitingFrameId)return false;
      }
      return true;
    }
    if(event?.operation!=='call.enter'||event.invocationId!==frameId||
       event.operands?.[1]?.[0]!=='ref'||event.operands[1][1]!==pending.namespaceId)return false;
    const method=methodName(event.operands[0]);
    if(pending.kind==='namespace-inspection'){
      return method==='Object.keys'&&pending.operation==='Object.keys'&&
        pending.phase==='read-export'&&pending.operationEventId===event.eventId&&
        pending.index===0&&pending.key===pending.keys[0];
    }
    return method==='Object.getOwnPropertyDescriptor'&&pending.key===event.operands?.[2]?.[1];
  }
  function checkNamespaceNode(ctx,node){
    if(node.kind!=='module-namespace')return false;
    const names=moduleNamespacePlan.namespaces.filter(row=>
      eq(row.exports.map(item=>item.name),node.namespaceExportNames));
    if(!node.id||node.prototype!==null||node.extensible!==false||names.length===0||
       !Array.isArray(node.namespaceExportNames)||node.namespaceExportNames.some((name,index)=>
         typeof name!=='string'||index>0&&node.namespaceExportNames[index-1]>=name))
      return false;
    const expected=new Set(node.namespaceExportNames);
    if(!exactKeys(node.accessors??{},node.namespaceExportNames)||Object.keys(node.properties??{}).length!==1||
       !Object.hasOwn(node.properties,'\u0000symbol:well-known:toStringTag')||
       !eq(node.properties['\u0000symbol:well-known:toStringTag']?.value,['str','Module'])||
       node.dataAttributes?.['\u0000symbol:well-known:toStringTag']?.writable!==false||
       node.dataAttributes?.['\u0000symbol:well-known:toStringTag']?.enumerable!==false||
       node.dataAttributes?.['\u0000symbol:well-known:toStringTag']?.configurable!==false)
      return false;
    for(const name of expected){
      const descriptor=node.accessors[name];
      if(!descriptor||descriptor.enumerable!==true||descriptor.configurable!==false||
         descriptor.get?.value?.[0]!=='ref'||!eq(descriptor.set?.value,['undefined']))return false;
    }
    return true;
  }
  function claimEvent(view,{event,row}){
    if(!event)return false;
    if(event.operation==='call.enter'&&event.operands?.[0]?.[0]==='builtinfn'&&
       event.operands[0][1]==='__traced_eval_create_module_namespace')
      return ownerBySite.has(event.siteId);
    if(pendingCreates.size&&event.operation==='binding.initialize'){
      const pending=[...pendingCreates.values()].find(item=>item.invocationId===event.invocationId);
      if(pending&&writeRows(row).some(write=>write.key===pending.namespaceName))return true;
    }
    if(locateCellWrite(row).length&&['binding.initialize','binding.write','binding.update'].includes(event.operation))return true;
    if(event.operation==='call.enter'&&['Object.keys','Object.getOwnPropertyDescriptor'].includes(
      methodName(event.operands?.[0]))&&event.operands?.[1]?.[0]==='ref'&&
      view.owned.heap?.[event.operands[1][1]]?.kind==='module-namespace')return true;
    if(operationForChild(event.invocationId))return ['binding.read','call.return'].includes(event.operation);
    if(event.operation==='property.read'&&row?.operands?.[0]?.[0]==='ref'&&
       view.owned.heap?.[row.operands[0][1]]?.kind==='module-namespace')return true;
    return false;
  }
  function emitCell(ctx,event,row,matched){
    if(matched.length!==1||writeRows(row).length!==1)ctx.refuse('one source-owned namespace cell write is required');
    const {write,spec}=matched[0],value=write.value??row.result;
    if(ctx.cell(write.env,write.key)!==spec.loweredName)
      ctx.refuse('namespace cell local differs from its exact linker-lowered name');
    if(!valueTag(value)||!eq(value,row.result))ctx.refuse('namespace cells are bounded to committed primitive values');
    if(event.operation==='binding.initialize'){
      if(cellVersions.has(spec.id))ctx.refuse('source cell initializes more than once');
      cellVersions.set(spec.id,1);
      ctx.emit({kind:'cell.initialize',cell:spec.id,loweredName:spec.loweredName,value:copy(value)},event,
        'source-module-cell-initialize/1');
    }else{
      if(!spec.mutable)ctx.refuse('immutable module cell write is excluded');
      if(!cellVersions.has(spec.id)||cellVersions.get(spec.id)<1)ctx.refuse('module cell write precedes initialization');
      cellVersions.set(spec.id,cellVersions.get(spec.id)+1);
      ctx.emit({kind:'cell.write',cell:spec.id,loweredName:spec.loweredName,value:copy(value)},event,
        'source-module-cell-write/1');
    }
    return true;
  }
  function namespaceIdFrom(event,row){
    const value=event.result??row?.result;
    return value?.[0]==='ref'?value[1]:null;
  }
  function checkRuntimeGetters(ctx,node,owner){
    for(const entry of owner.exports){
      const accessor=node.accessors[entry.name],getter=accessor?.get?.value;
      if(getter?.[0]!=='ref')ctx.refuse('namespace export accessor lacks an owned getter closure');
      const fn=ctx.state.heap[getter[1]],program=fn?.kind==='function'&&ctx.bundle.programs[fn.codeId];
      if(!fn||fn.async||!program||program.generator)ctx.refuse('namespace getter is not a synchronous owned closure');
      const reads=program.instructions.filter(instruction=>instruction.op==='GET'&&
        (typeof instruction.arg==='string'?instruction.arg:instruction.arg?.name)===entry.loweredName);
      if(reads.length!==1)ctx.refuse('namespace getter does not contain exactly its planned live-cell read');
      const readSite=ctx.bundle.sites.find(site=>site.siteId===reads[0].siteId);
      if(!readSite||readSite.start!==entry.getterBodyStart||readSite.end!==entry.getterBodyEnd)
        ctx.refuse('namespace getter bytecode is not mapped to its exact source identifier');
      const closure=ctx.state.envs[fn.closureEnvId];
      if(!closure||!Object.hasOwn(closure.bindings??{},entry.loweredName))
        ctx.refuse('namespace getter does not close over its source-owned cell');
    }
  }
  function beginCreate(ctx,event,row){
    const owner=ownerBySite.get(event.siteId),id=namespaceIdFrom(event,row);
    if(!owner||!id)ctx.refuse('namespace allocation lacks its exact source callsite or identity');
    const allocation=event.stateChanges.find(change=>change.table==='heap'&&change.id===id&&change.before===null)?.after;
    if(!allocation||!checkNamespaceNode(ctx,allocation)||
       !eq(allocation.namespaceExportNames,owner.exports.map(item=>item.name)))
      ctx.refuse('namespace allocation differs from the exact generated initializer');
    checkRuntimeGetters(ctx,allocation,owner);
    pendingCreates.set(id,{namespaceId:id,file:owner.file,namespaceName:owner.namespaceName,
      callEventId:event.eventId,sequence:event.sequence,invocationId:event.invocationId,siteId:event.siteId});
    return true;
  }
  function finishCreate(ctx,event,row){
    const pending=[...pendingCreates.values()].find(item=>item.invocationId===event.invocationId);
    if(!pending)ctx.refuse('namespace binding has no immediately preceding owned creation');
    const write=writeRows(row).find(item=>item.key===pending.namespaceName);
    if(!write||!eq(write.value??row.result,['ref',pending.namespaceId])||
       event.sequence!==pending.sequence+1)
      ctx.refuse('namespace initializer binding differs from its owned creation');
    const node=ctx.state.heap[pending.namespaceId];
    if(!checkNamespaceNode(ctx,node))ctx.refuse('namespace heap changed before its binding');
    namespaceFiles.set(pending.namespaceId,pending.file);
    ctx.publish(node,event);
    pendingCreates.delete(pending.namespaceId);
    return true;
  }
  function startInspection(ctx,event,row){
    const parent=event.invocationId,after=frameAfter(ctx,event,parent)?.pendingModuleNamespace;
    const target=event.operands?.[1];
    if(!after||target?.[0]!=='ref'||after.namespaceId!==target[1])
      ctx.refuse('namespace inspection lacks its retained target');
    const ns=ownedNamespace(ctx,target[1]),method=methodName(event.operands[0]);
    if(!ns)ctx.refuse('namespace inspection target is not source-owned');
    const kind=after.kind==='descriptor'?'descriptor':after.kind==='namespace-inspection'?'keys':null;
    if(!kind||kind==='keys'&&method!=='Object.keys'||
       kind==='descriptor'&&method!=='Object.getOwnPropertyDescriptor')
      ctx.refuse('namespace inspection builtin is outside the bounded profile');
    if(kind==='descriptor'&&!ns.exports.some(item=>item.name===after.key))
      ctx.refuse('descriptor key is not an own namespace export');
    operations.set(parent,{kind,parent,namespaceId:target[1],file:ns.file,operationEventId:event.eventId,
      journalEvents:[event.eventId],method,keys:kind==='keys'?copy(after.keys):[after.key],index:0,
      waitingFrameId:after.waitingFrameId,value:null});
    return true;
  }
  function consumeGetter(ctx,event,row){
    const selected=operationForChild(event.invocationId);
    if(!selected)return false;
    const [parent,operation]=selected;
    operation.journalEvents.push(event.eventId);
    const key=operation.keys[operation.index],cell=exportCell(operation.file,key);
    if(!cell)ctx.refuse('namespace getter has no source-owned export cell');
    if(event.operation==='binding.read'){
      const getter=getterBySite.get(event.siteId),
        read=event.readObservations?.find(item=>item.kind==='binding'&&item.name===cell.loweredName);
      if(!getter||getter.file!==operation.file||getter.name!==key||getter.cell!==cell.id||
         !read||!eq(read.value,event.result)||!valueTag(read.value))
        ctx.refuse('generated namespace getter did not read its exact source-owned live cell');
      operation.value=copy(read.value);operations.set(parent,operation);return true;
    }
    if(event.operation!=='call.return'||!operation.value||!eq(operation.value,event.result))
      ctx.refuse('synthetic namespace getter completion differs from its live cell read');
    syntheticFrames.add(event.invocationId);
    const parentFrame=frameAfter(ctx,event,parent),next=parentFrame?.pendingModuleNamespace;
    if(next){
      if(next.namespaceId!==operation.namespaceId||next.kind!==(operation.kind==='keys'?'namespace-inspection':'descriptor'))
        ctx.refuse('namespace inspection continuation changed identity');
      operation.index=operation.kind==='keys'?next.index:operation.index;
      operation.waitingFrameId=next.waitingFrameId;operation.value=null;operations.set(parent,operation);
      return true;
    }
    if(operation.kind==='read'){
      const pending=parentFrame?.pendingProperty,returned=parentFrame?.stack?.at(-1)?.value;
      if(pending!==null&&pending!==undefined||!eq(returned,operation.value))
        ctx.refuse('dynamic namespace read did not clear its exact property continuation');
      ctx.emit({kind:'namespace.read',namespaceId:operation.namespaceId,
        exportName:operation.keys[0],value:copy(operation.value)},event,
        'source-module-namespace-read/1',{journalEvents:operation.journalEvents});
    }else if(operation.kind==='keys'){
      const allocation=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&
        change.after?.kind==='array'&&change.id===parentFrame?.stack?.at(-1)?.value?.[1]);
      const expected=operation.keys.map((name,index)=>[String(index),['str',name]]);
      if(!allocation||allocation.after.properties.length?.value?.[1]!==operation.keys.length||
         Object.keys(allocation.after.properties).length!==operation.keys.length+1||
         !expected.every(([key,value])=>eq(allocation.after.properties[key]?.value,value))||
         !eq(operation.keys,moduleNamespacePlan.namespaces.find(row=>row.file===operation.file)
           ?.exports.map(item=>item.name)))
        ctx.refuse('Object.keys result allocation differs from namespace export order');
      ctx.emit({kind:'namespace.keys',namespaceId:operation.namespaceId,names:copy(operation.keys),
        resultId:allocation.id},event,'source-module-namespace-keys/1',
        {journalEvents:operation.journalEvents});
      ctx.markPublished(allocation.id);
    }else{
      const resultId=parentFrame?.stack?.at(-1)?.value?.[1],allocation=event.stateChanges.find(change=>
        change.table==='heap'&&change.before===null&&change.id===resultId)?.after;
      const descriptor=allocation?.properties??{};
      if(!allocation||allocation.kind!=='object'||
         !eq(Object.keys(descriptor).sort(),['configurable','enumerable','value','writable'])||
         !eq(descriptor.value?.value,operation.value)||!eq(descriptor.writable?.value,['bool',true])||
         !eq(descriptor.enumerable?.value,['bool',true])||!eq(descriptor.configurable?.value,['bool',false])||
         allocation.prototype!=='Object.prototype'&&allocation.prototype!==undefined||allocation.extensible===false)
        ctx.refuse('descriptor result allocation differs from namespace live cell or descriptor flags');
      ctx.emit({kind:'namespace.descriptor',namespaceId:operation.namespaceId,
        exportName:operation.keys[0],value:{value:copy(operation.value),writable:true,
          enumerable:true,configurable:false},resultId},event,
        'source-module-namespace-descriptor/1',{journalEvents:operation.journalEvents});
      ctx.markPublished(resultId);
    }
    operations.delete(parent);return true;
  }
  return {
    id:'experimental-module-namespace-source/1',
    captureState:snapshot,restoreState:restore,
    heapFields:node=>node.kind==='module-namespace'?
      ['prototype','extensible','namespaceExportNames','accessors','properties','dataAttributes',
        'propertyOrder','propertyVersions','shapeVersion']:null,
    checkHeap(ctx,node){
      if(node.kind!=='module-namespace')return true;
      if(!checkNamespaceNode(ctx,node))return false;
      return !namespaceFiles.has(node.id)||ownedNamespace(ctx,node.id)!==null;
    },
    claims:{event:claimEvent,allocation:(view,node)=>node.kind==='module-namespace'&&
      (ownerBySite.has(view.event?.siteId)||stateFromView(view).pendingCreates?.some(([id])=>id===node.id)),
      completion:(view,change)=>(stateFromView(view).operations??[]).some(([,operation])=>
        operation.waitingFrameId===change.id)},
    allocation:(_view,node)=>node.kind==='module-namespace',
    allocate(ctx,node,event){
      const pending=[...pendingCreates.values()].find(item=>item.namespaceId===node.id);
      if(!pending||!event||event.operation!=='binding.initialize'||event.sequence!==pending.sequence+1)
        ctx.refuse('module namespace publication is outside its source initializer group');
      ctx.emit({kind:'namespace.create',namespaceId:node.id,moduleFile:pending.file},event,
        'source-module-namespace-create/1',{journalEvents:[pending.callEventId,event.eventId]});
      ctx.markPublished(node.id);return true;
    },
    completeFrame(ctx,change){
      if(!syntheticFrames.has(change.id)||change.after?.completion?.type!=='return')
        ctx.refuse('namespace getter completion lacks its consumed exact source read');
      syntheticFrames.delete(change.id);return true;
    },
    frameFields(frame){
      return Object.hasOwn(frame,'pendingModuleNamespace')?['pendingModuleNamespace']:null;
    },
    checkFrame(ctx,frame,event,frameId){
      return checkContinuationFrame(ctx,frame,event,frameId);
    },
    event(ctx,event,row){
      if(event.operation==='call.enter'&&event.operands?.[0]?.[0]==='builtinfn'&&
         event.operands[0][1]==='__traced_eval_create_module_namespace')return beginCreate(ctx,event,row);
      const pending=[...pendingCreates.values()].find(item=>item.invocationId===event.invocationId);
      if(pending&&event.operation==='binding.initialize'&&writeRows(row).some(write=>write.key===pending.namespaceName))
        return finishCreate(ctx,event,row);
      const matched=locateCellWrite(row);
      if(matched.length&&['binding.initialize','binding.write','binding.update'].includes(event.operation))
        return emitCell(ctx,event,row,matched);
      if(event.operation==='call.enter'&&event.operands?.[1]?.[0]==='ref'&&
         ownedNamespace(ctx,event.operands[1][1])&&
         ['Object.keys','Object.getOwnPropertyDescriptor'].includes(methodName(event.operands[0])))
        return startInspection(ctx,event,row);
      if(operationForChild(event.invocationId))return consumeGetter(ctx,event,row);
      if(event.operation==='property.read'&&event.operands?.[0]?.[0]==='ref'){
        const namespaceId=event.operands[0][1],file=namespaceFiles.get(namespaceId);
        if(file){
          const name=event.operands[1]?.[0]==='str'?event.operands[1][1]:null,cell=name&&exportCell(file,name),
            parent=event.invocationId,pending=frameAfter(ctx,event,parent)?.pendingProperty;
          if(!cell||!pending||pending.kind!=='get'||pending.method!==false||
             !eq(pending.receiver,['ref',namespaceId])||typeof pending.waitingFrameId!=='string')
            ctx.refuse('dynamic namespace read lacks its exact getter continuation');
          operations.set(parent,{kind:'read',parent,namespaceId,file,operationEventId:event.eventId,
            journalEvents:[event.eventId],keys:[name],index:0,waitingFrameId:pending.waitingFrameId,value:null});
          return true;
        }
      }
      return false;
    }
  };
}
