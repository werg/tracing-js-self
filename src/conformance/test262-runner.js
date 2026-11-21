// Original-source Test262 script execution. This runner does not substitute
// assertion implementations or run guest source through a native evaluator.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {parse as parseSyntax} from 'acorn';
import {createRuntime} from '../runtime.js';
import {linkEvaluatedModules} from '../evaluated-modules.js';
import {unresolvedOriginalModuleBindings} from './test262-module-resolution.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {conformanceDigest,parseTest262Header,test262VariantModes} from './test262-catalog.js';
import {test262HostCapabilities,unsupportedOwnedGlobals,
  unavailableOwnedStandardGlobal,requiresScriptGlobalThis} from './test262-capabilities.js';

export const OWNED_TEST262_RUNNER='owned-test262-original/1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const decode=bytes=>typeof bytes==='string'?bytes:
  bytes instanceof Uint8Array?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes):null;
const equivalent=(a,b)=>conformanceDigest(a)===conformanceDigest(b);
const outcome=(status,reason,extra={})=>({status,reason,...extra});
const errorKinds=new Set(['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError']);

export function test262VariantSource(source,mode){
  if(mode!=='strict')return source;
  const directive='"use strict";\n';
  // Hashbang comments are only recognized at the start of a Script. Keep the
  // original bytes in place and add the strict directive after that line.
  if(source.startsWith('#!')){
    const end=source.search(/[\r\n\u2028\u2029]/);
    if(end<0)return source+'\n'+directive;
    const lineEnding=source[end]==='\r'&&source[end+1]==='\n'?'\r\n':source[end];
    const breakEnd=end+lineEnding.length;
    return source.slice(0,breakEnd)+'"use strict";'+lineEnding+source.slice(breakEnd);
  }
  return directive+source;
}

export function ownedTest262Profile({specification=null,maxSteps=20000,maxSourceBytes=1048576,
  referenceTimeoutMs=300}={}){
  if(!Number.isSafeInteger(referenceTimeoutMs)||referenceTimeoutMs<10||referenceTimeoutMs>1000)
    throw new TypeError('Reference timeout must be between 10 and 1000 ms');
  if(!Number.isSafeInteger(maxSteps)||maxSteps<1||!Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1)
    throw new TypeError('Owned Test262 resource limits must be positive integers');
  return {name:OWNED_TEST262_RUNNER,edition:'ECMAScript 2026',specification,
    parser:{name:'acorn',version:'8.15.0',ecmaVersion:2026,lowering:'owned-script/1',
      implementationDigest:conformanceDigest(['../training/profile.js','../frontend.js'].map(path=>
        [path,sha(readFileSync(new URL(path,import.meta.url)))]))},
    hostProfile:{name:'single-agent-owned-test262/1',harness:'original-test262-files',
      completion:'original-doneprintHandle-and-owned-print',realms:'fresh-per-variant',
      moduleResolver:'frozen-static-relative-graph/1',
      moduleExecution:{profile:'evaluated-module/1',entry:'evaluation-only',
        sourceHandling:'original-bytes-bound-and-lowered-to-owned-entry',
        staticResolution:'original-module-records/1',
        generatedAndOriginalDigests:'both-recorded',sourceCorrespondence:false,
        dynamicImport:'unsupported',moduleNamespaceObjects:'unsupported',importMeta:'unsupported',
        importAttributes:'unsupported',hostLoading:'unavailable',retainedSession:false},
      test262HostObject:'unavailable',
      reference:{node:process.version,v8:process.versions.v8,timeoutMs:referenceTimeoutMs}},
    resourcePolicy:{maxSteps,maxSourceBytes},
    limits:[specification?'Test262 edition membership remains unclassified although the normative specification bytes are pinned.':
      'Edition membership is unclassified until the normative specification inventory is pinned.',
      'Owned modules use the bounded evaluated-module/1 lowering recorded in the runner profile; dynamic import, namespace exotics, import.meta, import attributes, host loading, retained sessions and source correspondence remain unqualified.',
      'Owned structural validation and exact replay do not establish public or native semantic admission.']};
}

