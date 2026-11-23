// The tagged Promise identity and its scheduler record share one ordinary
// property store. Views below borrow the records; they never copy guest state
// or create a second identity for a Promise.
import {token} from './values.js';
import {symbolPropertyKey} from './property-keys.js';

function promisePrototypeRecord(){
  const properties={constructor:token(['intrinsic','Promise'])};
  for(const method of ['then','catch','finally'])properties[method]=token(['builtinfn','Promise.prototype.'+method]);
  const tag=symbolPropertyKey('well-known:toStringTag');properties[tag]=token(['str','Promise']);
  return {id:'Promise.prototype',kind:'object',prototype:'Object.prototype',
    properties,propertyVersions:Object.fromEntries(Object.keys(properties).map(key=>[key,0])),
    dataAttributes:Object.fromEntries(Object.keys(properties).map(key=>[key,{writable:key!==tag,enumerable:false,configurable:true}])),
    propertyOrder:Object.keys(properties),shapeVersion:0,extensible:true,version:0};
}

export function ensurePromisePrototype(state){
  return state.heap['Promise.prototype']??=promisePrototypeRecord();
}

export function ownedObjectStorage(state,value){
  if(value?.[0]==='promise')return state.promises[value[1]]??null;
  if(value?.[0]==='ref')return state.heap[value[1]]??null;
  if(value?.[0]==='intrinsic'&&value[1]==='Promise.prototype')return ensurePromisePrototype(state);
  return null;
}

export function ownedObjectHeap(state){
  // The pristine intrinsic descriptor is immutable until its identity is
  // exposed to a property/prototype operation. Its fixed identity is the same
  // before and after materialization; an ordinary Promise allocation does not
  // allocate an unrelated guest object or consume an object counter.
  return Object.assign(Object.create(null),{'Promise.prototype':promisePrototypeRecord()},state.heap,state.promises);
}

export function ownedObjectValue(state,id){
  return id==='Promise.prototype'?['intrinsic',id]:state.promises[id]?['promise',id]:['ref',id];
}
