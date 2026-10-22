// Independent host-request audit. Operates only on reconstructed archive state;
// neither the interpreter nor its request serializer runs in this validator.
import {isDeepStrictEqual} from 'node:util';
import {hostOperation} from './operations.js';

const indexKey = key => /^(0|[1-9]\d*)$/.test(key) && Number(key)<4294967295;
const checked = (condition,message) => {
  if(!condition)throw new TypeError('Host request integrity: '+message);
};

export function validatePreparedRequest(heap,effect) {
  checked(effect && typeof effect==='object','missing effect record');
  const spec=hostOperation(effect.operation);
  const request=effect.request;
  checked(request?.schema==='host-request/1' && request.operation===effect.operation &&
    request.signature===spec.signature && request.codec===spec.codec &&
    effect.kind===spec.kind,'undeclared request schema or effect kind');
  checked(Array.isArray(effect.args) && effect.args.length===spec.arity &&
    effect.args[spec.key]?.[0]==='str' && typeof effect.args[spec.key]?.[1]==='string',
    'operation argument signature');
  checked(typeof request.payload==='string' &&
    Buffer.byteLength(request.payload,'utf8')===request.byteLength,'invalid immutable payload size');
  checked(request.byteLength<=65536 && request.byteLength>=2,'payload size limit');
  const visited=new Set(),versions=[];
  function encode(value,depth) {
    checked(depth<=64 && Array.isArray(value),'unsupported nested guest value');
    const kind=value[0],payload=value[1];
    switch(kind){
      case 'null':checked(value.length===1,'null tuple');return 'null';
      case 'bool':checked(value.length===2 && typeof payload==='boolean','boolean tuple');
        return payload?'true':'false';
      case 'str':checked(value.length===2 && typeof payload==='string','string tuple');
        return JSON.stringify(payload);
      case 'num':{
        checked(value.length===2 && typeof payload==='number' &&
          Number.isFinite(payload) && !Object.is(payload,-0),'finite JSON number');
        return JSON.stringify(payload);
      }
      case 'ref':{
        checked(value.length===2 && typeof payload==='string' &&
          Object.hasOwn(heap,payload),'unowned or missing guest object');
        checked(!visited.has(payload),'alias or cycle requires a graph codec');
        visited.add(payload);
        checked(visited.size<=1024,'graph node limit');
        const obj=heap[payload];
        checked(['object','array'].includes(obj.kind),'non-data guest identity');
        const snapshot={id:payload,version:obj.version,shapeVersion:obj.shapeVersion??0,
          properties:{}};
        versions.push(snapshot);
        const properties=obj.properties;
        checked(properties && typeof properties==='object','missing object property table');
        if(obj.kind==='array'){
          const len=properties.length?.value;
          checked(Array.isArray(len) && len[0]==='num' &&
            Number.isSafeInteger(len[1]) && len[1]>=0 && len[1]<=1024,'array length');
          const keys=Object.keys(properties).filter(k=>k!=='length');
          checked(keys.length===len[1] && keys.every(k=>indexKey(k) && Number(k)<len[1]),
            'sparse array or unexpected extra fields');
          const output=[];
          for(let i=0;i<len[1];i++){
            const key=String(i);
            checked(Object.hasOwn(properties,key),'missing array element');
            snapshot.properties[key]=obj.propertyVersions?.[key]??0;
            output.push(encode(properties[key].value,depth+1));
          }
          snapshot.properties.length=obj.propertyVersions?.length??0;
          return '['+output.join(',')+']';
        }
        const entries=[];
        for(const [key,member] of Object.entries(properties)){
          checked(key!=='__proto__','unregistered prototype encoding');
          snapshot.properties[key]=obj.propertyVersions?.[key]??0;
          entries.push(JSON.stringify(key)+':'+encode(member.value,depth+1));
        }
        return '{'+entries.join(',')+'}';
      }
      default:throw new TypeError('Host request integrity: unresolved internal guest value');
    }
  }
  const expected='['+effect.args.map(v=>encode(v,0)).join(',')+']';
  checked(expected===request.payload,'materialized bytes differ from committed argument graph');
  checked(isDeepStrictEqual(versions,request.graphVersions),
    'graph provenance or property versions do not match');
  return {valid:true,operation:effect.operation,byteLength:request.byteLength,
    graphNodes:versions.length};
}
