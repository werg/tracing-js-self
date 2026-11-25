import {ordinaryGet} from './spec-operations.js';
// Independently reconstructed ordinary enumeration evidence. No evaluator calls.
import {isSymbolPropertyKey,propertyKeyValue,stringPropertyKey} from './property-keys.js';
import {ownedHasProperty} from './owned-has-property.js';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const index=key=>/^(0|[1-9]\d*)$/.test(key)&&Number(key)<4294967295;
function transparentTarget(heap,reference,fail){
  let object=heap[reference[1]];const seen=new Set();
  while(object?.kind==='proxy'){
    if(seen.has(object.id)||seen.size>=64)fail('For-in Proxy route cycle/bound');seen.add(object.id);
    if(!object.targetId||!object.handlerId)fail('For-in revoked Proxy requires abrupt boundary');
    for(const name of ['ownKeys','getOwnPropertyDescriptor','getPrototypeOf']){
      const selected=ordinaryGet(heap,['ref',object.handlerId],name);
      if(!selected||!['undefined','null'].includes(selected.method.value[0]))fail('For-in Proxy trap requires its internal-method continuation');
    }
    object=heap[object.targetId];
  }
  return object;
}
function expectedSnapshot(heap,source,fail){
  if(source[0]==='str'){
    const keys=Array.from({length:source[1].length},(_,i)=>String(i));
    return {chain:[],keys};
  }
  if(['undefined','null','num','bool','bigint','symbol'].includes(source[0]))return {chain:[],keys:[]};
  if(source[0]!=='ref')fail('For-in snapshot has an unowned source');
  const chain=[],keys=[],seen=new Set(),identities=new Set();let object=heap[source[1]];
  while(object){
    const identity=object.id;object=transparentTarget(heap,['ref',identity],fail);
    if(!object||!['object','array','function'].includes(object.kind)||identities.has(identity))fail('For-in snapshot has an exotic or cyclic prototype');
    identities.add(identity);
    const present=key=>Object.hasOwn(object.properties??{},key)||Object.hasOwn(object.accessors??{},key);
    const candidates=[...new Set([...(object.propertyOrder??[]),...Object.keys(object.properties??{}),...Object.keys(object.accessors??{})])].filter(key=>present(key)&&!isSymbolPropertyKey(key));
    const ordered=[...candidates.filter(index).sort((a,b)=>Number(a)-Number(b)),...candidates.filter(key=>!index(key))];
    const own=ordered.map(key=>[key,!!(object.accessors?.[key]?object.accessors[key].enumerable:object.dataAttributes?.[key]?.enumerable!==false&&!(object.kind==='array'&&key==='length'))]);
    if(object.kind==='function')for(const key of ['name','length','prototype','caller','arguments'])if(!own.some(row=>row[0]===key))own.push([key,false]);
    const prototype=Object.hasOwn(object,'prototype')?object.prototype:object.kind==='array'?'Array.prototype':object.kind==='function'?'Function.prototype':'Object.prototype';
    chain.push({id:identity,prototype,keys:own});
    for(const [key,enumerable] of own)if(!seen.has(key)){seen.add(key);if(enumerable)keys.push(propertyKeyValue(key)[1]);}
    if(prototype===null||['Object.prototype','Array.prototype','Function.prototype'].includes(prototype))break;
    object=heap[prototype];if(!object)fail('For-in snapshot has a missing prototype');
  }
  return {chain,keys};
}
export function validateEnumerationEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc],op=instruction?.op;
  const cursors=event.stateChanges.filter(p=>p.table==='heap'&&(p.before?.kind==='enumerator'||p.after?.kind==='enumerator'));
  if(op==='FOR_IN_CREATE'){
    const source=frame.stack.at(-1)?.value,snapshot=expectedSnapshot(state.heap,source,fail);
    if(cursors.length!==1||cursors[0].before!==null||!eq(event.result,['ref',cursors[0].id]))fail('For-in cursor allocation is not unique');
    const record=cursors[0].after;
    if(!eq(record.source,source)||!eq(record.keys,snapshot.keys)||!eq(record.chain,snapshot.chain)||record.nextIndex!==0||record.done!==false)
      fail('For-in snapshot lost key order or nonenumerable shadowing');
  }else if(op==='FOR_IN_NEXT'){
    const ref=frame.stack.at(-1)?.value,cursor=ref?.[0]==='ref'?state.heap[ref[1]]:null;
    if(cursor?.kind!=='enumerator')
      fail('For-in advance has an invalid or changed source');
    const proxy=cursor.chain.some(row=>state.heap[row.id]?.kind==='proxy');
    if(!cursor.done&&proxy&&!eq(expectedSnapshot(state.heap,cursor.source,fail).chain,cursor.chain))
      fail('For-in Proxy descriptor/prototype mutation requires ordered continuation');
    const liveSource=cursor.source[0]==='ref'?['ref',transparentTarget(state.heap,cursor.source,fail).id]:cursor.source;
    let nextIndex=cursor.nextIndex,selected;
    while(!cursor.done&&nextIndex<cursor.keys.length){
      const key=cursor.keys[nextIndex++];
      if(cursor.source[0]==='str'||ownedHasProperty(state.heap,liveSource,stringPropertyKey(key))){selected=key;break;}
    }
    const done=cursor.done||selected===undefined,value=done?['undefined']:['str',selected],
      next=cursors.find(p=>p.id===cursor.id)?.after??cursor;
    if(cursors.some(p=>p.id!==cursor.id)||next.nextIndex!==nextIndex||next.done!==done||
       !eq(next.keys,cursor.keys)||!eq(next.chain,cursor.chain)||!eq(next.source,cursor.source))
      fail('For-in cursor advanced outside its retained sequence');
    const result=event.result?.[0]==='ref'?event.stateChanges.find(p=>p.table==='heap'&&p.before===null&&p.id===event.result[1])?.after:null;
    if(result?.kind!=='object'||!eq(result.properties.value?.value,value)||!eq(result.properties.done?.value,['bool',done]))
      fail('For-in next completion disagrees with the selected key');
  }else if(cursors.length)fail('For-in cursor changed outside enumeration');
}
