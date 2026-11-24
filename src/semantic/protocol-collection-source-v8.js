// Public-source adapter for the existing bounded Set storage. It admits only
// the exact constructor and synchronous add/has calls implemented by the owned
// runtime and compares every retained Set node with the consumer machine.
import {COLLECTION_PROFILE_V8} from './protocol-collection-v8.js';
import {decode} from '../values.js';
import {symbolPropertyKey} from '../property-keys.js';

const U=['undefined'];
const methods=new Map([['add','Set.prototype.add'],['has','Set.prototype.has']]);
const refuse=(ctx,message)=>ctx.refuse('Set source: '+message);
export function createCollectionSourceAdapterV8(){
  function checkHeap(ctx,owned){
    if(owned.kind!=='set')return true;
    const actual=ctx.controller.heap.get(owned.id),size=owned.properties?.['[[Size]]']?.value;
    if(size?.[0]!=='num'||!Number.isSafeInteger(decode(size))||decode(size)<0||decode(size)>10000)
      return refuse(ctx,'bounded internal size required');
    const entries=[];
    for(let index=0;index<decode(size);index++){
      const value=owned.properties?.[String(index)]?.value;
      if(!value)return refuse(ctx,'dense insertion-order storage required');
      entries.push(ctx.tag(value));
    }
    if(!actual||!ctx.eq(actual,{kind:'set',entries,properties:new Map()}))return refuse(ctx,'public Set entries differ from the owned heap');
    return true;
  }
  return {id:COLLECTION_PROFILE_V8,stateless:true,syntax:node=>node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='Set',
    heapFields:node=>node.kind==='set'?['properties','propertyVersions','shapeVersion','propertyOrder']:null,checkHeap,
    event(ctx,event,row){
      const raw=event.operands?.[0]??row?.operands?.[0];
      if(event.operation==='object.construct'&&raw?.[0]==='intrinsic'&&raw[1]==='Set'){
        if(event.result?.[0]!=='ref'||event.stateChanges.filter(change=>change.table==='heap'&&change.before===null).length!==1)
          return refuse(ctx,'constructor requires one fresh Set result');
        const owned=event.stateChanges.find(change=>change.table==='heap'&&change.id===event.result[1])?.after;
        if(owned?.kind!=='set'||event.operands.length>2)return refuse(ctx,'constructor requires zero or one ordinary array argument');
        const iterable=event.operands[1]??U;
        if(iterable[0]==='ref'){
          const array=ctx.state.heap[iterable[1]];
          if(array?.kind!=='array'||Object.keys(array.accessors??{}).length||
            Object.hasOwn(array.properties??{},symbolPropertyKey('well-known:iterator')))
            return refuse(ctx,'constructor requires an unmodified dense array iterable');
          const length=array.properties.length?.value;
          if(length?.[0]!=='num'||!Number.isSafeInteger(length[1])||length[1]>10000||
            Array.from({length:length[1]},(_,index)=>Object.hasOwn(array.properties,String(index))).some(present=>!present))
            return refuse(ctx,'constructor sparse-array iteration is outside this profile');
        }else if(!['undefined','null'].includes(iterable[0]))return refuse(ctx,'constructor iterable kind');
        ctx.emit({kind:'set.create',name:event.result[1],iterable:ctx.tag(iterable,event)},event,'source-set-create/1');
        ctx.markPublished(event.result[1]);return true;
      }
      const base=row?.operands?.[0]??raw,baseNode=base?.[0]==='ref'?ctx.state.heap[base[1]]:null;
      if(event.operation==='property.read'&&!row?.child&&baseNode?.kind==='set'){
        const key=ctx.key(row.operands[1]),name=key[0]==='str'?methods.get(key[1]):null;
        if(name){
          const output=row.result?.[0]==='method'?row.result[1]:row.result;
          if(!ctx.eq(output,['builtinfn',name]))return refuse(ctx,'selected Set method identity differs');
          ctx.emit({kind:'set.lookup',object:base[1],key,method:name},event,'source-set-method/1');return true;
        }
      }
      if(event.operation==='call.enter'){
        const method=raw?.[0]==='method'?raw[1]:raw,receiver=raw?.[0]==='method'?raw[2]:null;
        const operation=method?.[0]==='builtinfn'?method[1].slice('Set.prototype.'.length):null;
        if(!['add','has'].includes(operation)||!methods.has(operation))return false;
        if(receiver?.[0]!=='ref'||ctx.state.heap[receiver[1]]?.kind!=='set'||event.operands.length!==2||
          event.causes?.some(cause=>cause.kind==='invocation'))return refuse(ctx,'only one-argument direct Set methods are admitted');
        const value=ctx.tag(event.operands[1],event),result=ctx.tag(event.result,event);
        ctx.emit({kind:'set.'+operation,object:receiver[1],value,result},event,'source-set-'+operation+'/1');
        return true;
      }
      return false;
    }
  };
}
