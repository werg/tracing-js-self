// Teacher adapter for the owned stable for-in cursor. Public replay derives
// its own snapshot and checks every result against the original source event.
import {propertyKeyValue} from '../property-keys.js';
const fields=['source','chain','keys','nextIndex','done','properties','propertyVersions','shapeVersion'];
const ordinary=new Set(['Object.prototype','Array.prototype','Function.prototype']);
const prototype=value=>value===null?null:ordinary.has(value)?'ordinary':['ref',value];
export function createEnumerationSourceAdapterV8(){return {
  id:'ordinary-for-in/1',
  stateless:true,
  heapFields:node=>node.kind==='enumerator'?fields:null,
  checkHeap(ctx,node){
    if(node.kind!=='enumerator')return true;
    if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
      ctx.refuse('enumeration cursor cannot expose ordinary own properties');
    const chain=node.chain.map(row=>({id:row.id,prototype:prototype(row.prototype),
      keys:row.keys.map(([key,enumerable])=>[propertyKeyValue(key)[1],enumerable])}));
    return ctx.eq(ctx.controller.heap.get(node.id),{kind:'enumerator',source:node.source,chain,keys:node.keys,
      nextIndex:node.nextIndex,done:node.done,properties:new Map()});
  },
  allocate(ctx,node){if(node.kind==='enumerator')ctx.refuse('enumeration allocation requires its source loop');return false;},
  event(ctx,event){
    const frame=ctx.getOwnedFrame(event.invocationId),instruction=ctx.bundle.programs[frame?.codeId]?.instructions[frame.pc];
    if(!['FOR_IN_CREATE','FOR_IN_NEXT'].includes(instruction?.op))return false;
    const changes=event.stateChanges.filter(change=>change.table==='heap'),name=event.result?.[1],
      result=changes.find(change=>change.before===null&&change.id===name)?.after;
    if(event.result?.[0]!=='ref'||!result)ctx.refuse('enumeration transition lacks its fresh result identity');
    if(instruction.op==='FOR_IN_CREATE'){
      if(result.kind!=='enumerator'||changes.length!==1)ctx.refuse('enumeration creation has an undeclared heap effect');
      ctx.emit({kind:'enumeration.create',name,source:ctx.tag(event.operands[0],event)},event,'source-for-in-create/1');
    }else{
      const ref=event.operands[0],cursor=ref?.[0]==='ref'?ctx.state.heap[ref[1]]:null;
      if(cursor?.kind!=='enumerator'||result.kind!=='object'||result.properties.done?.value[0]!=='bool'||
        changes.some(change=>change.id!==cursor.id&&change.id!==name))ctx.refuse('enumeration advance has an undeclared heap effect');
      ctx.emit({kind:'enumeration.next',object:cursor.id,name,result:ctx.copy(result.properties.value.value),
        done:result.properties.done.value[1]},event,'source-for-in-next/1');
    }
    ctx.markPublished(name);return true;
  }
};}
