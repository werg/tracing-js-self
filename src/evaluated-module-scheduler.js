// Source generation for the bounded, acyclic owned ESM scheduler. This file
// never evaluates guest JavaScript: every emitted function runs in Runtime.
// Module environments are retained generator frames; their first yield only
// publishes live-binding getters, before any initializer executes.
import {parse as parseAcorn} from 'acorn';

const functionNode=node=>['FunctionDeclaration','FunctionExpression',
  'ArrowFunctionExpression'].includes(node?.type);
const children=node=>Object.entries(node).flatMap(([key,value])=>
  ['start','end','loc','range'].includes(key)?[]:
    Array.isArray(value)?value.filter(child=>child?.type):
      value?.type?[value]:[]);

export function hasTopLevelAwait(node){
  if(!node||functionNode(node))return false;
  if(node.type==='AwaitExpression'||node.type==='ForOfStatement'&&node.await)
    return true;
  return children(node).some(hasTopLevelAwait);
}

// Parse the rewritten fragment in an async body so only module-level awaits
// become generator yields. Nested async functions retain their own awaits.
// Parentheses preserve precedence even for `await await x` or await operands
// embedded in conditional, call, assignment and arithmetic expressions.
export function lowerModuleAwaits(fragment){
  const prefix='async function __traced_eval_fragment(){\n';
  const text=prefix+fragment+'\n}';
  const ast=parseAcorn(text,{ecmaVersion:2022,sourceType:'script'});
  function render(root){
    const matches=[];
    function walk(node){
      if(functionNode(node))return;
      if(node.type==='ForOfStatement'&&node.await)
        throw new SyntaxError('Unsupported evaluated-module/1: for-await module iteration requires an owned iterator continuation');
      if(node.type==='AwaitExpression'){matches.push(node);return;}
      for(const child of children(node))walk(child);
    }
    walk(root);
    let output=text.slice(root.start,root.end);
    for(const node of matches.sort((a,b)=>b.start-a.start)){
      const start=node.start-root.start,end=node.end-root.start;
      output=output.slice(0,start)+'(yield '+render(node.argument)+')'+output.slice(end);
    }
    return output;
  }
  return render(ast.body[0].body).slice(1,-1).trim();
}

// This is ordinary owned source, deliberately using existing async/await and
// generator continuations. One await in a module is one driver await; an
// async driver's completion reaction is the module-completion job. Readying
// synchronous ancestors does not add per-edge Promise reactions.
//
// The dependency algorithm follows ECMA-262 2026, 16.2.1.6.1.3.1-.5, for
// acyclic graphs. Cyclic async graphs are rejected by the linker beforehand.
// Record indices are the dependency DFS postorder, which is also the relative
// order in which AsyncEvaluationOrder is assigned. Gather marks the complete
// ready ancestor set before execution, then visits it in that order.
export const ownedModuleSchedulerSource=`
  let __traced_eval_resolve;
  let __traced_eval_reject;
  let __traced_eval_async_order=0;
  const __traced_eval_completion=new Promise(function(resolve,reject){
    __traced_eval_resolve=resolve;
    __traced_eval_reject=reject;
  });
  function __traced_eval_complete(record){
    record.status='evaluated';
    record.asyncOrder=-1;
    if(record.entry)__traced_eval_resolve(undefined);
  }
  function __traced_eval_failed(record,error){
    if(record.status==='evaluated')return;
    record.status='evaluated';
    record.asyncOrder=-1;
    record.failed=true;
    record.error=error;
    for(let i=0;i<record.parents.length;i++)
      __traced_eval_failed(__traced_eval_modules[record.parents[i]],error);
    if(record.entry)__traced_eval_reject(error);
  }
  function __traced_eval_gather(record,ready){
    for(let i=0;i<record.parents.length;i++){
      const parent=__traced_eval_modules[record.parents[i]];
      if(!ready[parent.index]&&!parent.failed){
        parent.pending-=1;
        if(parent.pending===0){
          ready[parent.index]=true;
          if(!parent.hasTLA)__traced_eval_gather(parent,ready);
        }
      }
    }
  }
  function __traced_eval_sync(record){
    const step=record.iterator.next();
    if(!step.done)throw new TypeError('Synchronous module unexpectedly suspended');
    __traced_eval_complete(record);
  }
  function __traced_eval_fulfilled(record){
    if(record.failed)return;
    __traced_eval_complete(record);
    const ready=[];
    __traced_eval_gather(record,ready);
    for(let i=0;i<__traced_eval_modules.length;i++){
      const next=__traced_eval_modules[i];
      if(ready[i]&&!next.failed){
        if(next.hasTLA)__traced_eval_start_async(next);
        else{
          try{__traced_eval_sync(next);}
          catch(error){__traced_eval_failed(next,error);}
        }
      }
    }
  }
  async function __traced_eval_async(record){
    let step=record.iterator.next();
    while(!step.done){
      let resumed;
      try{resumed=await step.value;}
      catch(error){step=record.iterator.throw(error);continue;}
      step=record.iterator.next(resumed);
    }
  }
  function __traced_eval_start_async(record){
    record.execution=__traced_eval_async(record);
    record.execution.then(function(){__traced_eval_fulfilled(record);},
      function(error){__traced_eval_failed(record,error);});
  }
  function __traced_eval_visit(record){
    if(record.status!=='linked'){
      if(record.failed)throw record.error;
      return;
    }
    record.status='evaluating';
    for(let i=0;i<record.dependencies.length;i++){
      const dependency=__traced_eval_modules[record.dependencies[i]];
      __traced_eval_visit(dependency);
      if(dependency.asyncOrder>0){
        record.pending+=1;
        dependency.parents.push(record.index);
      }
    }
    if(record.pending>0||record.hasTLA){
      __traced_eval_async_order+=1;
      record.asyncOrder=__traced_eval_async_order;
      record.status='evaluating-async';
      if(record.pending===0)__traced_eval_start_async(record);
    }else __traced_eval_sync(record);
  }
  try{
    __traced_eval_visit(__traced_eval_modules[__traced_eval_entry_index]);
  }catch(error){
    for(let i=0;i<__traced_eval_modules.length;i++){
      const record=__traced_eval_modules[i];
      if(record.status==='evaluating'){
        record.status='evaluated';record.failed=true;record.error=error;
      }
    }
    __traced_eval_reject(error);
  }
  await __traced_eval_completion;
`;
