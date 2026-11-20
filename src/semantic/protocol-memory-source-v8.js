// Teacher-only binary adapter. Claims are derived from checked source events,
// executed on the public machine, and compared with every changed backing node.
import {MEMORY_PROFILE_V8} from './protocol-memory-v8.js';
import {SHARED_TYPES,DATA_VIEW_GETTERS,DATA_VIEW_SETTERS} from '../owned-shared-memory.js';
const constructors=new Set(['ArrayBuffer','SharedArrayBuffer','DataView',...Object.keys(SHARED_TYPES)]);
const fields={
  'array-buffer':['byteLength','maxByteLength','resizable','detached','bytes'],
  'shared-int32-buffer':['byteLength','maxByteLength','growable','bytes'],
  'typed-array':['bufferId','elementType','byteOffset','length','lengthTracking'],
  'shared-int32-view':['bufferId','elementType','byteOffset','length','lengthTracking'],
  'data-view':['bufferId','byteOffset','byteLength','lengthTracking'],
  'shared-data-view':['bufferId','byteOffset','byteLength','lengthTracking']
};
function method(node,key){
  if(['data-view','shared-data-view'].includes(node.kind)&&[...DATA_VIEW_GETTERS,...DATA_VIEW_SETTERS].includes(key))return 'DataView.prototype.'+key;
  if(['typed-array','shared-int32-view'].includes(node.kind)&&key==='subarray')return 'TypedArray.prototype.subarray';
  if(node.kind==='array-buffer'&&key==='slice')return 'ArrayBuffer.prototype.slice';
  if(node.kind==='shared-int32-buffer'&&['slice','grow'].includes(key))return 'SharedArrayBuffer.prototype.'+key;
  return null;
}
export const memorySourceAdapterV8={
  id:MEMORY_PROFILE_V8,
  syntax(node){return node.type==='NewExpression'&&node.callee.type==='Identifier'&&constructors.has(node.callee.name);},
  heapFields(node){return fields[node.kind]??null;},
  checkHeap(ctx,owned){
    const {id,version,...expected}=ctx.copy(owned),actual=ctx.controller.heap.get(id);
    if(!actual||!ctx.eq(actual,{...expected,properties:new Map()}))ctx.refuse('binary backing/view state differs after source transition '+id);
    return true;
  },
  event(ctx,event,row){
    if(!row)return false;
    const changes=event.stateChanges.filter(change=>change.table==='heap'),raw=row.operands[0];
    const emit=record=>ctx.emit(record,event,'owned-source-binary-memory/1');
    const publishFresh=()=>{for(const change of changes)if(change.before===null){
      if(!fields[change.after?.kind])ctx.refuse('binary call allocated an undeclared heap kind');ctx.markPublished(change.id);
    }};
    if(event.operation==='object.construct'&&raw?.[0]==='intrinsic'&&constructors.has(raw[1])){
      if(row.result?.[0]!=='ref')ctx.refuse('binary constructor requires its abrupt completion profile');
      const extra=changes.filter(change=>change.before===null&&change.id!==row.result[1]);
      if(extra.length>1)ctx.refuse('binary constructor allocation bound');
      emit({kind:'memory.construct',constructor:raw[1],name:row.result[1],backing:extra[0]?.id??null,
        arguments:row.operands.slice(1).map(value=>ctx.tag(value,event))});publishFresh();return true;
    }
    const base=raw?.[0]==='ref'?ctx.state.heap[raw[1]]:null;
    if(base&&fields[base.kind]&&['property.read','property.write'].includes(event.operation)){
      const key=ctx.key(row.operands[1]);if(key[0]!=='str')ctx.refuse('binary Symbol property needs its own profile');
      if(event.operation==='property.write'){
        emit({kind:'memory.set',object:raw[1],key,value:ctx.tag(row.operands[2],event)});return true;
      }
      const expected=method(base,key[1]);
      if(expected){
        if(!ctx.eq(row.result,['builtinfn',expected])&&!ctx.eq(row.result,['method',['builtinfn',expected],raw]))
          ctx.refuse('binary method identity differs from its source property');
      }else emit({kind:'memory.get',object:raw[1],key,result:ctx.tag(row.result,event)});
      return true;
    }
    if(event.operation==='call.enter'){
      const callee=raw?.[0]==='method'?raw[1]:raw,name=callee?.[0]==='builtinfn'?callee[1]:null;
      if(name&&(name==='ArrayBuffer.isView'||/^(DataView|TypedArray|ArrayBuffer|SharedArrayBuffer)\.prototype\./.test(name)||name.startsWith('Atomics.'))){
        const staticCall=name==='ArrayBuffer.isView'||name.startsWith('Atomics.');
        const allocated=changes.filter(change=>change.before===null);
        if(allocated.length>1)ctx.refuse('binary method allocation bound');
        if(!staticCall&&raw?.[0]!=='method')ctx.refuse('unbound binary method requires an explicit receiver');
        emit({kind:'memory.call',method:name,receiver:staticCall?null:ctx.tag(raw[2],event),
          arguments:row.operands.slice(1).map(value=>ctx.tag(value,event)),name:allocated[0]?.id??null,result:ctx.copy(row.result)});
        publishFresh();return true;
      }
    }
    return false;
  }
};
