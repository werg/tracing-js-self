// Opt-in native-V8 Test262 reference execution for pinned, trusted local sources.
// This is diagnostic evidence only. node:vm is NOT a security boundary, and
// neither native-V8 success nor assertion success is an owned semantic trace.
import {Script,createContext,runInContext} from 'node:vm';

const safeInclude=name=>/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(name)&&!name.includes('..');
const errorName=e=>String(e?.name??typeof e).slice(0,100);
const response=(status,reason,extra={})=>({schema:'test262-native-reference/1',
  authority:'native-v8-diagnostic-only',verifiedOwned:false,admitted:false,
  status,reason,...extra});

/**
 * Run one exact Test262 script variant using real pinned harness source bytes.
 * Callers must establish upstream provenance and supply the harness files;
 * this API intentionally does not read arbitrary paths or fetch dependencies.
 * Unsupported goals/early errors/async completions are explicitly refused.
 */
export function executeTest262Reference({source,metadata,mode='sloppy',
  harnessSources={},filename='test262.js',timeoutMs=300}={}){
  if(typeof source!=='string'||!metadata||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>1000)
    throw new TypeError('Invalid Test262 reference arguments');
  const flags=metadata.flags,includes=metadata.includes;
  if(metadata.metadataStatus!=='parsed'||!Array.isArray(flags)||
     !Array.isArray(includes)||!Array.isArray(metadata.features))
    return response('unsupported','Unparsed or incomplete Test262 metadata');
  if(!['sloppy','strict'].includes(mode)||flags.includes('module')||
     flags.includes('raw')||flags.includes('async')||flags.includes('CanBlockIsFalse')||
     flags.includes('CanBlockIsTrue')||flags.includes('non-deterministic')||
     flags.some(f=>!['onlyStrict','noStrict'].includes(f))||
     flags.includes('onlyStrict')&&mode!=='strict'||
     flags.includes('noStrict')&&mode!=='sloppy')
    return response('unsupported','Mode, completion or Test262 flags require another reference adapter');
  const negative=metadata.negative;
  if(negative&&(!['parse','runtime','early','resolution'].includes(negative.phase)||
     !/^[A-Za-z_$][\w$]*$/.test(negative.type)))
    return response('unsupported','Invalid negative-phase metadata');
  if(negative&&['early','resolution'].includes(negative.phase))
    return response('unsupported','V8 Script cannot certify the declared early/resolution phase');
  const code=(mode==='strict'?'"use strict";\n':'')+source;
  let script;
  try{script=new Script(code,{filename,displayErrors:false});}
  catch(error){
    if(negative?.phase==='parse'&&error instanceof SyntaxError&&
       negative.type==='SyntaxError')
      return response('passed','Expected parse-time SyntaxError observed',
        {mode,phase:'parse',errorType:'SyntaxError'});
    return response('failed','Unexpected parse-time '+errorName(error),
      {mode,phase:'parse',errorType:errorName(error)});
  }
  if(negative?.phase==='parse')return response('failed','Expected a parse-time error but parsing succeeded',
    {mode,phase:'parse'});
  const names=[...new Set(['sta.js','assert.js',...includes])];
  if(names.some(name=>!safeInclude(name)||typeof harnessSources[name]!=='string'))
    return response('unsupported','Missing or unsafe pinned harness include');
  const context=createContext(Object.create(null),{
    codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'
  });
  try{
    for(const name of names){
      const harness=new Script(harnessSources[name],{filename:'harness/'+name});
      harness.runInContext(context,{timeout:timeoutMs,displayErrors:false});
    }
  }catch(error){return response('unsupported','Harness failed to initialize: '+errorName(error),
    {mode,phase:'harness'});}
  // Resolve the original error constructor before executing the guest; a
  // thrown plain object with a forged name must not satisfy a negative test.
  let expectedConstructor=null;
  if(negative?.phase==='runtime'){
    expectedConstructor=runInContext('globalThis['+JSON.stringify(negative.type)+']',
      context,{timeout:timeoutMs});
    if(typeof expectedConstructor!=='function')
      return response('unsupported','Declared negative error constructor unavailable');
  }
  try{
    script.runInContext(context,{timeout:timeoutMs,displayErrors:false});
    if(negative)return response('failed','Expected a runtime error but execution completed',
      {mode,phase:'runtime'});
    return response('passed','Completed without an uncaught exception',
      {mode,phase:'runtime',harness:names});
  }catch(error){
    const type=errorName(error);
    if(negative&&error!==null&&(typeof error==='object'||typeof error==='function')&&
       error instanceof expectedConstructor)
      return response('passed','Expected runtime error constructor observed',
        {mode,phase:'runtime',errorType:negative.type,harness:names});
    return response('failed','Unexpected runtime '+type,
      {mode,phase:'runtime',errorType:type,harness:names});
  }
}
