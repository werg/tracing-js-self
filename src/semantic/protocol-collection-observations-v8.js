// Independent native collection observations use captured builtin iterators;
// owned observations project only the runtime's internal collection slots.
import {types} from 'node:util';

const profile='owned-collections/1';
const own=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,getPrototype=Object.getPrototypeOf,
  extensible=Object.isExtensible,apply=Reflect.apply;
export function createCollectionObservationAdapterV8({side}={}){
  let setPrototype=null,mapPrototype=null,objectPrototype=null,setValues=null,setNext=null,
    mapEntries=null,mapNext=null,setIteratorPrototype=null,mapIteratorPrototype=null,setShape=null,mapShape=null;
  const fail=message=>{throw new TypeError('Independent collection observation: '+message);};
  function unchanged(prototype,shape){
    if(!prototype||!shape||getPrototype(prototype)!==objectPrototype||!extensible(prototype))return false;
    const descriptors=own(prototype),actual=keys(descriptors);
    return actual.length===shape.keys.length&&actual.every((key,index)=>key===shape.keys[index]&&
      ['value','get','set','writable','enumerable','configurable'].every(field=>
        Object.hasOwn(descriptors[key],field)===Object.hasOwn(shape.descriptors[key],field)&&
        Object.is(descriptors[key][field],shape.descriptors[key][field])));
  }
  function nativeEntries(collection,kind,ctx){
    const iterator=kind==='set'?apply(setValues,collection,[]):apply(mapEntries,collection,[]),
      expectedIterator=kind==='set'?setIteratorPrototype:mapIteratorPrototype,
      next=kind==='set'?setNext:mapNext;
    if(!iterator||getPrototype(iterator)!==expectedIterator||keys(own(iterator)).length!==0)
      ctx.fail(kind+' intrinsic iterator allocation differs');
    const entries=[];
    for(let index=0;index<=10000;index++){
      const step=apply(next,iterator,[]);
      if(!step||typeof step!=='object'||getPrototype(step)!==objectPrototype)
        ctx.fail(kind+' iterator result shape differs');
      const done=Object.getOwnPropertyDescriptor(step,'done');
      if(!done||!Object.hasOwn(done,'value')||typeof done.value!=='boolean')ctx.fail(kind+' iterator done field differs');
      if(done.value)break;
      const slot=Object.getOwnPropertyDescriptor(step,'value');
      if(!slot||!Object.hasOwn(slot,'value'))ctx.fail(kind+' iterator value field differs');
      if(kind==='set')entries.push(slot.value);
      else{
        if(!Array.isArray(slot.value))ctx.fail('Map entries iterator must yield an Array');
        const descriptors=own(slot.value);
        if(!Object.hasOwn(descriptors,'0')||!Object.hasOwn(descriptors,'1'))ctx.fail('Map entry pair is sparse');
        entries.push(descriptors['0'].value,descriptors['1'].value);
      }
      if(entries.length>(kind==='set'?10000:20000))ctx.fail(kind+' size bound');
    }
    return entries;
  }
  function nativeNode(value,ctx){
    if(types.isSet(value)){
      if(!unchanged(setPrototype,setShape))ctx.fail('modified Set.prototype requires its own observer');
      if(getPrototype(value)!==setPrototype||keys(own(value)).length!==0||!extensible(value))
        ctx.fail('Set realm, own properties or extensibility are outside the profile');
      const entries=nativeEntries(value,'set',ctx);
      return {kind:'set',prototype:'Set.prototype',extensible:true,properties:[],
        annotations:[{name:profile,values:entries,data:{kind:'set',size:entries.length}}]};
    }
    if(types.isMap(value)){
      if(!unchanged(mapPrototype,mapShape))ctx.fail('modified Map.prototype requires its own observer');
      if(getPrototype(value)!==mapPrototype||keys(own(value)).length!==0||!extensible(value))
        ctx.fail('Map realm, own properties or extensibility are outside the profile');
      const flat=nativeEntries(value,'map',ctx),size=flat.length/2;
      return {kind:'map',prototype:'Map.prototype',extensible:true,properties:[],
        annotations:[{name:profile,values:flat,data:{kind:'map',size}}]};
    }
    return null;
  }
  function ownedNode(tag,ctx){
    const node=tag[0]==='ref'?ctx.state.heap[tag[1]]:null;
    if(!['set','map'].includes(node?.kind))return null;
    if(Object.keys(node.accessors??{}).length||Object.keys(node.dataAttributes??{}).length||
      node.extensible===false||node.prototype!==undefined)
      ctx.fail('collection own-state extension is outside the observation profile');
    const size=node.properties?.['[[Size]]']?.value,count=node.properties?.['[[EntryCount]]']?.value;
    if(size?.[0]!=='num'||count?.[0]!=='num'||!Number.isSafeInteger(size[1])||
      !Number.isSafeInteger(count[1])||size[1]<0||size[1]>10000||count[1]<size[1]||count[1]>10000)
      ctx.fail('owned collection size bound');
    const flat=[];let live=0;const allowed=new Set(['[[Size]]','[[EntryCount]]',...Array.from({length:count[1]},(_,index)=>String(index))]);
    for(let index=0;index<count[1];index++){
      const entry=node.properties[String(index)]?.value;
      if(!entry)ctx.fail('owned collection storage is sparse');
      if(entry[0]==='deleted')continue;
      live++;
      if(node.kind==='set')flat.push(entry);
      else if(entry[0]==='map-entry'&&entry.length===3)flat.push(entry[1],entry[2]);
      else ctx.fail('owned Map entry shape');
    }
    if(live!==size[1]||Object.keys(node.properties??{}).some(key=>!allowed.has(key)))
      ctx.fail('owned collection size or internal slots differ');
    return {kind:node.kind,prototype:node.kind==='set'?'Set.prototype':'Map.prototype',extensible:true,properties:[],
      annotations:[{name:profile,values:flat,data:{kind:node.kind,size:live}}]};
  }
  if(side==='owned')return {id:profile,metadataAdapter:{ownedNode}};
  return {id:profile,initializeRealm(evaluate){
    const captured=evaluate('(()=>{const s=new Set(),m=new Map(),si=Set.prototype.values.call(s),mi=Map.prototype.entries.call(m);return {'+
      'objectPrototype:Object.prototype,setPrototype:Set.prototype,mapPrototype:Map.prototype,'+
      'setValues:Set.prototype.values,setNext:Object.getPrototypeOf(si).next,setIteratorPrototype:Object.getPrototypeOf(si),'+
      'mapEntries:Map.prototype.entries,mapNext:Object.getPrototypeOf(mi).next,mapIteratorPrototype:Object.getPrototypeOf(mi)};})()');
    ({objectPrototype,setPrototype,mapPrototype,setValues,setNext,setIteratorPrototype,mapEntries,mapNext,mapIteratorPrototype}=captured);
    setShape={keys:keys(own(setPrototype)),descriptors:own(setPrototype)};
    mapShape={keys:keys(own(mapPrototype)),descriptors:own(mapPrototype)};
  },metadataAdapter:{nativeNode}};
}
