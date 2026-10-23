// Owned, replay-verified subset of natlang's evaluator contract.
// Retained modules and live captures admit ordinary data graphs only: native
// functions, package loaders, resources and unowned callbacks are rejected.
import { createRuntime } from './runtime.js';
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
  constructor({EvalFailure,onTrace=null,maxSteps=10000,mode='fresh'}={}){
    if(typeof EvalFailure!=='function')
      throw new TypeError('Pass the actual natlang EvalFailure constructor for instanceof compatibility');
    if(typeof onTrace!=='function'&&onTrace!==null)
      throw new TypeError('onTrace must be a synchronous function');
    if(!['fresh','retained'].includes(mode))
      throw new TypeError('Invalid natlang environment mode');
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100000)
      throw new RangeError('maxSteps must be between 1 and 100000');
    this.EvalFailure=EvalFailure;
    this.onTrace=onTrace;
    this.maxSteps=maxSteps;
    this.mode=mode;
    this.authority='owned-training-js/1';
    // Natlang's general module loader supplies callable helpers and packages.
    // Do not advertise that integration until those calls are owned.
    this.scopeCapabilities=Object.freeze({allowModules:false,allowNetwork:false});
    this.closed=false;
    this.moduleSequence=0;
  }
  fork(){
    this.ensureOpen();
    return new BoundedNatlangEnvironment({
      EvalFailure:this.EvalFailure,onTrace:this.onTrace,maxSteps:this.maxSteps,mode:'fresh'
    });
  }
  close(){this.closed=true;}
  ensureOpen(){if(this.closed)throw new Error('Owned natlang evaluator is closed');}
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
      if(this.mode!=='retained')
        throw new TypeError('Module evaluation needs a retained owned environment');
      if(typeof code!=='string'||!bindings||typeof bindings!=='object'||
         Array.isArray(bindings)||!bindings.module||
         typeof bindings.module!=='object'||!Object.hasOwn(bindings,'exports')||
         bindings.module.exports!==bindings.exports)
        throw new TypeError('Module evaluation needs aliased module.exports and exports data bindings');
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
  execute(request){return this.run(request,false);}
  async executeAsync(request){return this.run(request,true);}
  run(request,allowAsync,{syncScope=null}={}){
    let progress=null;
    try{
      this.ensureOpen();
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
        if(value?.[0]!=='promise')
          throw new TypeError('Owned async entry has no completion promise');
        const settled=runtime.state.promises[value[1]];
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
      const resultEvent=event(this.mode,request.body,'completed',{
        traceSchema:bundle.manifest.schema,profile:bundle.manifest.profile,
        chunks:bundle.chunks.length,source:request.path,
        transpiler:lowering.compiler,asyncGuest:allowAsync
      });
      if(this.onTrace){
        const callback=this.onTrace(bundle,request,{
          compiler:lowering.compiler,originalText,
          javascript:lowering.javascript,sourceMap:lowering.sourceMap,
          generatedSiteOrigins:mapBoundedTypeScriptSites(lowering,bundle.sites,originalText)
        });
        if(callback && typeof callback.then==='function')
          throw new TypeError('onTrace must be synchronous; async callbacks are unowned');
      }
      // Commit verified mutations only after success. Existing live host graph
      // nodes retain their identity, including aliases and cyclic data.
      if(syncScope!==null)
        result=synchronizeLiveGraph(bundle.initialState.heap,runtime.state.heap,
          bundle.entrySpec.arguments[0],syncScope,value);
      else if(request.live!==undefined)
        result=synchronizeLiveGraph(bundle.initialState.heap,runtime.state.heap,
          bundle.entrySpec.arguments[1],request.live,value);
      return {result:result===undefined?null:result,events:[resultEvent],logs:[]};
    }catch(error){
      if(error instanceof this.EvalFailure)throw error;
      throw this.failed(request,error,progress?.kind==='unsupported'?'unsupported':'failed');
    }
  }
}

export function createBoundedNatlangEnvironment(options){
  return new BoundedNatlangEnvironment(options);
}
