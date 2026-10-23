// Narrow promotion experiment for already independently checked Test262
// scalar scripts. A body is embedded literally in a strict function-entry
// wrapper; all inserted assertion code is visible as owned guest source.
// This is NOT general Test262 or ESM semantics.
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
export const scalarEntry='__test262OwnedScalarEntry';
export function wrapOwnedScalarTest262(original){
 if(typeof original!=='string'||original.length>1200||
    /(?:\b(?:eval|Function|require|import)\s*\(|\$\d{3}|\$DONE|\bwith\s*\()/u.test(original))
   throw new SyntaxError('Scalar wrapper source outside conservative subset');
 const before=[
  '"use strict";',
  'function '+scalarEntry+'() {',
  '  let __checkCount=0;',
  '  function __same(a,b){',
  '    if(a===b){ if(a===0) return (1/a)===(1/b); return true; }',
  '    return a!==a && b!==b;',
  '  }',
  '  const assert={',
  '    sameValue:(a,b)=>{if(!__same(a,b))throw "sameValue mismatch";__checkCount++;},',
  '    notSameValue:(a,b)=>{if(__same(a,b))throw "notSameValue mismatch";__checkCount++;}',
  '  };',
  '  '
 ].join('\n');
 const after='\n  return __checkCount;\n}\n';
 return {source:before+original+after,entry:scalarEntry,
   mapping:{schema:'test262-literal-body-sites/1',
     originalSha256:sha(original),generatedSha256:sha(before+original+after),
     generatedStart:before.length,generatedEnd:before.length+original.length}};
}
export function runWrappedScalarReference(wrapped,{timeoutMs=300}={}){
 try{
  const output=runInNewContext(wrapped.source+'\n'+wrapped.entry+'();',
    {},{timeout:timeoutMs,contextCodeGeneration:{strings:false,wasm:false}});
  return Number.isSafeInteger(output)&&output>0?
    {status:'passed',assertionCount:output}:
    {status:'unsupported',reason:'No supported wrapper assertions'};
 }catch(error){return {status:'unsupported',reason:String(error?.message??error).slice(0,220)};}
}
export function mapTest262ScalarSites(wrapped,source,semantic){
 const map=wrapped.mapping,entries=[],stats={mapped:0,synthetic:0,unlocated:0};
 if(sha(source)!==map.originalSha256||sha(wrapped.source)!==map.generatedSha256)
   throw new Error('Changed literal Test262 body');
 for(const record of semantic.events){
  const span=record.source;
  if(!span){stats.unlocated++;continue;}
  if(span.start<map.generatedStart||span.end>map.generatedEnd){
   stats.synthetic++;continue;
  }
  const start=span.start-map.generatedStart,end=span.end-map.generatedStart;
  if(source.slice(start,end)!==wrapped.source.slice(span.start,span.end))
   throw new Error('Incorrect scalar source-span receipt');
  entries.push({semantic:record.id,original:{start,end},generated:span});
  stats.mapped++;
 }
 return {schema:'test262-owned-sites/1',stats,entries,valid:true};
}
