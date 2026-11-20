// JSON-safe owned property keys. Symbol identity is never its description.
// Escaping every string beginning with NUL makes the two namespaces disjoint,
// including guest strings chosen to resemble these private storage prefixes.
const SYMBOL='\u0000symbol:', STRING='\u0000string:';
export const WELL_KNOWN_SYMBOLS=Object.freeze([
  'iterator','asyncIterator','toPrimitive','hasInstance','species',
  'isConcatSpreadable','match','matchAll','replace','search','split',
  'toStringTag','unscopables'
]);
export const wellKnownSymbol=name=>['symbol','well-known:'+name];
export function stringPropertyKey(name){
  if(typeof name!=='string')throw new TypeError('Expected string property key');
  return name.startsWith('\u0000')?STRING+name:name;
}
export function symbolPropertyKey(id){
  if(typeof id!=='string'||!id)throw new TypeError('Expected symbol identity');
  return SYMBOL+id;
}
export const isSymbolPropertyKey=key=>typeof key==='string'&&key.startsWith(SYMBOL);
export function propertyKeyValue(key){
  if(isSymbolPropertyKey(key))return ['symbol',key.slice(SYMBOL.length)];
  return ['str',key.startsWith(STRING)?key.slice(STRING.length):key];
}
export function stringPropertyName(key){
  const value=propertyKeyValue(key);
  if(value[0]!=='str')throw new TypeError('Symbol property transport is outside the data boundary profile');
  return value[1];
}
