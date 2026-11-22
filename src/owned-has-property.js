// Owned ordinary [[HasProperty]]. No guest value is reflected into a native
// object and no accessor body is invoked for an existence check.
import {symbolPropertyKey} from './property-keys.js';
const objectKeys=new Set(['constructor','__defineGetter__','__defineSetter__','hasOwnProperty',
  '__lookupGetter__','__lookupSetter__','isPrototypeOf','propertyIsEnumerable','toString','valueOf',
  '__proto__','toLocaleString']);
const arrayKeys=new Set(['length','constructor','at','concat','copyWithin','fill','find','findIndex',
  'findLast','findLastIndex','lastIndexOf','pop','push','reverse','shift','unshift','slice','sort','splice',
  'includes','indexOf','join','keys','entries','values','forEach','filter','flat','flatMap','map','every',
  'some','reduce','reduceRight','toReversed','toSorted','toSpliced','with','toLocaleString','toString',
  symbolPropertyKey('well-known:iterator'),symbolPropertyKey('well-known:unscopables')]);
const functionKeys=new Set(['length','name','arguments','caller','constructor','apply','bind','call','toString',
  symbolPropertyKey('well-known:hasInstance')]);
export function ownedHasProperty(heap,receiver,key){
  let object=receiver?.[0]==='ref'?heap[receiver[1]]:null;
  const seen=new Set();
  while(object){
    if(!['object','array','function'].includes(object.kind)||seen.has(object.id))
      throw new TypeError('Unsupported ordinary in-operator receiver or prototype');
    seen.add(object.id);
    if(Object.hasOwn(object.properties??{},key)||Object.hasOwn(object.accessors??{},key))return true;
    if(object.kind==='function'&&['name','length'].includes(key))return true;
    if(object.kind==='function'&&key==='prototype'&&!object.arrow&&!object.async&&!object.nonConstructible)return true;
    if(object.declaredError&&key==='constructor')return true;
    const parent=Object.hasOwn(object,'prototype')?object.prototype:
      object.kind==='array'?'Array.prototype':object.kind==='function'?'Function.prototype':'Object.prototype';
    if(parent===null)return false;
    if(parent==='Object.prototype')return objectKeys.has(key);
    if(parent==='Array.prototype')return arrayKeys.has(key)||objectKeys.has(key);
    if(parent==='Function.prototype')return functionKeys.has(key)||objectKeys.has(key);
    object=heap[parent];
    if(!object)throw new TypeError('Unsupported ordinary in-operator intrinsic prototype');
  }
  throw new TypeError('Unsupported ordinary in-operator receiver');
}
