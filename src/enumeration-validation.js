// Independently reconstructed ordinary enumeration evidence. No evaluator calls.
import {isSymbolPropertyKey,propertyKeyValue} from './property-keys.js';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const index=key=>/^(0|[1-9]\d*)$/.test(key)&&Number(key)<4294967295;
function expectedSnapshot(heap,source,fail){
  if(source[0]==='str')return {chain:[],keys:Array.from({length:source[1].length},(_,i)=>String(i))};
  if(['undefined','null','num','bool','bigint','symbol'].includes(source[0]))return {chain:[],keys:[]};
  if(source[0]!=='ref')fail('For-in snapshot has an unowned source');
  const chain=[],keys=[],seen=new Set(),identities=new Set();let object=heap[source[1]];
  while(object){
    if(!['object','array','function'].includes(object.kind)||identities.has(object.id))fail('For-in snapshot has an exotic or cyclic prototype');
    identities.add(object.id);
    const present=key=>Object.hasOwn(object.properties??{},key)||Object.hasOwn(object.accessors??{},key);
    const candidates=[...new Set([...(object.propertyOrder??[]),...Object.keys(object.properties??{}),...Object.keys(object.accessors??{})])].filter(key=>present(key)&&!isSymbolPropertyKey(key));
    const ordered=[...candidates.filter(index).sort((a,b)=>Number(a)-Number(b)),...candidates.filter(key=>!index(key))];
    const own=ordered.map(key=>[key,!!(object.accessors?.[key]?object.accessors[key].enumerable:object.dataAttributes?.[key]?.enumerable!==false&&!(object.kind==='array'&&key==='length'))]);
    if(object.kind==='function')for(const key of ['name','length','prototype','caller','arguments'])if(!own.some(row=>row[0]===key))own.push([key,false]);
    const prototype=Object.hasOwn(object,'prototype')?object.prototype:object.kind==='array'?'Array.prototype':object.kind==='function'?'Function.prototype':'Object.prototype';
    chain.push({id:object.id,prototype,keys:own});
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
    if(cursor?.kind!=='enumerator'||!eq(expectedSnapshot(state.heap,cursor.source,fail).chain,cursor.chain))
      fail('For-in advance has an invalid or changed source');
    const done=cursor.nextIndex>=cursor.keys.length,value=done?['undefined']:['str',cursor.keys[cursor.nextIndex]],
      next=cursors.find(p=>p.id===cursor.id)?.after??cursor;
    if(cursors.some(p=>p.id!==cursor.id)||next.nextIndex!==cursor.nextIndex+Number(!done)||next.done!==done||
       !eq(next.keys,cursor.keys)||!eq(next.chain,cursor.chain)||!eq(next.source,cursor.source))
      fail('For-in cursor advanced outside its retained sequence');
    const result=event.result?.[0]==='ref'?event.stateChanges.find(p=>p.table==='heap'&&p.before===null&&p.id===event.result[1])?.after:null;
    if(result?.kind!=='object'||!eq(result.properties.value?.value,value)||!eq(result.properties.done?.value,['bool',done]))
      fail('For-in next completion disagrees with the selected key');
  }else if(cursors.length)fail('For-in cursor changed outside enumeration');
}
