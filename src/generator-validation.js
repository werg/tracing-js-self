// Read-only linkage checks for retained owned generator continuations.
export function validateGeneratorState(state,programs,fail,ids=null){
  for(const generator of ids?[...ids].map(id=>state.heap[id]):Object.values(state.heap)){
    if(generator.kind!=='generator')continue;
    const frame=state.frames[generator.frameId],program=programs[frame?.codeId];
    if(!frame||!program?.generator||frame.generatorId!==generator.id||frame.asyncPromiseId!==null||
       !['initializing','executing','suspendedStart','suspendedYield','completed'].includes(generator.state))
      fail('Invalid owned generator continuation identity');
    if(['suspendedStart','suspendedYield'].includes(generator.state)){
      if(frame.status!=='suspended-generator'||frame.callerFrameId!==null||frame.completion?.type!=='return')
        fail('Generator suspension lost its retained frame');
      const previous=program.instructions[frame.pc-1]?.op;
      if(previous!==(generator.state==='suspendedStart'?'GENERATOR_START':'YIELD'))
        fail('Generator suspension has the wrong source cursor');
    }else if(generator.state==='completed'){
      if(!['completed','thrown'].includes(frame.status))fail('Completed generator has an active continuation');
    }else if(frame.status!=='running')fail('Running generator has no active frame state');
  }
}