/** Check the complete frozen variant identity and every supplied execution byte. */
export function prepareOfficialTest262Variant({variant,profile,suiteRevision,sources}={}){
  if(profile?.name!==OWNED_TEST262_RUNNER||!variant||!sources)
    throw new TypeError('Original Test262 runner requires its explicitly bound profile and sources');
  const {id,...identity}=variant;
  if(conformanceDigest({suiteRevision,profile,...identity})!==id)
    throw new TypeError('Test262 variant identity does not match the runner profile');
  if(variant.metadataError||!variant.metadata||!test262VariantModes(variant.metadata).includes(variant.mode))
    throw new TypeError('Unresolved Test262 routing metadata');
  const sourceBytes=sources[variant.path],source=decode(sourceBytes);
  if(source===null||sha(sourceBytes)!==variant.sourceDigest)
    throw new TypeError('Original Test262 source bytes do not match the frozen variant');
  if(!equivalent(parseTest262Header(source),variant.metadata))
    throw new TypeError('Test262 metadata differs from the original source');
  const expectedHarness=variant.metadata.flags.includes('raw')?[]:[...new Set(['assert.js','sta.js',
    ...(variant.metadata.flags.includes('async')?['doneprintHandle.js']:[]),...variant.metadata.includes])];
  if(!equivalent(variant.harness.map(file=>file.path),expectedHarness.map(name=>'harness/'+name)))
    throw new TypeError('Frozen Test262 harness order differs from metadata');
  const harness=[];
  for(const file of variant.harness){
    const bytes=sources[file.path],text=decode(bytes);
    if(file.sha256===null||text===null)return {missingHarness:file.path,source,sourceBytes};
    if(sha(bytes)!==file.sha256)throw new TypeError('Original Test262 harness bytes changed: '+file.path);
    harness.push({path:file.path,text,digest:file.sha256});
  }
  return {source,sourceBytes,harness,
    code:test262VariantSource(source,variant.mode)};
}

/** Missing optional host facilities must not look like guest ReferenceErrors. */
export function requiredOriginalHostCapabilities(ast,variant){
  const required=new Set();
  for(const flag of variant.metadata.flags)
    if(['CanBlockIsTrue','CanBlockIsFalse','non-deterministic'].includes(flag))required.add('host-flag:'+flag);
  for(const capability of test262HostCapabilities(ast))required.add(capability);
  return [...required].sort();
}

export function checkOfficialTest262Syntax(prepared,variant){
  const negative=variant.metadata.negative;
  if(negative?.phase==='early')return {stage:outcome('unsupported',
    'The integrated parser cannot independently certify a distinct early-error phase'),ast:null,parseOnly:true};
  let ast;
  try{ast=parseSyntax(prepared.code,{ecmaVersion:2026,sourceType:variant.mode==='module'?'module':'script',
    allowAwaitOutsideFunction:false,allowReturnOutsideFunction:false});}
  catch(error){
    if(error instanceof SyntaxError)return {stage:outcome(
      negative?.phase==='parse'&&negative.type==='SyntaxError'?'passed':'failed',
      negative?.phase==='parse'&&negative.type==='SyntaxError'?'Expected parser SyntaxError observed':
        'Unexpected parser SyntaxError: '+error.message,{phase:'parse',errorType:'SyntaxError'}),ast:null,parseOnly:true};
    return {stage:outcome('infrastructure_error',error.message,{phase:'parse'}),ast:null,parseOnly:true};
  }
  if(negative?.phase==='parse')return {stage:outcome('failed',
    'Expected a parse-time '+negative.type+' but original source parsed successfully',{phase:'parse'}),ast,parseOnly:true};
  return {stage:outcome('passed','Original source parsed in its declared goal and variant',{phase:'parse'}),ast,parseOnly:false};
}

/** Parse and link the catalog-bound ESM graph without executing guest code.
 * This is an owned preflight: Node's module loader and native evaluation are
 * never used here. The complete dependency closure is already bound by the
 * frozen catalog, so a missing edge has the same resolution phase as ESM. */
