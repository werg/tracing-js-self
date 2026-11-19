// Read-only archive checks, independent of the runtime's byte mutation helpers.
const widths=Object.freeze({Int8Array:1,Uint8Array:1,Int16Array:2,Uint16Array:2,
  Int32Array:4,Uint32Array:4,Float32Array:4,Float64Array:8,BigInt64Array:8,BigUint64Array:8});
const buffers=new Set(['array-buffer','shared-int32-buffer']);
const views=new Set(['typed-array','shared-int32-view','data-view','shared-data-view']);
export const isBinaryMemoryKind=kind=>buffers.has(kind)||views.has(kind);
export function validateBinaryMemoryState(state,fail,ids){
  for(const id of ids??Object.keys(state.heap)){
    const node=state.heap[id];if(!node||!isBinaryMemoryKind(node.kind)){
      if(ids?.has(id))fail('Binary memory identity was removed or relabeled');
      continue;
    }
    const common=['id','kind','version'];
    const buffer=buffers.has(node.kind),typed=['typed-array','shared-int32-view'].includes(node.kind);
    const fields=buffer?[...common,'byteLength','maxByteLength','bytes',
      ...(node.kind==='array-buffer'?['resizable','detached']:['growable'])]:
      [...common,'bufferId','byteOffset','lengthTracking',...(typed?['elementType','length']:['byteLength'])];
    if(node.id!==id||Object.keys(node).length!==fields.length||fields.some(key=>!Object.hasOwn(node,key))||
       !Number.isSafeInteger(node.version)||node.version<0)fail('Invalid binary memory fields');
    if(buffer){
      if(!Number.isSafeInteger(node.byteLength)||node.byteLength<0||node.byteLength>1024||
         !Number.isSafeInteger(node.maxByteLength)||node.maxByteLength<node.byteLength||node.maxByteLength>1024||
         !Array.isArray(node.bytes)||node.bytes.length!==node.byteLength||
         node.bytes.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))fail('Invalid binary backing bytes');
      if(node.kind==='array-buffer'){
        if(node.resizable!==false||node.detached!==false||node.maxByteLength!==node.byteLength)
          fail('ArrayBuffer capabilities outside the fixed owned profile');
      }else if(typeof node.growable!=='boolean'||!node.growable&&node.maxByteLength!==node.byteLength)
        fail('Invalid shared buffer growth capability');
      continue;
    }
    const backing=state.heap[node.bufferId],shared=node.kind.startsWith('shared-');
    if(backing?.kind!==(shared?'shared-int32-buffer':'array-buffer')||
       !Number.isSafeInteger(node.byteOffset)||node.byteOffset<0||
       node.byteOffset>backing.byteLength||typeof node.lengthTracking!=='boolean'||
       node.lengthTracking&&(!shared||backing.growable!==true))fail('Invalid binary view backing identity');
    const width=typed?widths[node.elementType]:1,length=typed?node.length:node.byteLength;
    if(!width||node.byteOffset%width||!Number.isSafeInteger(length)||length<0||
       node.byteOffset+length*width>backing.byteLength)fail('Invalid binary view bounds');
  }
}
export function validateBinaryMemoryEvent(event,fail){
  for(const patch of event.stateChanges){
    if(patch.table!=='heap'||!isBinaryMemoryKind(patch.before?.kind))continue;
    const a=patch.before,b=patch.after;
    if(!b||a.kind!==b.kind)fail('Binary memory identity was removed or relabeled');
    const immutable=buffers.has(a.kind)?['maxByteLength',...(a.kind==='array-buffer'?['byteLength','resizable','detached']:['growable'])]:
      ['bufferId','elementType','byteOffset','length','byteLength','lengthTracking'];
    if(immutable.some(key=>a[key]!==b[key]))fail('Binary memory immutable view or capability changed');
    if(a.kind==='shared-int32-buffer'&&b.byteLength<a.byteLength)fail('Shared memory cannot shrink');
  }
}
