// Independent native observation only. On the locked Node runtime, the native
// util binding reads Promise slots without describing guest objects or calling
// then, constructor, species, or Error.stack. Inspector Runtime.getProperties
// describes Error-valued properties/results and can invoke their stack getter;
// native await/then also performs observable constructor/species lookup.
//
// This internal Node API is a deliberate runtime dependency of the trusted
// source-reference child. That child alone receives --expose-internals. Its
// guest VM gets no binding, require, process, or additional globals. A caller
// drains jobs under its existing deadline before asking for this slot snapshot.
// If the pinned runtime cannot provide the binding, refuse without falling
// back to an observer that could execute guest code.
import {createRequire} from 'node:module';
import {types} from 'node:util';

const require=createRequire(import.meta.url);
let readSlots;
const fail=message=>{const error=new TypeError('Native Promise observation: '+message);
  error.category='unsupported.native-promise-observer';throw error;};
function slotReader(){
  if(readSlots)return readSlots;
  try{readSlots=require('internal/test/binding').internalBinding('util').getPromiseDetails;}
  catch{fail('the trusted reference worker requires native Promise slot access');}
  if(typeof readSlots!=='function')fail('the runtime does not expose native Promise slots');
  return readSlots;
}
export async function inspectNativePromiseSettlementV8(promise){
  if(!types.isPromise(promise))throw new TypeError('Native settlement inspection requires a branded Promise');
  const slots=slotReader()(promise);
  if(!Array.isArray(slots)||![0,1,2].includes(slots[0]))fail('invalid native Promise slot snapshot');
  if(slots[0]===0)return {status:'pending'};
  if(slots.length!==2)fail('native Promise result identity is unavailable');
  return {status:slots[0]===1?'fulfilled':'rejected',kind:slots[0]===1?'return':'throw',value:slots[1]};
}
