// Separate diagnostic authority: original Test262 source and harness in V8.
// No result from this module is an owned-execution or semantic-admission receipt.
import {Script,createContext,runInContext} from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parse as parseSyntax} from 'acorn';
import {prepareOfficialTest262Variant,requiredOriginalHostCapabilities,test262VariantSource} from './test262-runner.js';
import {createTest262ReferenceCompletion} from './test262-reference-completion.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const decode=bytes=>typeof bytes==='string'?bytes:
  bytes instanceof Uint8Array?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes):null;

function runModuleReference(options,prepared,answer){
  const {variant,profile,sources}=options;
  const graphComplete=variant.dependencies?.status==='complete';
  const dependencyFiles=graphComplete?variant.dependencies.files:[{path:variant.path,sha256:variant.sourceDigest}];
  if(!Array.isArray(dependencyFiles)||!dependencyFiles.length)
    return answer('environment_unavailable','Pinned module dependency closure has no files',{phase:'environment'});
  const moduleSources={};
  try{
    for(const file of dependencyFiles){
      if(typeof file.path!=='string'||!file.path.startsWith('test/')||
        file.path.split('/').some(part=>!part||part==='.'||part==='..'))
        throw new TypeError('Unsafe module dependency path');
      const bytes=sources[file.path],text=decode(bytes);
      if(text===null)return answer('environment_unavailable','Missing pinned module source: '+file.path,
        {phase:'environment',missingSource:file.path});
      if(sha(bytes)!==file.sha256)throw new TypeError('Pinned module dependency bytes changed: '+file.path);
      if(Buffer.byteLength(text)>profile.resourcePolicy.maxSourceBytes)
        return answer('resource_limited','Pinned module source exceeds the source byte budget',
          {phase:'input',sourcePath:file.path});
      moduleSources[file.path]=text;
    }
    if(!Object.hasOwn(moduleSources,variant.path))
      throw new TypeError('Pinned module dependency closure omits the entry source');
    if(sha(sources[variant.path])!==variant.sourceDigest)
      throw new TypeError('Module entry bytes differ from the frozen variant');
  }catch(error){return answer('infrastructure_error',error.message,{phase:'module-input'});}

  const child=fileURLToPath(new URL('./test262-module-reference-child.js',import.meta.url));
  const allowedEnv=Object.fromEntries(['PATH','LANG','LC_ALL','TZ']
    .filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  let execution;
  try{
    execution=spawnSync(process.execPath,['--experimental-vm-modules','--max-old-space-size=384',child],{
      input:JSON.stringify({variant,profile,sources:moduleSources,harness:prepared.harness,
        dependenciesComplete:graphComplete,unresolved:variant.dependencies?.unresolved??[]}),
      encoding:'utf8',timeout:profile.hostProfile.reference.timeoutMs+1500,
      maxBuffer:16*1024*1024,env:allowedEnv
    });
  }catch(error){return answer('infrastructure_error','Module reference worker failed: '+error.message,{phase:'worker'});}
  if(execution.error?.code==='ETIMEDOUT')return answer('resource_limited',
    'Isolated module reference worker exceeded its wall-time budget',{phase:'worker'});
  if(execution.error)return answer('environment_unavailable',
    'Isolated module reference worker could not start: '+execution.error.message,{phase:'worker'});
  if(execution.status!==0)return answer('infrastructure_error',
    'Isolated module reference worker did not complete successfully',{phase:'worker',exitCode:execution.status,
      signal:execution.signal,stderr:execution.stderr?.slice(0,8192)??''});
  let result;
  try{result=JSON.parse(execution.stdout.trim());}
  catch{return answer('infrastructure_error','Isolated module reference worker returned invalid output',
    {phase:'worker',stderr:execution.stderr?.slice(0,8192)??''});}
  if(result?.schema!=='test262-module-reference-child/1'||
    !['passed','failed','unsupported','resource_limited','environment_unavailable','infrastructure_error'].includes(result.status))
    return answer('infrastructure_error','Isolated module reference worker returned an unknown disposition',{phase:'worker'});
  return answer(result.status,result.reason,{...result,
    executionPerformed:result.executionPerformed??result.phase==='runtime'});
}

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
  if(negative?.phase==='early')return answer('unsupported','V8 Script cannot independently certify a distinct early-error phase',{phase:'parse'});
  if(variant.mode==='module')return runModuleReference(options,prepared,answer);
  const code=test262VariantSource(prepared.source,variant.mode);
  let script;
  try{script=new Script(code,{filename:variant.path,displayErrors:false});}
  catch(error){
    const expected=negative?.phase==='parse'&&negative.type==='SyntaxError'&&error instanceof SyntaxError;
    return answer(expected?'passed':'failed',expected?'Expected V8 parser SyntaxError observed':
      'Unexpected V8 parser error: '+error.name,{phase:'parse',errorType:error.name});
  }
  if(negative?.phase==='parse')return answer('failed','Expected a parse-time error but original source parsed successfully',{phase:'parse'});
  let ast;
  try{ast=parseSyntax(code,{ecmaVersion:'latest',sourceType:'script'});}
  catch{return answer('unsupported','Reference host-capability preflight does not support this grammar',{phase:'environment'});}
  const missing=requiredOriginalHostCapabilities(ast,variant);
  if(prepared.missingHarness)missing.push(prepared.missingHarness);
  if(missing.length)return answer('environment_unavailable','Unavailable reference capabilities: '+missing.join(', '),
    {phase:'environment',missingCapabilities:missing});
  const completion=createTest262ReferenceCompletion(),output=completion.output,timeout=profile.hostProfile.reference.timeoutMs;
  const context=createContext(Object.create(null),{codeGeneration:{strings:true,wasm:false},microtaskMode:'afterEvaluate'});
  Object.defineProperty(context,'print',{value:message=>{
    if(output.length>=10000)throw new RangeError('Reference print budget exceeded');
    completion.print(String(message));
  },writable:true,configurable:true});
  const classifyError=(error,phase)=>{
    if(error?.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'||/Reference print budget exceeded/.test(error?.message??''))
      return answer('resource_limited','Reference execution budget exceeded',{phase});
    return null;
  };
  try{
    for(const file of prepared.harness){
      new Script(file.text,{filename:file.path}).runInContext(context,{timeout,displayErrors:false});
      if(file.path==='harness/doneprintHandle.js')completion.bind(context);
    }
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
    const {status,reason,...details}=completion.result();
    return answer(status,reason,{phase:'runtime',harness:prepared.harness.map(file=>file.path),
      printCount:output.length,...details});
  }
  return answer('passed','Original source and original reference assertions completed',
    {phase:'runtime',harness:prepared.harness.map(file=>file.path),printCount:output.length});
}
