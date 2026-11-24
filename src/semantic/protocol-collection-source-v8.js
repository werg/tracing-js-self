// Public-source adapter for the runtime's bounded Set and Map storage.
import {COLLECTION_PROFILE_V8} from './protocol-collection-v8.js';
import {decode} from '../values.js';
import {symbolPropertyKey} from '../property-keys.js';

const U=['undefined'];
const methods={set:new Map([['add','Set.prototype.add'],['has','Set.prototype.has'],['delete','Set.prototype.delete'],['clear','Set.prototype.clear']]),
  map:new Map([['get','Map.prototype.get'],['set','Map.prototype.set'],['has','Map.prototype.has'],['delete','Map.prototype.delete'],['clear','Map.prototype.clear']])};
const fail=(ctx,message)=>ctx.refuse('Collection source: '+message);
const number=value=>value?.[0]==='num'?decode(value):NaN;
export function createCollectionSourceAdapterV8(){
  function checkHeap(ctx,owned){
    if(!['set','map'].includes(owned.kind))return true;
    const actual=ctx.controller.heap.get(owned.id),size=number(owned.properties?.['[[Size]]']?.value),
      count=number(owned.properties?.['[[EntryCount]]']?.value);
    if(!Number.isSafeInteger(size)||size<0||size>10000||!Number.isSafeInteger(count)||count<0||count>10000)
      return fail(ctx,'bounded live size and insertion count required');
    const entries=[];
    for(let index=0;index<count;index++){
      const value=owned.properties?.[String(index)]?.value;
      if(!value)return fail(ctx,'dense insertion-order storage required');
      if(owned.kind==='set')entries.push(value[0]==='deleted'?null:ctx.tag(value));
      else if(value[0]==='deleted')entries.push(null);
      else if(value[0]==='map-entry'&&value.length===3)entries.push([ctx.tag(value[1]),ctx.tag(value[2])]);
      else return fail(ctx,'Map entry storage shape required');
    }
    if(entries.filter(entry=>entry!==null).length!==size)return fail(ctx,'live size differs from retained slots');
    if(!actual||!ctx.eq(actual,{kind:owned.kind,entries,properties:new Map()}))
      return fail(ctx,'public collection entries differ from the owned heap');
    return true;
  }
  function collectionKind(node){return node?.kind==='set'?'set':node?.kind==='map'?'map':null;}
  return {id:COLLECTION_PROFILE_V8,stateless:true,
    syntax:node=>node.type==='NewExpression'&&node.callee.type==='Identifier'&&['Set','Map'].includes(node.callee.name),
    heapFields:node=>['set','map'].includes(node.kind)?['properties','propertyVersions','shapeVersion','propertyOrder']:null,
    checkHeap,
    event(ctx,event,row){
      const raw=event.operands?.[0]??row?.operands?.[0];
      if(event.operation==='object.construct'&&raw?.[0]==='intrinsic'&&['Set','Map'].includes(raw[1])){
        const kind=raw[1].toLowerCase();
        if(event.result?.[0]!=='ref'||event.stateChanges.filter(change=>change.table==='heap'&&change.before===null).length!==1)
          return fail(ctx,'constructor requires one fresh collection result');
        const owned=event.stateChanges.find(change=>change.table==='heap'&&change.id===event.result[1])?.after;
        if(owned?.kind!==kind||event.operands.length>2)return fail(ctx,'constructor requires zero or one ordinary array iterable');
        const iterable=event.operands[1]??U;
        if(iterable[0]==='ref'){
          const array=ctx.state.heap[iterable[1]];
          if(array?.kind!=='array'||Object.keys(array.accessors??{}).length||
            Object.hasOwn(array.properties??{},symbolPropertyKey('well-known:iterator')))
            return fail(ctx,'constructor requires an unmodified ordinary array iterable');
          const length=array.properties.length?.value;
          if(length?.[0]!=='num'||!Number.isSafeInteger(decode(length))||decode(length)>10000||
            Array.from({length:decode(length)},(_,index)=>Object.hasOwn(array.properties,String(index))).some(present=>!present))
            return fail(ctx,'constructor sparse array iteration is outside this profile');
          if(kind==='map')for(let index=0;index<decode(length);index++){
            const pair=array.properties[String(index)]?.value,pairNode=pair?.[0]==='ref'?ctx.state.heap[pair[1]]:null,
              pairLength=number(pairNode?.properties?.length?.value);
            if(pairNode?.kind!=='array'||![undefined,'ordinary','Array.prototype'].includes(pairNode.prototype)||
              !Number.isSafeInteger(pairLength)||pairLength!==2||
              Object.keys(pairNode.accessors??{}).length||Object.hasOwn(pairNode.properties??{},symbolPropertyKey('well-known:iterator'))||
              !Object.hasOwn(pairNode.properties??{},'0')||!Object.hasOwn(pairNode.properties??{},'1'))
              return fail(ctx,'Map constructor requires ordinary dense two-element pairs');
          }
        }else if(!['undefined','null'].includes(iterable[0]))return fail(ctx,'constructor iterable kind');
        ctx.emit({kind:kind+'.create',name:event.result[1],iterable:ctx.tag(iterable,event)},event,'source-collection-create/1');
        ctx.markPublished(event.result[1]);return true;
      }
      const rawBase=row?.operands?.[0]??raw,base=rawBase?.[0]==='ref'?ctx.state.heap[rawBase[1]]:null,kind=collectionKind(base);
      if(event.operation==='property.read'&&!row?.child&&kind){
        const key=ctx.key(row.operands[1]);
        if(key[0]==='str'&&key[1]==='size'){
          ctx.emit({kind:kind+'.size',object:rawBase[1],result:ctx.tag(row.result,event)},event,'source-collection-size/1');return true;
        }
        const name=key[0]==='str'?methods[kind].get(key[1]):null;
        if(name){
          const output=row.result?.[0]==='method'?row.result[1]:row.result;
          if(!ctx.eq(output,['builtinfn',name]))return fail(ctx,'selected collection method identity differs');
          ctx.emit({kind:kind+'.lookup',object:rawBase[1],key,method:name},event,'source-collection-method/1');return true;
        }
      }
      if(event.operation==='call.enter'){
        const method=raw?.[0]==='method'?raw[1]:raw,receiver=raw?.[0]==='method'?raw[2]:null,
          prefix=method?.[0]==='builtinfn'&&method[1].startsWith('Set.prototype.')?'Set.prototype.':
            method?.[0]==='builtinfn'&&method[1].startsWith('Map.prototype.')?'Map.prototype.':null,
          methodKind=prefix==='Set.prototype.'?'set':prefix==='Map.prototype.'?'map':null,
          operation=prefix?method[1].slice(prefix.length):null;
        if(!methodKind||!methods[methodKind].has(operation))return false;
        if(receiver?.[0]!=='ref'||collectionKind(ctx.state.heap[receiver[1]])!==methodKind)
          return fail(ctx,'collection method receiver identity differs');
        const expected=methodKind==='set'?operation==='clear'?1:2:
          operation==='set'?3:operation==='clear'?1:2;
        if(event.operands.length!==expected)return fail(ctx,'collection method arity is outside this profile');
        const object=receiver[1],result=ctx.tag(event.result,event);
        if(methodKind==='set'){
          const value=operation==='clear'?null:ctx.tag(event.operands[1],event);
          ctx.emit({kind:'set.'+operation,object,...(value?{value}:{}),result},event,'source-set-'+operation+'/1');return true;
        }
        const key=operation==='clear'?null:ctx.tag(event.operands[1],event);
        ctx.emit({kind:'map.'+operation,object,...(key?{key}:{}),
          ...(operation==='set'?{value:ctx.tag(event.operands[2],event)}:{}),result},event,'source-map-'+operation+'/1');return true;
      }
      return false;
    }
  };
}
