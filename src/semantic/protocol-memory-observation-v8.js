// Independent binary observations use intrinsic slot getters and raw bytes,
// never guest getters or the public/owned evaluator's mutation routines.
import {types,isDeepStrictEqual} from 'node:util';
import {encode} from '../values.js';
const entries={Int8Array:[1,'getInt8'],Uint8Array:[1,'getUint8'],Int16Array:[2,'getInt16'],Uint16Array:[2,'getUint16'],
  Int32Array:[4,'getInt32'],Uint32Array:[4,'getUint32'],Float32Array:[4,'getFloat32'],Float64Array:[8,'getFloat64'],
  BigInt64Array:[8,'getBigInt64'],BigUint64Array:[8,'getBigUint64']};
const names=['ArrayBuffer','SharedArrayBuffer','DataView',...Object.keys(entries)];
const apply=Reflect.apply,typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const getter=(prototype,key)=>Object.getOwnPropertyDescriptor(prototype,key)?.get;
const ab=Object.fromEntries(['byteLength','maxByteLength','resizable','detached'].map(name=>[name,getter(ArrayBuffer.prototype,name)]));
const sab=Object.fromEntries(['byteLength','maxByteLength','growable'].map(name=>[name,getter(SharedArrayBuffer.prototype,name)]));
const ta=Object.fromEntries(['buffer','byteOffset','byteLength','length'].map(name=>[name,getter(typedPrototype,name)]));
const dv=Object.fromEntries(['buffer','byteOffset','byteLength'].map(name=>[name,getter(DataView.prototype,name)]));
const tag=getter(typedPrototype,Symbol.toStringTag),call=(fn,value)=>apply(fn,value,[]);
const annotation=(name,values,data)=>({name,values,data});
export function createMemoryObservationAdapterV8(){
  const prototypes=new Map(names.map(name=>[globalThis[name].prototype,name+'.prototype']));
  return {id:'owned-binary-memory-observation/1',
    ownedAssignmentValue({event,object}){
      if(!['typed-array','shared-int32-view'].includes(object.kind))return undefined;
      const value=event.operands?.[2];
      if(!Array.isArray(value)||!isDeepStrictEqual(event.result,value))throw new TypeError('Typed-array assignment completion differs from its operand');
      // The accompanying independent byte/view metadata receipts check the
      // committed storage, including ignored indices and narrowed values.
      return structuredClone(value);
    },
    initializeRealm(evaluate){
      const values=evaluate('['+names.map(name=>'['+JSON.stringify(name+'.prototype')+','+name+'.prototype]').join(',')+']');
      for(const [name,value]of values)prototypes.set(value,name);
    },
    metadataAdapter:{
      nativeNode(value,ctx){
        const buffer=types.isAnyArrayBuffer(value),dataView=types.isDataView(value),typed=types.isTypedArray(value);
        if(!buffer&&!dataView&&!typed)return null;
        const base=ctx.defaultNode(value),prototype=Object.getPrototypeOf(value);
        base.prototype=prototypes.get(prototype)??ctx.intrinsicPrototype(prototype);
        if(buffer){
          const shared=types.isSharedArrayBuffer(value),getters=shared?sab:ab,byteLength=call(getters.byteLength,value);
          if(byteLength>1024)throw new RangeError('Independent binary byte bound');
          // Node 20 has no ArrayBuffer.prototype.detached getter. Creating the
          // intrinsic view independently proves that the buffer is attached:
          // detached buffers throw here even when their byteLength is zero.
          const bytes=Array.from(new Uint8Array(value));
          const metadata={byteLength,maxByteLength:call(getters.maxByteLength,value),
            ...(shared?{growable:call(sab.growable,value)}:{resizable:call(ab.resizable,value),detached:ab.detached?call(ab.detached,value):false}),
            bytes};
          return {...base,kind:shared?'shared-int32-buffer':'array-buffer',annotations:[annotation('binary-buffer',[],metadata)]};
        }
        const getters=dataView?dv:ta,backing=call(getters.buffer,value),shared=types.isSharedArrayBuffer(backing),
          byteOffset=call(getters.byteOffset,value),byteLength=call(getters.byteLength,value);
        const metadata=dataView?{byteOffset,byteLength}:{elementType:call(tag,value),byteOffset,byteLength,length:call(ta.length,value)};
        if(!dataView&&!Object.hasOwn(entries,metadata.elementType))ctx.fail('Unqualified typed-array element type');
        return {...base,kind:dataView?(shared?'shared-data-view':'data-view'):(shared?'shared-int32-view':'typed-array'),
          annotations:[annotation('binary-view',[backing],metadata)]};
      },
      ownedNode(value,ctx){
        if(value[0]!=='ref')return null;
        const node=ctx.state.heap[value[1]];
        if(!['array-buffer','shared-int32-buffer','typed-array','shared-int32-view','data-view','shared-data-view'].includes(node?.kind))return null;
        const buffer=['array-buffer','shared-int32-buffer'].includes(node.kind),dataView=['data-view','shared-data-view'].includes(node.kind);
        const prototype=(buffer?(node.kind==='array-buffer'?'ArrayBuffer':'SharedArrayBuffer'):dataView?'DataView':node.elementType)+'.prototype';
        if(buffer)return {kind:node.kind,prototype,extensible:true,properties:[],annotations:[annotation('binary-buffer',[],{
          byteLength:node.byteLength,maxByteLength:node.maxByteLength,
          ...(node.kind==='array-buffer'?{resizable:node.resizable,detached:node.detached}:{growable:node.growable}),bytes:[...node.bytes]})]};
        const backing=ctx.state.heap[node.bufferId];if(!backing)ctx.fail('Missing binary observation backing');
        const width=dataView?1:entries[node.elementType]?.[0];if(!width)ctx.fail('Unknown binary observation type');
        const length=dataView?null:node.lengthTracking?Math.floor((backing.byteLength-node.byteOffset)/width):node.length,
          byteLength=dataView?(node.lengthTracking?backing.byteLength-node.byteOffset:node.byteLength):length*width;
        const data=new DataView(Uint8Array.from(backing.bytes).buffer),properties=[];
        if(!dataView)for(let index=0;index<length;index++)properties.push({key:['str',String(index)],descriptor:{kind:'data',
          value:encode(data[entries[node.elementType][1]](node.byteOffset+index*width,true)),writable:true,enumerable:true,configurable:true}});
        return {kind:node.kind,prototype,extensible:true,properties,annotations:[annotation('binary-view',[['ref',node.bufferId]],
          dataView?{byteOffset:node.byteOffset,byteLength}:{elementType:node.elementType,byteOffset:node.byteOffset,byteLength,length})]};
      }
    }
  };
}
