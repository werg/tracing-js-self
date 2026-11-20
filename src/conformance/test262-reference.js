// Separate diagnostic authority: original Test262 source and harness in V8.
// No result from this module is an owned-execution or semantic-admission receipt.
import {Script,createContext,runInContext} from 'node:vm';
import {parse as parseSyntax} from 'acorn';
import {prepareOfficialTest262Variant,requiredOriginalHostCapabilities} from './test262-runner.js';

export function executeOfficialTest262Reference(options={}){
  const {variant,profile}=options;
  const base={schema:'original-test262-reference/1',caseId:variant?.id??null,
    authority:'native-v8-reference-only',engine:{node:process.version,v8:process.versions.v8},
    ownedExecution:false,sourceCorrespondence:false,admitted:false,executionPerformed:false};
  const answer=(status,reason,extra={})=>({...base,status,reason,...extra});
  let prepared;
  try{prepared=prepareOfficialTest262Variant(options);}
  catch(error){return answer('infrastructure_error',error.message,{phase:'input'});}
  // Bind the budget to the original inputs, as the owned runner does. The
  // strict-mode prefix is an execution adapter, not additional source bytes.
  // Check before parsing so an oversized parse-negative cannot become a pass.
  if(Buffer.byteLength(prepared.source)>profile.resourcePolicy.maxSourceBytes||
     prepared.harness?.some(file=>Buffer.byteLength(file.text)>profile.resourcePolicy.maxSourceBytes))
    return answer('resource_limited','Source exceeds the pinned byte budget',{phase:'input'});
  const negative=variant.metadata.negative;
  if(variant.mode==='module')return answer('environment_unavailable','Original module reference adapter is not connected',{phase:'environment'});
  if(negative?.phase==='early')return answer('unsupported','V8 Script cannot independently certify a distinct early-error phase',{phase:'parse'});
  const code=(variant.mode==='strict'?'"use strict";\n':'')+prepared.source;
  let script;
  try{script=new Script(code,{filename:variant.path,displayErrors:false});}
  catch(error){
    const expected=negative?.phase==='parse'&&negative.type==='SyntaxError'&&error instanceof SyntaxError;
    return answer(expected?'passed':'failed',expected?'Expected V8 parser SyntaxError observed':
      'Unexpected V8 parser error: '+error.name,{phase:'parse',errorType:error.name});
  }
  if(negative?.phase==='parse')return answer('failed','Expected a parse-time error but original source parsed successfully',{phase:'parse'});
  let ast;
  try{ast=parseSyntax(code,{ecmaVersion:2026,sourceType:'script'});}
  catch{return answer('unsupported','Reference host-capability preflight does not support this grammar',{phase:'environment'});}
  const missing=requiredOriginalHostCapabilities(ast,variant);
  if(prepared.missingHarness)missing.push(prepared.missingHarness);
  if(missing.length)return answer('environment_unavailable','Unavailable reference capabilities: '+missing.join(', '),{phase:'environment'});
  const output=[],timeout=profile.hostProfile.reference.timeoutMs;
  const context=createContext(Object.create(null),{codeGeneration:{strings:true,wasm:false},microtaskMode:'afterEvaluate'});
  Object.defineProperty(context,'print',{value:message=>{
    if(output.length>=10000)throw new RangeError('Reference print budget exceeded');
    output.push(String(message));
  },writable:true,configurable:true});
  const classifyError=(error,phase)=>{
    if(error?.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'||/Reference print budget exceeded/.test(error?.message??''))
      return answer('resource_limited','Reference execution budget exceeded',{phase});
    return null;
  };
  try{
    for(const file of prepared.harness)
      new Script(file.text,{filename:file.path}).runInContext(context,{timeout,displayErrors:false});
  }catch(error){return classifyError(error,'harness')??answer('failed',
    'Original reference harness failed before the test: '+error.name,{phase:'harness',errorType:error.name});}
  // Capture the original realm constructor before test declaration
  // instantiation. A plain thrown object with a forged name cannot satisfy it.
  let expectedConstructor;
  if(negative?.phase==='runtime'){
    expectedConstructor=runInContext('globalThis['+JSON.stringify(negative.type)+']',context,{timeout});
    if(typeof expectedConstructor!=='function')return answer('environment_unavailable',
      'Declared negative constructor is unavailable in the reference realm',{phase:'environment'});
  }
  base.executionPerformed=true;
  try{script.runInContext(context,{timeout,displayErrors:false});}
  catch(error){
    const limited=classifyError(error,'runtime');if(limited)return limited;
    let matches=false;
    if(negative?.phase==='runtime')try{
      matches=error!==null&&typeof error==='object'&&
        error instanceof expectedConstructor&&error.constructor===expectedConstructor;
    }catch{}
    return answer(matches?'passed':'failed',matches?'Expected reference error constructor observed':
      'Unexpected reference guest throw',{phase:'runtime',errorType:matches?negative.type:typeof error?.name==='string'?error.name:null});
  }
  if(negative)return answer('failed','Expected a runtime error but original source completed',{phase:'runtime'});
  if(variant.metadata.flags.includes('async')){
    const completions=output.filter(text=>text==='Test262:AsyncTestComplete');
    const failures=output.filter(text=>text.startsWith('Test262:AsyncTestFailure:'));
    if(failures.length)return answer('failed','Original reference async harness reported failure',
      {phase:'runtime',completionPrints:completions.length,failurePrints:failures.length});
    if(completions.length>1)return answer('failed','Reference async completion occurred more than once',
      {phase:'runtime',completionPrints:completions.length});
    if(completions.length!==1)return answer('resource_limited','No original reference async completion before quiescence',
      {phase:'runtime',completionPrints:0});
  }
  return answer('passed','Original source and original reference assertions completed',
    {phase:'runtime',harness:prepared.harness.map(file=>file.path),printCount:output.length});
}
