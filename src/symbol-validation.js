// Archive integrity for owned Symbol identities; no guest/native conversion.
import {WELL_KNOWN_SYMBOLS,isSymbolPropertyKey,propertyKeyValue} from './property-keys.js';
export function validateSymbolReferences(value,heap,fail){
  const symbol=id=>{
    if(typeof id!=='string'||!(id.startsWith('well-known:')?
      WELL_KNOWN_SYMBOLS.includes(id.slice('well-known:'.length)):heap[id]?.kind==='symbol'))
      fail('Unresolved owned symbol identity');
  };
  function visit(item){
    if(!item||typeof item!=='object')return;
    if(Array.isArray(item)){
      if(item[0]==='symbol'){
        if(item.length!==2)fail('Noncanonical owned symbol value');
        symbol(item[1]);return;
      }
      for(const member of item)visit(member);
    }else for(const [key,member] of Object.entries(item)){
      if(isSymbolPropertyKey(key))symbol(propertyKeyValue(key)[1]);
      visit(member);
    }
  }
  visit(value);
}
export function validateSymbolAllocation(patch,event,fail){
  if(patch.table!=='heap'||patch.before?.kind!=='symbol'&&patch.after?.kind!=='symbol')return;
  const entity=patch.after;
  if(patch.before!==null||!entity||entity.kind!=='symbol'||
     entity.description?.[0]!=='undefined'&&entity.description?.[0]!=='str'||
     entity.description.length!==(entity.description[0]==='undefined'?1:2)||
     entity.description[0]==='str'&&typeof entity.description[1]!=='string'||
     entity.registeredKey!==undefined&&(typeof entity.registeredKey!=='string'||entity.description[1]!==entity.registeredKey)||
     Object.keys(entity.properties??{}).length||Object.keys(entity.accessors??{}).length||
     event.operation!=='call.enter'||event.result?.[0]!=='symbol'||event.result[1]!==entity.id)
    fail('Invalid or mutable owned symbol allocation');
  const callee=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0];
  if(entity.registeredKey===undefined?callee?.[0]!=='intrinsic'||callee[1]!=='Symbol':
    callee?.[0]!=='builtinfn'||callee[1]!=='Symbol.for')fail('Unowned symbol constructor');
}
