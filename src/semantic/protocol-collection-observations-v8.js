// Independent Set metadata observation. Native contents are read only through
// the captured intrinsic iterator after the native execution selected a source
// site; owned contents come from the runtime's internal Set slots.
import {types} from 'node:util';

const profile='owned-collections/1';
const own=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,getPrototype=Object.getPrototypeOf,
  extensible=Object.isExtensible,apply=Reflect.apply;
function ordinarySet(value){return types.isSet(value);}
export function createCollectionObservationAdapterV8({side}={}){
  let setPrototype=null,valuesMethod=null,nextMethod=null,iteratorPrototype=null,objectPrototype=null,setShape=null;
  const fail=message=>{throw new TypeError('Independent collection observation: '+message);};
  function checkCaptured(){
    if(!setPrototype||!valuesMethod||!nextMethod)fail('Set intrinsic realm has not been captured');
    const descriptors=own(setPrototype);
    const expected=setShape;
    if(getPrototype(setPrototype)!==objectPrototype||!extensible(setPrototype)||
      keys(descriptors).length!==expected.keys.length||
      keys(descriptors).some((key,index)=>key!==expected.keys[index]||
        !['value','get','set','writable','enumerable','configurable'].every(field=>
          Object.hasOwn(descriptors[key],field)===Object.hasOwn(expected.descriptors[key],field)&&
          Object.is(descriptors[key][field],expected.descriptors[key][field]))))
      fail('modified Set.prototype requires its own observer');
  }
  function nativeNode(value,ctx){
    if(!ordinarySet(value))return null;
    checkCaptured();
    if(getPrototype(value)!==setPrototype)ctx.fail('Set from an unregistered realm');
    const descriptors=own(value);
    if(keys(descriptors).length!==0||!extensible(value))ctx.fail('Set own properties or extensibility are outside the profile');
    const iterator=apply(valuesMethod,value,[]);
    if(!iterator||getPrototype(iterator)!==iteratorPrototype||keys(own(iterator)).length!==0)
      ctx.fail('Set intrinsic iterator allocation differs');
    const entries=[];
    for(let index=0;index<=10000;index++){
      const step=apply(nextMethod,iterator,[]);
      if(!step||typeof step!=='object'||getPrototype(step)!==objectPrototype)
        ctx.fail('Set iterator result shape differs');
      const done=Object.getOwnPropertyDescriptor(step,'done');
      if(!done||!Object.hasOwn(done,'value')||typeof done.value!=='boolean')
        ctx.fail('Set iterator result done field differs');
      if(done.value)break;
      const entry=Object.getOwnPropertyDescriptor(step,'value');
      if(!entry||!Object.hasOwn(entry,'value'))ctx.fail('Set iterator result value field differs');
      entries.push(entry.value);
      if(entries.length>10000)ctx.fail('Set size bound');
    }
    return {kind:'set',prototype:'Set.prototype',extensible:true,properties:[],
      annotations:[{name:profile,values:entries,data:{size:entries.length}}]};
  }
  function ownedNode(tag,ctx){
    const node=tag[0]==='ref'?ctx.state.heap[tag[1]]:null;
    if(node?.kind!=='set')return null;
    if(Object.keys(node.accessors??{}).length||Object.keys(node.dataAttributes??{}).length||
      node.extensible===false||node.prototype!==undefined)
      ctx.fail('Set own-state extension is outside the observation profile');
    const size=node.properties?.['[[Size]]']?.value;
    if(size?.[0]!=='num'||!Number.isSafeInteger(size[1])||size[1]<0||size[1]>10000)
      ctx.fail('owned Set size bound');
    const entries=[];
    for(let index=0;index<size[1];index++){
      const entry=node.properties[String(index)]?.value;
      if(!entry)ctx.fail('owned Set storage is sparse');
      entries.push(entry);
    }
    const allowed=new Set(['[[Size]]',...entries.map((_,index)=>String(index))]);
    if(Object.keys(node.properties??{}).some(key=>!allowed.has(key)))
      ctx.fail('owned Set has undeclared internal storage');
    return {kind:'set',prototype:'Set.prototype',extensible:true,properties:[],
      annotations:[{name:profile,values:entries,data:{size:entries.length}}]};
  }
  if(side==='owned')return {id:profile,metadataAdapter:{ownedNode}};
  return {id:profile,initializeRealm(evaluate){
    const captured=evaluate('(()=>{const s=new Set();const i=Set.prototype.values.call(s);return {'+
      'prototype:Set.prototype,objectPrototype:Object.prototype,values:Set.prototype.values,next:Object.getPrototypeOf(i).next,'+
      'iteratorPrototype:Object.getPrototypeOf(i)};})()');
    setPrototype=captured.prototype;valuesMethod=captured.values;nextMethod=captured.next;
    iteratorPrototype=captured.iteratorPrototype;objectPrototype=captured.objectPrototype;
    setShape={keys:keys(own(setPrototype)),descriptors:own(setPrototype)};
  },metadataAdapter:{nativeNode}};
}
