// Independently executed V8 reference for a narrow Test262 scalar assertion
// contract. This is NOT the complete official Test262 harness.
import {createContext,runInContext} from 'node:vm';
import {test262Metadata} from './import-external.mjs';
export function scalarTest262Reference(source,{timeoutMs=300}={}){
 const meta=test262Metadata(source);
 if(meta.metadataStatus!=='parsed'||meta.negative||
    meta.includes.length||meta.flags.some(f=>f!=='noStrict')||
    meta.features.some(f=>!['BigInt','exponentiation'].includes(f)))
   return {status:'unsupported',reason:'Metadata outside narrow scalar reference'};
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>1000)
   throw new TypeError('Invalid Test262 scalar reference timeout');
 const prefix=[
  'var __scalarAssertCount=0;',
  'function Test262Error(message){this.name="Test262Error";this.message=String(message||"");}',
  'var assert={',
  'sameValue:function(actual,expected){__scalarAssertCount++;',
  'if(!Object.is(actual,expected))throw new Test262Error("sameValue mismatch");},',
  'notSameValue:function(actual,expected){__scalarAssertCount++;',
  'if(Object.is(actual,expected))throw new Test262Error("notSameValue mismatch");}',
  '};'
 ].join('\n');
 try{
  const context=createContext({},{codeGeneration:{strings:false,wasm:false}});
  runInContext(prefix,context,{timeout:timeoutMs});
  runInContext(source,context,{timeout:timeoutMs});
  const n=runInContext('__scalarAssertCount',context,{timeout:timeoutMs});
  if(!Number.isSafeInteger(n)||n<1)return {status:'unsupported',reason:'No supported scalar assertions'};
  return {status:'passed',assertionCount:n,
    reference:'independent-V8-scalar-assertion-subset/1'};
 }catch(e){
  return {status:'unsupported',reason:'V8 reference or assertion mismatch: '+
    String(e?.message??e).slice(0,220)};
 }
}