export function checkOfficialTest262ModuleGraph({variant,profile,sources}={}){
  if(variant?.mode!=='module'||!profile||!sources)
    throw new TypeError('Module preflight requires a bound module variant and sources');
  const files=variant.dependencies?.files;
  const unresolvedClosure=variant.dependencies?.status!=='complete';
  if(variant.metadata.negative?.phase==='early')
    return {stage:outcome('unsupported',
      'The integrated parser cannot independently certify a distinct module early-error phase',
      {phase:'early'}),parseOnly:true};
  if(!Array.isArray(files))
    return {stage:outcome('environment_unavailable','Pinned module dependency closure is incomplete',
      {phase:'module-input',unresolved:variant.dependencies?.unresolved??[]}),parseOnly:true};
  const graph=new Map();
  for(const file of files){
    const bytes=sources[file.path],text=decode(bytes);
    if(text===null)return {stage:outcome('environment_unavailable','Missing pinned module source: '+file.path,
      {phase:'module-input'}),parseOnly:true};
    if(sha(bytes)!==file.sha256)return {stage:outcome('infrastructure_error',
      'Pinned module source bytes changed: '+file.path,{phase:'module-input'}),parseOnly:true};
    if(Buffer.byteLength(text)>profile.resourcePolicy.maxSourceBytes)
      return {stage:outcome('resource_limited','Pinned module source exceeds the byte budget',
        {phase:'module-input'}),parseOnly:true};
    graph.set(file.path,text);
  }
  if(!graph.has(variant.path)||sha(sources[variant.path])!==variant.sourceDigest)
    return {stage:outcome('infrastructure_error','Pinned module graph omits or changes its entry source',
      {phase:'module-input'}),parseOnly:true};
  const parsed=new Map(),missing=[];
  const pending=[variant.path],queued=new Set(pending);
  while(pending.length){
    const path=pending.shift(),text=graph.get(path);
    let ast;
    try{ast=parseSyntax(text,{ecmaVersion:2026,sourceType:'module',allowHashBang:true,
      allowAwaitOutsideFunction:true,allowReturnOutsideFunction:false});parsed.set(path,ast);}
    catch(error){
      if(!(error instanceof SyntaxError))return {stage:outcome('infrastructure_error',
        'Owned module parser infrastructure threw: '+error.message,{phase:'parse',errorType:null,
          sourcePath:path}),ast:null,parseOnly:true};
      const expected=path===variant.path&&variant.metadata.negative?.phase==='parse'&&
        variant.metadata.negative.type==='SyntaxError'&&error instanceof SyntaxError;
      return {stage:outcome(expected?'passed':'failed',expected?'Expected module parse SyntaxError observed':
        path===variant.path?'Unexpected original module parse error':'Pinned dependency module did not parse',
        {phase:'parse',errorType:'SyntaxError',sourcePath:path}),ast:null,parseOnly:true};
    }
    if(path===variant.path&&variant.metadata.negative?.phase==='parse')
      return {stage:outcome('failed','Expected a module parse-time error but original source parsed successfully',
        {phase:'parse'}),ast,parseOnly:true};
    // Only static imports/re-exports instantiate module records. A literal
    // dynamic-import target in the catalog may intentionally be script-invalid
    // as a module; its own import evaluation decides that at runtime.
    for(const node of ast.body){
      if(!['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)||
         node.type!=='ExportAllDeclaration'&&!node.source)continue;
      const specifier=node.source?.value;
      if(typeof specifier!=='string')continue;
      if(!specifier.startsWith('./')&&!specifier.startsWith('../')){
        missing.push({from:path,target:specifier,kind:'module'});continue;
      }
      const target=posix.normalize(posix.join(posix.dirname(path),specifier));
      // These bytes are not necessarily ECMAScript source. Without the
      // declared host loader, interpreting JSON/text as JS could fabricate
      // a missing export or dependency SyntaxError and pass a negative test.
      const capability=node.attributes?.length?'module-import-attributes':
        !target.endsWith('.js')?'non-javascript-module-loader':null;
      if(capability)return {stage:outcome('environment_unavailable',
        'Owned module profile has no declared loader for this request: '+target,
        {phase:'environment',sourcePath:path,targetPath:target,missingCapabilities:[capability]}),
        ast:parsed.get(variant.path),parseOnly:true};
      if(!graph.has(target))missing.push({from:path,target,kind:'module'});
      else if(!queued.has(target)){queued.add(target);pending.push(target);}
    }
  }
  missing.push(...unresolvedOriginalModuleBindings(parsed));
  if(unresolvedClosure&&variant.metadata.negative?.phase==='resolution'&&
     variant.metadata.negative.type==='SyntaxError'){
    // The frozen acquisition has already recorded unresolved source edges.
    // The source-only link preflight below is the independent phase check;
    // it must find at least one unresolved static request before accepting
    // the expected resolution failure.
    if(missing.length)return {stage:outcome('passed','Expected module resolution SyntaxError observed',
      {phase:'resolution',errorType:'SyntaxError',missing}),ast:parsed.get(variant.path),parseOnly:true};
    return {stage:outcome('failed','Catalog closure is incomplete but no unresolved static request was found',
      {phase:'resolution'}),ast:parsed.get(variant.path),parseOnly:true};
  }
  if(missing.length){
    const negative=variant.metadata.negative;
    const expected=negative?.phase==='resolution'&&negative.type==='SyntaxError';
    return {stage:outcome(expected?'passed':'failed',expected?'Expected module resolution SyntaxError observed':
      'Original module graph has unresolved static requests',{phase:'resolution',errorType:'SyntaxError',missing}),
      ast:parsed.get(variant.path),parseOnly:true};
  }
  if(variant.metadata.negative?.phase==='resolution')
    return {stage:outcome('failed','Expected a module resolution error but the pinned graph linked',
      {phase:'resolution'}),ast:parsed.get(variant.path),parseOnly:true};
  return {stage:outcome('passed','Original module graph parsed and all static requests resolved',
    {phase:'link'}),ast:parsed.get(variant.path),moduleAsts:[...parsed.values()],parseOnly:false};
}

function actualErrorType(bundle,completion){
  const value=completion?.value?.value;
  if(value?.[0]!=='ref')return null;
  const object=bundle.finalState.heap[value[1]];
  // This is an owned internal classification; a guest property named `name`
  // or `constructor` cannot manufacture it.
  if(errorKinds.has(object?.declaredError))return object.declaredError;
  const globalId=bundle.finalState.control.a0.scriptSequence?.environmentId??
    bundle.finalState.control.a0.globalEnvId;
  const constructor=bundle.finalState.envs[globalId]?.bindings?.Test262Error?.token?.value;
  const expectedPrototype=constructor?.[0]==='ref'?
    bundle.finalState.heap[constructor[1]]?.properties?.prototype?.value:null;
  if(expectedPrototype?.[0]==='ref'){
    let prototype=object?.prototype,steps=0;
    while(prototype&&steps++<64){
      if(prototype===expectedPrototype[1])return 'Test262Error';
      prototype=bundle.finalState.heap[prototype]?.prototype;
    }
  }
  return null;
}
function asyncCompletion(bundle,variant){
  const output=bundle.finalState.control.a0.test262Output??[];
  const completions=output.filter(item=>item.value?.[0]==='str'&&item.value[1]==='Test262:AsyncTestComplete');
  const failures=output.filter(item=>item.value?.[0]==='str'&&item.value[1].startsWith('Test262:AsyncTestFailure:'));
  const doneSource=bundle.sources.find(source=>source.url==='harness/doneprintHandle.js');
  const definition=doneSource&&bundle.programs[doneSource.entry].instructions.find(inst=>inst.op==='DEF_FN'&&inst.arg.name==='$DONE');
  const calls=definition?Object.values(bundle.finalState.frames).filter(frame=>frame.codeId===definition.arg.codeId).length:null;
  if(failures.length)return outcome('failed','Original async harness reported failure',
    {completionCalls:calls,completionPrints:completions.length,failurePrints:failures.length});
  if(completions.length>1||calls!==null&&calls>1)return outcome('failed','Async completion occurred more than once',
    {completionCalls:calls,completionPrints:completions.length});
  if(completions.length!==1||!variant.metadata.flags.includes('raw')&&calls!==1)
    return outcome('resource_limited','No original async completion before the bounded owned turn became quiescent',
      {completionCalls:calls,completionPrints:completions.length});
  return outcome('passed','Original async completion protocol completed exactly once',
    {completionCalls:calls,completionPrints:1});
}
function executeOwnedTest262Module({options,prepared,profile,result,includeBundle=false}){
  const {variant,sources}=options;
  const modules={};
  for(const file of variant.dependencies.files){
    const text=decode(sources[file.path]);
    if(text===null)return {status:'environment_unavailable',reason:'Missing pinned module source: '+file.path,
      phase:'module-input'};
    modules[file.path]=text;
  }
  let linked;
  try{linked=linkEvaluatedModules({modules,entryModule:variant.path,evaluateOnly:true});}
  catch(error){
    // The module frontend and its generator are a bounded edition profile.
    // A parser rejection at this boundary is an honest feature refusal; it
    // does not invalidate the earlier original-source parse observation.
    const status=error instanceof SyntaxError||profileRefusal(error)?'unsupported':'infrastructure_error';
    return {status,reason:error.message,phase:'owned-link'};
  }
  const runtime=createRuntime({maxSteps:profile.resourcePolicy.maxSteps});
  let executionSource,invocationSource;
  try{
    const entries=[...prepared.harness.map(file=>runtime.registerSource({text:file.text,url:file.path,scriptProfile:true}))];
    executionSource=runtime.registerSource({text:linked.source,
      url:'owned-test262-module://'+variant.path,scriptProfile:true});
    invocationSource=runtime.registerSource({text:'__traced_eval_entry({args:[]});',
      url:'test262-module-invocation.js',scriptProfile:true});
    entries.push(executionSource,invocationSource);
    runtime.startScriptSequence(entries);result.executionPerformed=true;
  }catch(error){
    const status=profileRefusal(error)?'unsupported':'infrastructure_error';
    return {status,reason:error.message,phase:'owned-module-compile'};
  }
  let exit,bundle;
  try{
    exit=runtime.drive();bundle=runtime.exportRun();validateBundle(bundle);replayExact(bundle);
  }catch(error){
    const status=/Driver safety limit|budget exceeded/i.test(error.message)?'resource_limited':
      profileRefusal(error)?'unsupported':'infrastructure_error';
    return {status,reason:error.message,phase:'owned-module-runtime'};
  }
  const entryDefinition=runtime.programs[executionSource.entry].instructions.find(instruction=>
    instruction.op==='DEF_FN'&&instruction.arg.name==='__traced_eval_entry');
  const moduleFrame=entryDefinition&&Object.values(runtime.state.frames).find(frame=>
    frame.codeId===entryDefinition.arg.codeId&&frame.asyncPromiseId);
  const promiseId=moduleFrame?.asyncPromiseId??null;
  const promise=promiseId?runtime.state.promises[promiseId]:null;
  const scriptSequence=runtime.state.control.a0.scriptSequence;
  const harnessEntered=!scriptSequence||scriptSequence.nextIndex>=prepared.harness.length+1;
  const trace={structurallyValidated:true,exactlyReplayed:true,eventCount:bundle.events.length,
    sourceCount:bundle.sources.length,bundleDigest:sha(JSON.stringify(bundle)),
    bundleDigestFormat:'compact-json-sha256/1',sourceDigests:bundle.sources.map(source=>({
      path:source.url,sha256:sha(source.text)})),
    moduleLoweringProfile:linked.profile,
    generatedExecutionSource:{url:'owned-test262-module://'+variant.path,sha256:sha(linked.source)},
    originalModuleSourceDigests:variant.dependencies.files.map(file=>({path:file.path,sha256:file.sha256})),
    moduleGraph:linked.metadata};
  if(exit.kind==='unsupported')return {status:'unsupported',reason:'Owned module machine refused an unimplemented operation',
    phase:'owned-module-runtime',trace,bundle:includeBundle?bundle:undefined};
  if(exit.kind==='runtime.failure'){
    const type=actualErrorType(bundle,exit.failure?.completion);
    const negative=variant.metadata.negative;
    if(!harnessEntered)return {status:'failed',reason:'Original module harness threw before module evaluation',
      phase:'harness',errorType:type,trace};
    return {status:negative?.phase==='runtime'&&negative.type===type?'passed':'failed',
      reason:negative?.phase==='runtime'&&negative.type===type?'Expected owned module runtime error observed':
        'Unexpected owned module guest throw',phase:'runtime',errorType:type,trace};
  }
  const negative=variant.metadata.negative;
  if(promise?.status==='rejected'){
    const rejectedType=promise.value?.value?.[0]==='ref'?
      actualErrorType(bundle,{value:promise.value}):null;
    const passed=negative?.phase==='runtime'&&negative.type===rejectedType;
    return {status:passed?'passed':'failed',reason:passed?'Expected owned module rejection observed':
      'Owned module evaluation rejected',phase:'runtime',errorType:rejectedType,trace,
      ...(includeBundle?{bundle}:{})};
  }
  if(!promise||promise.status==='pending')
    return {status:'resource_limited',reason:'Owned module evaluation did not settle before the bounded runtime quiesced',
      phase:'runtime',trace,...(includeBundle?{bundle}:{})};
  if(negative)return {status:'failed',reason:'Expected a module runtime error but original source completed',
    phase:'runtime',trace};
  const asyncResult=variant.metadata.flags.includes('async')?asyncCompletion(bundle,variant):null;
  const observed=asyncResult??outcome('passed','Original module graph and original assertions completed',
    {phase:'runtime'});
  return {...observed,trace,moduleGraphComplete:true,...(includeBundle?{bundle}:{})};
}
const profileRefusal=error=>error?.name==='SyntaxError'&&/^Unsupported owned-script\/1 /.test(error.message)||
  /(?:outside (?:the )?.*profile|\b(?:Unsupported|Unmodeled)\b|not (?:modeled|implemented)|requires? (?:an? )?owned|needs? (?:an? )?owned|bounded (?:error|object|array|function|iterator) profile|Declared error exposes)/i.test(error?.message??'');

/** Run one immutable variant; a new machine is always allocated for it. */
export function executeOfficialTest262Variant(options={}){
  const {variant,profile,includeBundle=false}=options;
  const result={schema:'owned-test262-variant-result/1',runner:OWNED_TEST262_RUNNER,
    caseId:variant?.id??null,path:variant?.path??null,mode:variant?.mode??null,
    executionPerformed:false,stages:{},claims:{fullEditionConformance:false,publicSemanticReplay:false,
      nativeReplay:false,admitted:false}};
  const finish=(status,reason,extra={})=>({...result,status,reason,...extra});
  let prepared;
  try{prepared=prepareOfficialTest262Variant(options);}
  catch(error){
    result.stages.parseStatic=outcome('infrastructure_error',error.message);
    return finish('infrastructure_error',error.message,{phase:'input'});
  }
  const maximum=profile.resourcePolicy.maxSourceBytes;
  if(Buffer.byteLength(prepared.source)>maximum||prepared.harness?.some(file=>Buffer.byteLength(file.text)>maximum)){
    result.stages.parseStatic=outcome('resource_limited','Source exceeds the pinned byte budget');
    return finish('resource_limited','Source exceeds the pinned byte budget',{phase:'input'});
  }
  // Syntax is checked before harness availability: parse-negative tests must
  // never execute their $DONOTEVALUATE body or any harness code.
  prepared.code??=test262VariantSource(prepared.source,variant.mode);
  const syntax=variant.mode==='module'?checkOfficialTest262ModuleGraph(options):
    checkOfficialTest262Syntax(prepared,variant);
  result.stages.parseStatic=syntax.stage;
  if(syntax.parseOnly)return finish(syntax.stage.status,syntax.stage.reason,
    {phase:syntax.stage.phase??'parse',parseOnly:true});
  if(variant.mode==='module'){
    const asts=syntax.moduleAsts??[syntax.ast];
    const missing=[...new Set(asts.flatMap(ast=>requiredOriginalHostCapabilities(ast,variant)))];
    if(prepared.missingHarness)missing.push(prepared.missingHarness);
    if(missing.length){
      result.stages.ownedExecution=outcome('environment_unavailable',
        'Unavailable original Test262 capabilities: '+[...new Set(missing)].join(', '));
      return finish('environment_unavailable',result.stages.ownedExecution.reason,
        {phase:'environment',missingCapabilities:[...new Set(missing)]});
    }
    const unsupported=[...new Set(asts.flatMap(ast=>unsupportedOwnedGlobals(ast)))];
    if(unsupported.length){
      result.stages.ownedExecution=outcome('unsupported','Unimplemented standard globals: '+unsupported.join(', '));
      return finish('unsupported',result.stages.ownedExecution.reason,{phase:'owned-capabilities'});
    }
    const observed=executeOwnedTest262Module({options,prepared,profile,result,includeBundle});
    result.stages.ownedExecution=observed;
    const {status:observedStatus,reason:observedReason,trace:observedTrace,bundle:observedBundle,...details}=observed;
    return finish(observedStatus,observedReason,{...details,phase:observed.phase??'module-evaluation',
      ...(observedTrace?{trace:observedTrace}:{}),...(observed.moduleGraphComplete?{moduleGraphComplete:true}:{}),
      ...(observedBundle?{bundle:observedBundle}:{})});
  }
  const missing=requiredOriginalHostCapabilities(syntax.ast,variant);
  if(prepared.missingHarness)missing.push(prepared.missingHarness);
  if(missing.length){
    result.stages.ownedExecution=outcome('environment_unavailable','Unavailable original Test262 capabilities: '+missing.join(', '));
    return finish('environment_unavailable',result.stages.ownedExecution.reason,{phase:'environment',missingCapabilities:missing});
  }
  const unsupported=unsupportedOwnedGlobals(syntax.ast);
  if(requiresScriptGlobalThis(syntax.ast))unsupported.push('global script receiver');
  if(unsupported.length){
    result.stages.ownedExecution=outcome('unsupported','Unimplemented standard globals: '+unsupported.join(', '));
    return finish('unsupported',result.stages.ownedExecution.reason,{phase:'owned-capabilities'});
  }
  const runtime=createRuntime({maxSteps:profile.resourcePolicy.maxSteps});
  let sources;
  try{
    sources=[...prepared.harness.map(file=>runtime.registerSource({text:file.text,url:file.path,scriptProfile:true})),
      runtime.registerSource({text:prepared.code,url:variant.path,scriptProfile:true})];
  }catch(error){
    const status=profileRefusal(error)?'unsupported':'infrastructure_error';
    result.stages.ownedExecution=outcome(status,error.message);
    return finish(status,error.message,{phase:'owned-compile'});
  }
  let exit;
  try{
    runtime.startScriptSequence(sources);result.executionPerformed=true;
    exit=runtime.drive();
  }catch(error){
    const status=/Driver safety limit|budget exceeded/i.test(error.message)?'resource_limited':
      profileRefusal(error)?'unsupported':'infrastructure_error';
    result.stages.ownedExecution=outcome(status,error.message);
    return finish(status,error.message,{phase:'owned-runtime'});
  }
  let bundle;
  try{bundle=runtime.exportRun();validateBundle(bundle);replayExact(bundle);}
  catch(error){
    result.stages.ownedExecution=outcome('infrastructure_error',error.message);
    return finish('infrastructure_error',error.message,{phase:'verification'});
  }
  const trace={structurallyValidated:true,exactlyReplayed:true,eventCount:bundle.events.length,
    sourceCount:bundle.sources.length,bundleDigest:sha(JSON.stringify(bundle)),bundleDigestFormat:'compact-json-sha256/1',
    sourceDigests:bundle.sources.map(source=>({path:source.url,sha256:sha(source.text)}))};
  const negative=variant.metadata.negative;
  let observed;
  if(exit.kind==='unsupported')observed=outcome('unsupported','Owned machine refused an unimplemented semantic operation');
  else if(exit.kind==='runtime.failure'){
    const completion=exit.failure.completion;
    const type=actualErrorType(bundle,exit.failure.completion);
    const missingName=completion.errorType==='ReferenceError'?/^(\w+) is not defined$/.exec(completion.message??'')?.[1]:null;
    observed=bundle.finalState.control.a0.scriptSequence.nextIndex!==sources.length?
      outcome('failed','Original harness threw before the test entered',{phase:'harness',errorType:type}):
      missingName&&unavailableOwnedStandardGlobal(missingName)?
      outcome('unsupported','Unimplemented standard global used by the original harness: '+missingName,{phase:'runtime'}):
      negative?.phase==='runtime'&&type===negative.type?
      outcome('passed','Expected owned runtime error constructor observed',{phase:'runtime',errorType:type}):
      outcome('failed','Unexpected owned guest throw',{phase:'runtime',errorType:type,completion:exit.failure.completion});
  }else if(negative)observed=outcome('failed','Expected a runtime error but original source completed',{phase:'runtime'});
  else if(variant.metadata.flags.includes('async'))observed=asyncCompletion(bundle,variant);
  else if(exit.kind==='waiting'&&(bundle.finalState.control.a0.activeFrameId!==null||exit.pendingEffects.length))
    observed=outcome('environment_unavailable','Original script is waiting for unavailable external progress');
  else observed=outcome('passed','Original script and original assertions completed without an uncaught error',{phase:'runtime'});
  result.stages.ownedExecution={...observed,trace};
  return finish(observed.status,observed.reason,{phase:observed.phase??'runtime',trace,
    ...(includeBundle?{bundle}:{}),...(observed.completionCalls!==undefined?{completionCalls:observed.completionCalls}:{})});
}
