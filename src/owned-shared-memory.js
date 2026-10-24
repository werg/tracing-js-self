// Deterministic byte-level typed-array projection over *owned* archived bytes.
// Concurrency is not simulated here: genuine worker-agent tests use native V8.
import {encode,decode} from './values.js';

export const SHARED_TYPES=Object.freeze({
 Int8Array:{bytes:1,get:'getInt8',set:'setInt8',atomic:true},
 Uint8Array:{bytes:1,get:'getUint8',set:'setUint8',atomic:true},
 Int16Array:{bytes:2,get:'getInt16',set:'setInt16',atomic:true},
 Uint16Array:{bytes:2,get:'getUint16',set:'setUint16',atomic:true},
 Int32Array:{bytes:4,get:'getInt32',set:'setInt32',atomic:true},
 Uint32Array:{bytes:4,get:'getUint32',set:'setUint32',atomic:true},
 BigInt64Array:{bytes:8,get:'getBigInt64',set:'setBigInt64',atomic:true,bigint:true},
 BigUint64Array:{bytes:8,get:'getBigUint64',set:'setBigUint64',atomic:true,bigint:true},
 Float32Array:{bytes:4,get:'getFloat32',set:'setFloat32',atomic:false},
 Float64Array:{bytes:8,get:'getFloat64',set:'setFloat64',atomic:false}
});
export const SHARED_TYPE_NAMES=Object.freeze(Object.keys(SHARED_TYPES));
export function newSharedBuffer(id,length,maxByteLength=undefined){
 const max=maxByteLength===undefined?length:maxByteLength;
 if(!Number.isSafeInteger(length)||length<0||length>1024||
    !Number.isSafeInteger(max)||max<length||max>1024)
   throw new RangeError('SharedArrayBuffer length outside bounded profile');
 return {id,kind:'shared-int32-buffer',byteLength:length,maxByteLength:max,
   growable:maxByteLength!==undefined,bytes:Array(length).fill(0),version:0};
}
export function growSharedBuffer(buffer,length){
 if(buffer?.kind!=='shared-int32-buffer'||!buffer.growable)
   throw new TypeError('SharedArrayBuffer is not growable');
 if(!Number.isSafeInteger(length)||length<buffer.byteLength||
    length>buffer.maxByteLength)throw new RangeError('Invalid buffer growth');
 buffer.bytes.push(...Array(length-buffer.byteLength).fill(0));
 buffer.byteLength=length;
}
export function effectiveSharedLength(buffer,view){
 const width=SHARED_TYPES[view.elementType].bytes;
 return view.lengthTracking
   ? Math.max(0,Math.floor((buffer.byteLength-view.byteOffset)/width)):view.length;
}
export function newSharedView(id,buffer,type,offset=0,length=undefined){
 const spec=SHARED_TYPES[type];
 if(!spec||buffer?.kind!=='shared-int32-buffer')
   throw new TypeError('Owned shared typed-array buffer expected');
 if(!Number.isSafeInteger(offset)||offset<0||offset%spec.bytes!==0||
   offset>buffer.byteLength)throw new RangeError('Invalid shared view byte offset');
 const available=buffer.byteLength-offset;
 const lengthTracking=length===undefined&&buffer.growable===true;
 if(length===undefined){
   if(!lengthTracking&&available%spec.bytes!==0)
     throw new RangeError('Shared view byte size is not aligned');
   length=Math.floor(available/spec.bytes);
 }
 if(!Number.isSafeInteger(length)||length<0||length*spec.bytes>available)
   throw new RangeError('Shared view length exceeds buffer');
 return {id,kind:'shared-int32-view',bufferId:buffer.id,elementType:type,
   byteOffset:offset,length,lengthTracking,version:0};
}
function data(buffer,view,index){
 const spec=SHARED_TYPES[view.elementType];
 if(!spec||buffer?.kind!=='shared-int32-buffer'||
    !Array.isArray(buffer.bytes)||buffer.bytes.length!==buffer.byteLength)
   throw new TypeError('Corrupt owned shared-memory graph');
 if(!Number.isInteger(index)||index<0||index>=effectiveSharedLength(buffer,view))
   throw new RangeError('Shared array index out of bounds');
 const bytes=Uint8Array.from(buffer.bytes);
 return {spec,bytes,data:new DataView(bytes.buffer),
   offset:view.byteOffset+index*spec.bytes};
}
export function readSharedElement(buffer,view,index){
 const d=data(buffer,view,index);
 return encode(d.data[d.spec.get](d.offset,true));
}
export function writeSharedElement(buffer,view,index,value){
 const d=data(buffer,view,index);
 if(d.spec.bigint){
   if(value?.[0]!=='bigint')throw new TypeError('BigInt typed array needs a BigInt');
   d.data[d.spec.set](d.offset,decode(value),true);
 }else{
   if(!['num','bool','str','null','undefined'].includes(value?.[0]))
     throw new TypeError('Typed-array ToNumber requires owned scalar');
   d.data[d.spec.set](d.offset,Number(decode(value)),true);
 }
 buffer.bytes=Array.from(d.bytes);
}
export function atomicSharedElement(buffer,view,method,index,values=[]){
 const spec=SHARED_TYPES[view.elementType];
 if(!spec?.atomic)throw new TypeError('Atomics requires integer typed array');
 const old=readSharedElement(buffer,view,index);
 if(method==='load')return old;
 const take=v=>{
   if(spec.bigint){
     if(v?.[0]!=='bigint')throw new TypeError('BigInt Atomics requires BigInt');
     return decode(v);
   }
   if(v?.[0]!=='num'||!Number.isFinite(decode(v)))
     throw new TypeError('Numeric Atomics requires finite number');
   return Number(decode(v));
 };
 if(method==='notify'||method==='wait'){
   if(!['Int32Array','BigInt64Array'].includes(view.elementType))
     throw new TypeError('Only Int32/BigInt64 arrays support wait/notify');
   if(method==='notify')return ['num',0];
   if(values.length!==2||Number(decode(values[1]))!==0)
     throw new TypeError('Only zero-timeout single-agent wait is owned');
   return ['str',Object.is(decode(old),take(values[0]))?'timed-out':'not-equal'];
 }
 const oldValue=decode(old),v=take(values[0]);
 if(method==='store'){
   writeSharedElement(buffer,view,index,encode(v));
   return encode(v);
 }
 let next;
 switch(method){
   case 'add':next=oldValue+v;break;
   case 'sub':next=oldValue-v;break;
   case 'and':next=oldValue&v;break;
   case 'or':next=oldValue|v;break;
   case 'xor':next=oldValue^v;break;
   case 'exchange':next=v;break;
   case 'compareExchange':next=Object.is(oldValue,v)?take(values[1]):oldValue;break;
   default:throw new TypeError('Unknown atomic method');
 }
 writeSharedElement(buffer,view,index,encode(next));
 return old;
}
