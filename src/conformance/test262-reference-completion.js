// Observe the original harness function without replacing its implementation.
// Guest print tokens alone are not evidence that the Test262 $DONE protocol ran.
export function createTest262ReferenceCompletion(){
  let calls=0,depth=0,bound=false;
  const output=[];
  return {
    output,
    get calls(){return calls;},
    bind(context){
      if(bound)throw new TypeError('Original Test262 completion was already bound');
      const descriptor=Object.getOwnPropertyDescriptor(context,'$DONE');
      if(typeof descriptor?.value!=='function')
        throw new TypeError('Original doneprintHandle.js did not define $DONE');
      const observed=new Proxy(descriptor.value,{
        apply(target,receiver,args){
          calls++;depth++;
          try{return Reflect.apply(target,receiver,args);}
          finally{depth--;}
        }
      });
      Object.defineProperty(context,'$DONE',{...descriptor,value:observed});
      bound=true;
    },
    print(text){output.push({text,originalDone:depth>0});},
    result(){
      const completions=output.filter(item=>item.text==='Test262:AsyncTestComplete');
      const failures=output.filter(item=>item.text.startsWith('Test262:AsyncTestFailure:'));
      const details={completionCalls:calls,completionPrints:completions.length,
        originalCompletionPrints:completions.filter(item=>item.originalDone).length};
      if(failures.length)return {status:'failed',reason:'Original reference async harness reported failure',
        ...details,failurePrints:failures.length};
      if(calls>1||completions.length>1)return {status:'failed',
        reason:'Reference async completion occurred more than once',...details};
      if(completions.length&&calls!==1)return {status:'failed',
        reason:'Async completion output was printed without the original harness $DONE call',...details};
      if(calls!==1||completions.length!==1)return {status:'resource_limited',
        reason:'No original reference async completion before quiescence',...details};
      if(!completions[0].originalDone)return {status:'failed',
        reason:'Async completion output did not originate in the original harness $DONE call',...details};
      return {status:'passed',reason:'Original reference async completion protocol completed exactly once',...details};
    }
  };
}
