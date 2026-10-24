// Owned, replay-verified subset of natlang's evaluator contract.
// Retained modules and live captures admit ordinary data graphs only: native
// functions, package loaders, resources and unowned callbacks are rejected.
import {types} from 'node:util';
import { createRuntime } from './runtime.js';
import {createBoundedModuleFacade} from './evaluated-module-facade.js';
import {lowerPureCommonJsModule} from './natlang-commonjs.js';
import { executeWithNativeServices } from './host/native-driver.js';
import { validateBundle } from './validation.js';
import { replayExact } from './replay.js';
import { realizeGraph } from './training/graph.js';
import { synchronizeLiveGraph } from './natlang-live.js';
import { compileBoundedTypeScript,mapBoundedTypeScriptSites } from './typescript.js';

const event=(mode,body,status,extra={})=>({
  operation:'typescript.eval',authority:'owned-training-js/1',mode,body,
  status,...extra
});

export class BoundedNatlangEnvironment {
  #pureModuleFacades=new Set();
  #pureModuleCache=new WeakMap();
  #runBusy=false;
  constructor({EvalFailure,onTrace=null,maxSteps=10000,mode='fresh',services=null}={}){
    if(typeof EvalFailure!=='function')
      throw new TypeError('Pass the actual natlang EvalFailure constructor for instanceof compatibility');
    if(typeof onTrace!=='function'&&onTrace!==null)
      throw new TypeError('onTrace must be a synchronous function');
    if(!['fresh','retained'].includes(mode))
      throw new TypeError('Invalid natlang environment mode');
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100000)
      throw new RangeError('maxSteps must be between 1 and 100000');
    if(services!==null && (!services||typeof services!=='object'||Array.isArray(services)))
      throw new TypeError('services must be an explicit native operation record');
    this.services=services;
    this.EvalFailure=EvalFailure;
    this.onTrace=onTrace;
    this.maxSteps=maxSteps;
    this.mode=mode;
    this.authority='owned-training-js/1';
    // Natlang's general module loader supplies callable helpers and packages.
    // Do not advertise that integration until those calls are owned.
    this.scopeCapabilities=Object.freeze({allowModules:false,allowNetwork:false});
    this.closed=false;
    this.abortController=new AbortController();
    this.moduleSequence=0;
  }
  fork(){
    this.ensureOpen();
    return new BoundedNatlangEnvironment({
      EvalFailure:this.EvalFailure,onTrace:this.onTrace,maxSteps:this.maxSteps,
      services:this.services,mode:'fresh'
    });
  }
  close(){
    if(this.closed)return;
    this.closed=true;
    this.abortController.abort(new Error('Owned natlang evaluator closed'));
    for(const facade of this.#pureModuleFacades)facade.close();
    this.#pureModuleFacades.clear();
  }
  ensureOpen(){if(this.closed)throw new Error('Owned natlang evaluator is closed');}
  #enterRun(){
    this.ensureOpen();
    if(this.#runBusy)
      throw new Error('Overlapping or reentrant owned natlang execution is not supported');
    this.#runBusy=true;
  }
  #leaveRun(){this.#runBusy=false;}
  declarationOf(){return undefined;}
  failed(request,error,reason='failed'){
    const body=request?.body===true;
    const details={reason,profile:'training-js/1'};
    return new this.EvalFailure(
      error instanceof Error?error.message:String(error),
      [event(this.mode,body,reason,details)],
      {sourceStack:error instanceof Error?error.stack:undefined,logs:[]}
    );
  }
  evaluateModule(code,bindings){
    try{
      this.ensureOpen();
      if(this.#runBusy)
        throw new TypeError('Overlapping or reentrant owned natlang module installation');
      if(this.mode!=='retained')
        throw new TypeError('Module evaluation needs a retained owned environment');
      // Inspect the host boundary through own data descriptors only. Reading
      // bindings.module.exports directly can execute an unowned getter before
      // the guest has been admitted (or enter a Proxy trap).
      if(typeof code!=='string'||!bindings||typeof bindings!=='object'||
         Array.isArray(bindings)||types.isProxy(bindings))
        throw new TypeError('Module evaluation needs plain data bindings');
      const moduleBinding=Object.getOwnPropertyDescriptor(bindings,'module');
      const exportsBinding=Object.getOwnPropertyDescriptor(bindings,'exports');
      if(!moduleBinding||!Object.hasOwn(moduleBinding,'value')||
         !exportsBinding||!Object.hasOwn(exportsBinding,'value')||
         !moduleBinding.value||typeof moduleBinding.value!=='object'||
         types.isProxy(moduleBinding.value))
        throw new TypeError('Module evaluation needs own module and exports data bindings');
      const moduleExports=Object.getOwnPropertyDescriptor(moduleBinding.value,'exports');
      if(!moduleExports||!Object.hasOwn(moduleExports,'value')||
         moduleExports.value!==exportsBinding.value)
        throw new TypeError('Module evaluation needs aliased module.exports and exports data bindings');
      // Pure compiler-emitted CommonJS function registrations are lowered
      // into a bounded owned ESM session. Native helpers remain inaccessible.
      const requireRecord=Object.getOwnPropertyDescriptor(bindings,'require');
      if(requireRecord){
        if(!Object.hasOwn(requireRecord,'value')||
           typeof requireRecord.value!=='function')
          throw new TypeError('CommonJS require must be an uninvoked host function binding');
        return this.evaluatePureCommonJsModule(code,bindings);
      }
      // Owned source is compiled and executed just as an eval body. Imported
      // host callbacks/functions cannot be serialized into this guest realm.
      // A return value from this bounded seam is the final module.exports.
      const request={code:'const exports = self.exports; const module = self.module;\n'+
        code+'\nreturn module.exports;',body:true,scope:bindings,
        path:'natlang://retained-module/'+(++this.moduleSequence)};
      return this.run(request,false,{syncScope:bindings}).result;
    }catch(error){
      if(error instanceof this.EvalFailure)throw error;
      throw this.failed({body:true},error,'unsupported');
    }
  }
  evaluatePureCommonJsModule(code,bindings){
    // Direct JS callers cannot bypass the retained-only module boundary.
    this.ensureOpen();
    if(this.#runBusy)
      throw new TypeError('Overlapping or reentrant owned natlang module installation');
    if(this.mode!=='retained')
      throw new TypeError('Pure CommonJS module installation requires retained mode');
    const {module,exports}=bindings;
    if(types.isProxy(module)||types.isProxy(exports)||
       Object.getPrototypeOf(module)!==Object.prototype||
       Object.getPrototypeOf(exports)!==Object.prototype||
       !Object.isExtensible(exports))
      throw new TypeError('Pure CommonJS exports need ordinary extensible host objects');
    const cached=this.#pureModuleCache.get(module);
    if(cached){
      if(cached.code!==code||cached.exports!==exports)
        throw new TypeError('Retained module identity cannot change source or exports');
      return exports;
    }
    if(Reflect.ownKeys(exports).length!==0)
      throw new TypeError('Owned CommonJS function exports require an empty export record');
    const linked=lowerPureCommonJsModule(code);
    const path='natlang://retained-cjs/'+(++this.moduleSequence);
    const facade=createBoundedModuleFacade({
      modules:{'module.js':linked.source},entryModule:'module.js',
      exportNames:linked.exportNames,maxSteps:this.maxSteps,
      onTrace:(bundle,call,metadata)=>{
        if(!this.onTrace)return;
        this.ensureOpen();
        const callback=this.onTrace(bundle,{
          code,scope:{},body:true,path,
          exportedFunction:call.exportName,invocation:call.callCount
        },{
          compiler:'natlang-commonjs/1',originalText:code,
          javascript:linked.source,sourceMap:null,
          moduleMetadata:metadata
        });
        if(callback&&typeof callback.then==='function')
          throw new TypeError('onTrace must be synchronous; async callbacks are unowned');
      }
    });
    try{
      for(const name of linked.exportNames){
        if(Object.hasOwn(exports,name))
          throw new TypeError('CommonJS export name unexpectedly occupied');
      }
      for(const name of linked.exportNames)
        Object.defineProperty(exports,name,{
          value:(...args)=>{
            let entered=false;
            try{
              this.#enterRun();
              entered=true;
              const result=facade.exports[name](...args);
              this.ensureOpen();
              return result;
            }catch(error){
              if(error instanceof this.EvalFailure)throw error;
              throw this.failed({body:true},error,'unsupported');
            }finally{
              if(entered)this.#leaveRun();
            }
          },
          writable:true,enumerable:true,configurable:true
        });
      this.#pureModuleCache.set(module,{code,exports});
      this.#pureModuleFacades.add(facade);
      return exports;
    }catch(error){facade.close();throw error;}
  }
  execute(request){return this.run(request,false);}
  async executeAsync(request){
    return this.services===null?this.run(request,true):this.runNativeAsync(request);
  }
  async runNativeAsync(request){
    let progress=null,deadlineTimer=null,detachAbort=null,entered=false;
    try{
      this.#enterRun();
      entered=true;
      if(!request||typeof request.code!=='string'||!request.scope||
         typeof request.scope!=='object'||Array.isArray(request.scope)||
         typeof request.body!=='boolean'||typeof request.path!=='string')
        throw new TypeError('Invalid natlang EvalRequest');
      if(request.live!==undefined&&(!request.live||typeof request.live!=='object'||
         Array.isArray(request.live)))
        throw new TypeError('Native guest live bindings must be an ordinary data record');
      // The host owns this deadline. It never appears as a guest timer or
      // guest event; a timed-out run publishes no successful archive.
      if(request.timeoutMs!==undefined &&
         (!Number.isSafeInteger(request.timeoutMs)||request.timeoutMs<1||
          request.timeoutMs>300000))
        throw new RangeError('Native timeoutMs must be an integer from 1 to 300000');
      if(request.code.length>65536)
        throw new RangeError('Natlang source exceeds the bounded adapter limit');
      const body=request.body?request.code:'return ('+request.code+');';
      const originalText='"use strict";\nasync function __natlang_trace_entry(self, __live) {\n'+
        body+'\n}\n';
      const lowering=compileBoundedTypeScript(originalText,{path:request.path});
      let signal=this.abortController.signal;
      if(request.timeoutMs!==undefined){
        const controller=new AbortController();
        const upstream=this.abortController.signal;
        const forward=()=>controller.abort(upstream.reason??
          new Error('Owned natlang environment closed'));
        if(upstream.aborted)forward();
        else upstream.addEventListener('abort',forward,{once:true});
        detachAbort=()=>upstream.removeEventListener('abort',forward);
        deadlineTimer=setTimeout(()=>controller.abort(
          new Error('Owned native service deadline exceeded after '+request.timeoutMs+' ms')),
          request.timeoutMs);
        signal=controller.signal;
      }
      const executed=await executeWithNativeServices({
        entry:{text:lowering.javascript,url:request.path,
          functionName:'__natlang_trace_entry',args:[request.scope,request.live??{}]},
        services:this.services,maxSteps:this.maxSteps,signal
      });
      progress=executed.progress;
      const {runtime,bundle}=executed;
      if(progress.kind!=='terminated')
        throw new TypeError('Owned natlang native-service run did not complete: '+progress.kind);
      // A settled async root is represented by its internal guest promise,
      // not by a host Promise or an opaque callback continuation.
      const root=runtime.initialState.control.a0.activeFrameId;
      const promiseId=runtime.initialState.frames[root]?.asyncPromiseId;
      const settled=promiseId && runtime.state.promises[promiseId];
      if(!settled||settled.status==='pending')
        throw new TypeError('Owned async guest root has not settled');
      if(settled.status==='rejected'){
        const reason=realizeGraph(runtime.state.heap,[settled.value.value])[0];
        throw new Error('Owned guest promise rejected: '+String(
          reason&&typeof reason==='object'?reason.message??reason.name??'guest object':reason));
      }
      const value=settled.value.value;
      let result=realizeGraph(runtime.state.heap,[value])[0];
      const staged=request.live===undefined?null:synchronizeLiveGraph(
        bundle.initialState.heap,runtime.state.heap,
        bundle.entrySpec.arguments[1],request.live,value,{stage:true});
      if(staged)result=staged.result;
      const resultEvent=event(this.mode,request.body,'completed',{
        traceSchema:bundle.manifest.schema,profile:bundle.manifest.profile,
        chunks:bundle.chunks.length,source:request.path,
        transpiler:lowering.compiler,asyncGuest:true,nativeServices:true,
        externalEffects:Object.keys(bundle.effects).length
      });
      if(this.onTrace){
        const callback=this.onTrace(structuredClone(bundle),request,{
          compiler:lowering.compiler,originalText,
          javascript:lowering.javascript,sourceMap:lowering.sourceMap,
          generatedSiteOrigins:mapBoundedTypeScriptSites(lowering,bundle.sites,originalText)
        });
        if(callback&&typeof callback.then==='function')
          throw new TypeError('onTrace must be synchronous; async callbacks are unowned');
      }
      // Closing the realm from onTrace must never publish live host mutations.
      this.ensureOpen();
      staged?.commit();
      const logs=Object.values(bundle.effects)
        .filter(effect=>/^platform\.console\.(log|info|warn|error)$/.test(effect.operation))
        .map(effect=>effect.args[0][1]);
      return {result:result===undefined?null:result,events:[resultEvent],logs};
    }catch(error){
      if(error instanceof this.EvalFailure)throw error;
      throw this.failed(request,error,progress?.kind==='unsupported'?'unsupported':'failed');
    }finally{
      if(deadlineTimer!==null)clearTimeout(deadlineTimer);
      detachAbort?.();
      if(entered)this.#leaveRun();
    }
  }
  run(request,allowAsync,{syncScope=null}={}){
    let progress=null,entered=false;
    try{
      this.#enterRun();
      entered=true;
      if(!request||typeof request.code!=='string'||
         !request.scope||typeof request.scope!=='object'||
         Array.isArray(request.scope)||typeof request.body!=='boolean'||
         typeof request.path!=='string')
        throw new TypeError('Invalid natlang EvalRequest');
      if(request.live!==undefined && (!request.live||typeof request.live!=='object'||
         Array.isArray(request.live)))
        throw new TypeError('Live natlang bindings must be a data-object record');
      if(request.timeoutMs!==undefined)
        throw new TypeError('Native timeouts are not available; use an owned maxSteps budget');
      if(request.code.length>65536)
        throw new RangeError('Natlang source exceeds the bounded adapter limit');
      const body=request.body?request.code:'return ('+request.code+');';
      const originalText='"use strict";\n'+(allowAsync?'async ':'')+
        'function __natlang_trace_entry(self, __live) {\n'+body+'\n}\n';
      const lowering=compileBoundedTypeScript(originalText,{path:request.path});
      const runtime=createRuntime({maxSteps:this.maxSteps});
      const source=runtime.registerSource({
        text:lowering.javascript,url:request.path,trainingProfile:true
      });
      runtime.startEntry({source,functionName:'__natlang_trace_entry',
        args:[request.scope,request.live??{}],allowAsync});
      progress=runtime.drive();
      const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
      validateBundle(bundle);
      replayExact(bundle);
      if(progress.kind!=='terminated')
        throw new TypeError('Owned natlang evaluation was not completed: '+progress.kind);
      let value=runtime.state.control.a0.completion?.value??runtime.result;
      if(allowAsync){
        // Abrupt async roots reject their own promise without writing a
        // top-level return completion, so locate the owned root promise in
        // the replayed initial frame rather than only in control.completion.
        const rootId=runtime.initialState.control.a0.activeFrameId;
        const promiseId=runtime.initialState.frames[rootId]?.asyncPromiseId;
        if(!promiseId)
          throw new TypeError('Owned async entry has no root promise');
        const settled=runtime.state.promises[promiseId];
        if(!settled||settled.status==='pending')
          throw new TypeError('Owned async entry has not settled');
        if(settled.status==='rejected'){
          const reason=realizeGraph(runtime.state.heap,[settled.value.value])[0];
          throw new Error('Owned guest promise rejected: '+String(
            reason&&typeof reason==='object'?reason.message??reason.name??'guest object':reason));
        }
        value=settled.value.value;
      }
      let result=realizeGraph(runtime.state.heap,[value])[0];
      const staged=syncScope!==null?synchronizeLiveGraph(
        bundle.initialState.heap,runtime.state.heap,bundle.entrySpec.arguments[0],
        syncScope,value,{stage:true}):
        request.live!==undefined?synchronizeLiveGraph(
          bundle.initialState.heap,runtime.state.heap,bundle.entrySpec.arguments[1],
          request.live,value,{stage:true}):null;
      if(staged)result=staged.result;
      const resultEvent=event(this.mode,request.body,'completed',{
        traceSchema:bundle.manifest.schema,profile:bundle.manifest.profile,
        chunks:bundle.chunks.length,source:request.path,
        transpiler:lowering.compiler,asyncGuest:allowAsync
      });
      if(this.onTrace){
        const callback=this.onTrace(structuredClone(bundle),request,{
          compiler:lowering.compiler,originalText,
          javascript:lowering.javascript,sourceMap:lowering.sourceMap,
          generatedSiteOrigins:mapBoundedTypeScriptSites(lowering,bundle.sites,originalText)
        });
        if(callback && typeof callback.then==='function')
          throw new TypeError('onTrace must be synchronous; async callbacks are unowned');
      }
      // Do not expose live host writes if the trace callback refuses or closes the run.
      this.ensureOpen();
      staged?.commit();
      return {result:result===undefined?null:result,events:[resultEvent],logs:[]};
    }catch(error){
      if(error instanceof this.EvalFailure)throw error;
      throw this.failed(request,error,progress?.kind==='unsupported'?'unsupported':'failed');
    }finally{
      if(entered)this.#leaveRun();
    }
  }
}

export function createBoundedNatlangEnvironment(options){
  return new BoundedNatlangEnvironment(options);
}
