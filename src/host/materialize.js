// A fail-closed, deterministic external codec for the bounded owned graph.
// Never call a guest function, getter, toJSON, Symbol.toPrimitive or prototype.
// This is a transport encoder, not an ECMAScript ToJSON operation.
import {decode} from '../values.js';

export const JSON_CODEC='canonical-json/1';
const arrayIndex=key=>/^(0|[1-9]\d*)$/.test(key) && Number(key)<4294967295;
const literal=s=>JSON.stringify(s);

export function materializeJson(heap, args, {maxNodes=1024,maxDepth=64,maxBytes=65536}={}) {
  if(!heap || typeof heap!=='object' || !Array.isArray(args))
    throw new TypeError('Expected a guest heap and argument token list');
  const seen=new Set(),versions=[],stack=new Set();
  let nodes=0;
  function serialize(value,depth) {
    if(depth>maxDepth)throw new RangeError('External graph depth limit');
    if(!Array.isArray(value))throw new TypeError('Invalid tagged guest value');
    const [kind,payload]=value;
    switch(kind){
      case 'null':return 'null';
      case 'bool':
        if(typeof payload!=='boolean')throw new TypeError('Invalid boolean');
        return payload?'true':'false';
      case 'str':
        if(typeof payload!=='string')throw new TypeError('Invalid string');
        return literal(payload);
      case 'num': {
        const n=decode(value);
        if(typeof n!=='number' || !Number.isFinite(n) || Object.is(n,-0))
          throw new TypeError('Non-roundtrippable JSON number');
        return literal(n);
      }
      case 'ref': {
        if(typeof payload!=='string'||!Object.hasOwn(heap,payload))
          throw new TypeError('Unresolved guest reference');
        if(stack.has(payload))throw new TypeError('Cycles require an explicit graph codec');
        if(seen.has(payload))throw new TypeError('Aliases require an explicit graph codec');
        if(++nodes>maxNodes)throw new RangeError('External graph node limit');
        seen.add(payload);stack.add(payload);
        const obj=heap[payload];
        if(!['array','object'].includes(obj.kind) || !obj.properties)
          throw new TypeError('Unsupported external guest identity');
        const record={id:payload,version:obj.version,shapeVersion:obj.shapeVersion??0,
          properties:{}};
        versions.push(record);
        let output;
        if(obj.kind==='array'){
          const length=decode(obj.properties.length?.value);
          if(!Number.isSafeInteger(length)||length<0 || length>maxNodes)
            throw new RangeError('External array length limit');
          const keys=Object.keys(obj.properties).filter(k=>k!=='length');
          if(keys.length!==length || keys.some(k=>!arrayIndex(k)||Number(k)>=length))
            throw new TypeError('External arrays must be dense without extra properties');
          output='['+Array.from({length},(_,i)=>{
            const key=String(i);
            if(!Object.hasOwn(obj.properties,key))
              throw new TypeError('External array hole');
            record.properties[key]=obj.propertyVersions?.[key]??0;
            return serialize(obj.properties[key].value,depth+1);
          }).join(',')+']';
          record.properties.length=obj.propertyVersions?.length??0;
        }else{
          const entries=[];
          for(const key of Object.keys(obj.properties)){
            if(key==='__proto__')throw new TypeError('Unsupported external prototype key');
            record.properties[key]=obj.propertyVersions?.[key]??0;
            entries.push(literal(key)+':'+serialize(obj.properties[key].value,depth+1));
          }
          output='{'+entries.join(',')+'}';
        }
        stack.delete(payload);
        return output;
      }
      default:
        throw new TypeError('External JSON codec cannot materialize '+String(kind));
    }
  }
  const payload='['+args.map(value=>serialize(value,0)).join(',')+']';
  const byteLength=Buffer.byteLength(payload,'utf8');
  if(byteLength>maxBytes)throw new RangeError('External JSON payload limit');
  // Strings are immutable. Return versions as a separate frozen snapshot;
  // no live guest reference or object contents escape this boundary.
  for(const v of versions){Object.freeze(v.properties);Object.freeze(v);}
  return Object.freeze({codec:JSON_CODEC,payload,byteLength,
    graphVersions:Object.freeze(versions)});
}
