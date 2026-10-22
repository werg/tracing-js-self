// Explicit, fail-closed natlang EvalEnvironment-shaped integration for the
// *training-js/1* subset. There is intentionally no Node vm/Function fallback.
// This is not the general natlang TypeScript/module runtime replacement.
import { createRuntime } from './runtime.js';
import { validateBundle } from './validation.js';
import { replayExact } from './replay.js';
import { realizeGraph } from './training/graph.js';

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
    if(mode!=='fresh')
      throw new TypeError('Retained realms and module execution are not implemented');
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>100000)
      throw new RangeError('maxSteps must be between 1 and 100000');
    this.EvalFailure=EvalFailure;
    this.onTrace=onTrace;
    this.maxSteps=maxSteps;
    this.mode=mode;
    this.authority='owned-training-js/1';
    this.scopeCapabilities=Object.freeze({allowModules:false,allowNetwork:false});
    this.closed=false;
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
    const e=event(this.mode,body,reason,details);
    return new this.EvalFailure(
      error instanceof Error?error.message:String(error),
      [e],{sourceStack:error instanceof Error?error.stack:undefined,logs:[]}
    );
  }
  evaluateModule(code,bindings){
    // The separate natlang module-realm factory must NEVER silently delegate
    // to a native host when the owned evaluator cannot execute its bindings.
    throw this.failed({body:true},new TypeError(
      'Owned natlang module realm is unavailable (live imports and exports are not modeled)'
    ),'unsupported');
  }
  execute(request){
    let progress=null, runtime=null, bundle=null;
    try{
      this.ensureOpen();
      if(!request||typeof request.code!=='string'||
         !request.scope||typeof request.scope!=='object'||
         Array.isArray(request.scope)||typeof request.body!=='boolean'||
         typeof request.path!=='string')
        throw new TypeError('Invalid natlang EvalRequest');
      if(request.live!==undefined &&
         (!request.live||typeof request.live!=='object'||Reflect.ownKeys(request.live).length!==0))
        throw new TypeError('Live natlang bindings are unsupported by training-js/1');
      if(request.timeoutMs!==undefined)
        throw new TypeError('Native timeouts are not available; use an owned maxSteps budget');
      if(request.code.length>65536)
        throw new RangeError('Natlang source exceeds the bounded adapter limit');
      // Parse only as Acorn training-js/1; do not execute unsupported TypeScript
      // or expand dynamic sources using the host evaluator.
      const body=request.body?request.code:`return (${request.code});`;
      const text=`"use strict";\nfunction __natlang_trace_entry(self) {\n${body}\n}\n`;
      runtime=createRuntime({maxSteps:this.maxSteps});
      const source=runtime.registerSource({text,url:request.path,trainingProfile:true});
      runtime.startEntry({source,functionName:'__natlang_trace_entry',args:[request.scope]});
      progress=runtime.drive();
      bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
      validateBundle(bundle);
      replayExact(bundle);
      if(progress.kind!=='terminated')
        throw new TypeError(`Owned natlang evaluation was not completed: ${progress.kind}`);
      const result=realizeGraph(runtime.state.heap,[runtime.result])[0];
      const resultEvent=event(this.mode,request.body,'completed',{
        traceSchema:bundle.manifest.schema,profile:bundle.manifest.profile,
        chunks:bundle.chunks.length,source:request.path
      });
      if(this.onTrace){
        const callback=this.onTrace(bundle,request);
        if(callback && typeof callback.then==='function')
          throw new TypeError('onTrace must be synchronous; async callbacks are unowned');
      }
      return {result:result===undefined?null:result,events:[resultEvent],logs:[]};
    }catch(error){
      // A well-formed unsupported run may have a valid exact-replay archive,
      // but it is never emitted to the onTrace success path as training data.
      if(error instanceof this.EvalFailure)throw error;
      throw this.failed(request,error,progress?.kind==='unsupported'?'unsupported':'failed');
    }
  }
  async executeAsync(request){return this.execute(request);}
}

export function createBoundedNatlangEnvironment(options){
  return new BoundedNatlangEnvironment(options);
}
