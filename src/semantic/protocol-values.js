// A separately versioned public interface proposal. Existing semantic-trace/6
// and /7 consumers must refuse Symbol values; this does not widen those formats.
import {WELL_KNOWN_SYMBOLS} from '../property-keys.js';
export const PROTOCOL_VALUE_SCHEMA='semantic-protocol-values/1';
export function protocolSymbols(heap){
  const symbols=WELL_KNOWN_SYMBOLS.map(name=>({id:'well-known:'+name,kind:'well-known',name}));
  for(const entity of Object.values(heap))if(entity.kind==='symbol')symbols.push({
    id:entity.id,kind:entity.registeredKey===undefined?'unique':'registry',
    description:structuredClone(entity.description),
    ...(entity.registeredKey===undefined?{}:{key:entity.registeredKey})
  });
  const result={schema:PROTOCOL_VALUE_SCHEMA,symbols};
  validateProtocolSymbols(result);return result;
}
export function validateProtocolSymbols(record){
  const bad=()=>{throw new TypeError('Invalid semantic-protocol-values/1 symbol interface');};
  if(!record||record.schema!==PROTOCOL_VALUE_SCHEMA||!Array.isArray(record.symbols)||
     Object.keys(record).sort().join(',')!=='schema,symbols')bad();
  const identities=new Set(),registry=new Set();
  for(const symbol of record.symbols){
    if(!symbol||typeof symbol.id!=='string'||identities.has(symbol.id))bad();
    identities.add(symbol.id);
    if(symbol.kind==='well-known'){
      if(Object.keys(symbol).sort().join(',')!=='id,kind,name'||!WELL_KNOWN_SYMBOLS.includes(symbol.name)||symbol.id!=='well-known:'+symbol.name)bad();
    }else if(symbol.kind==='unique'||symbol.kind==='registry'){
      if(!/^o[1-9][0-9]*$/.test(symbol.id)||Object.keys(symbol).sort().join(',')!==
         (symbol.kind==='unique'?'description,id,kind':'description,id,key,kind'))bad();
      const d=symbol.description;
      if(!Array.isArray(d)||!(d.length===1&&d[0]==='undefined'||d.length===2&&d[0]==='str'&&typeof d[1]==='string'))bad();
      if(symbol.kind==='registry'){
        if(typeof symbol.key!=='string'||registry.has(symbol.key)||d[0]!=='str'||d[1]!==symbol.key)bad();
        registry.add(symbol.key);
      }
    }else bad();
  }
  return {valid:true,symbols:identities.size};
}
