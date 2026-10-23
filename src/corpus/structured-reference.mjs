// Read-only evidence boundaries for pairing structured test data with real JS APIs.
// Expected conformance labels are not owned traces or training admission.
import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
const hex40=/^[a-f0-9]{40}$/,hex64=/^[a-f0-9]{64}$/;
const relativeFile=p=>typeof p==='string'&&p.length>0&&p.length<300&&
  !p.startsWith('/')&&!p.includes('\\')&&!p.includes('\0')&&
  p.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
export function validateBinding(binding){
 if(binding?.schema!=='structured-corpus-binding/1'||
   !['json-schema-contract','commonmark-contract'].includes(binding.kind)||
   !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.inputRepository??'')||
   !hex40.test(binding.inputRevision??'')||
   !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.implementation?.repository??'')||
   !hex40.test(binding.implementation?.revision??'')||
   !relativeFile(binding.implementation?.file)||
   !hex64.test(binding.implementation?.sha256??'')||
   !/^[A-Za-z_$][\w$]*$/.test(binding.implementation?.entry??'')||
   !/^[A-Za-z0-9+.-]+$/.test(binding.implementation?.license??''))
   throw new TypeError('Invalid pinned structured corpus binding');
 if(binding.kind==='json-schema-contract'&&
   (!Array.isArray(binding.dialects)||binding.dialects.length===0||
    binding.dialects.some(x=>typeof x!=='string'||!/^[a-zA-Z0-9.-]+$/.test(x))))
   throw new TypeError('JSON Schema binding requires explicit supported dialects');
 if(binding.kind==='commonmark-contract'&&binding.dialects!==undefined)
   throw new TypeError('CommonMark does not accept JSON Schema dialects');
 return Object.freeze({...binding,implementation:Object.freeze({...binding.implementation})});
}
export function contractArguments(record,binding){
 if(record?.schema!=='external-corpus-fixture/1'||record.admitted!==false||
   record.verified!==false||!hex64.test(record.id??'')||
   record.program?.kind!==binding.kind||
   record.provenance?.repository!==binding.inputRepository||
   record.provenance?.revision!==binding.inputRevision||
   !hex64.test(record.provenance?.sha256??'')||
   !relativeFile(record.provenance?.path))
   return {status:'unsupported',reason:'Unpinned, malformed or incompatible acquired contract'};
 if(binding.kind==='json-schema-contract'){
   if(!binding.dialects.includes(record.program.draft)||
      record.fixture?.kind!=='schema-validation'||
      !Object.hasOwn(record.fixture,'schema')||
      !Object.hasOwn(record.fixture,'data')||
      record.expected?.kind!=='validity'||
      typeof record.expected.valid!=='boolean')
     return {status:'unsupported',reason:'Unsupported dialect or JSON Schema fixture'};
   return {status:'ready',args:[record.fixture.schema,record.fixture.data],
     expected:record.expected.valid};
 }
 if(record.fixture?.kind!=='markdown-input'||
   typeof record.fixture.markdown!=='string'||
   record.expected?.kind!=='rendered-html'||
   typeof record.expected.html!=='string')
   return {status:'unsupported',reason:'Invalid CommonMark fixture'};
 return {status:'ready',args:[record.fixture.markdown],expected:record.expected.html};
}
export function assessReferenceResult(binding,expected,worker){
 if(worker?.schema!=='structured-reference-worker/1')
   return {status:'failed',reason:'Invalid worker response'};
 if(worker.status!=='returned')
   return {status:'failed',reason:'Original implementation threw or failed: '+
     String(worker.reason??'unknown').slice(0,150)};
 const value=worker.value;
 if(binding.kind==='json-schema-contract'&&typeof value!=='boolean')
   return {status:'unsupported',reason:'Validator did not return a boolean'};
 if(binding.kind==='commonmark-contract'&&typeof value!=='string')
   return {status:'unsupported',reason:'Renderer did not return an HTML string'};
 if(value!==expected)return {status:'failed',reason:'Reference result disagrees with conformance label',
   resultHash:hash(JSON.stringify(value))};
 return {status:'reference-agreed',reason:'Pinned native JS output agrees with test label',
   resultHash:hash(JSON.stringify(value))};
}
export const structuredReferenceWarning=
 'Native JS reference agreement is diagnostic only. Not an owned semantic trace, independent intermediate-operation check, safe execution sandbox or training admission.';
