#!/usr/bin/env node
// Rebuildable source-owned boundary evidence. Raw journal and differential
// outcomes remain private; this is not an admitted training dataset.
import {writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createRuntime} from '../src/runtime.js';
import {referenceOutcome,ownedOutcome} from '../src/training/reference.js';
import {realizeGraph} from '../src/training/graph.js';
import {semanticBoundaryCases} from '../fixtures/semantic-trace-redesign/cases.mjs';

const output=process.argv[2]??null;
const rows=[];
for(const fixture of semanticBoundaryCases){
  const args=fixture.args();
  const source=fixture.source;
  const record={name:fixture.name,source,argumentsDescription:fixture.family,
    family:fixture.family};
  try {
    const runtime=createRuntime({maxSteps:30000}).startEntry({
      text:source,functionName:'run',args});
    const progress=runtime.drive();
    const bundle=runtime.exportRun();
    record.rawTrace=bundle;
    record.executionStatus=progress.kind;
    record.events=bundle.events.length;
    record.completionFacts=bundle.events.filter(e=>
      ['call.return','completion.finally.end','completion.throw',
        'completion.catch.bind','spec.internal.call'].includes(e.operation))
      .map(e=>({
        event:e.eventId,operation:e.operation,invocation:e.invocationId,
        result:e.result??null,completion:e.completion??null,
        frameChanges:e.stateChanges.filter(p=>p.table==='frames')
          .map(p=>({id:p.id,
            beforeStatus:p.before?.status??null,afterStatus:p.after?.status??null,
            pending:(p.before?.handlers??[]).at(-1)?.pending??null,
            afterPending:(p.after?.handlers??[]).at(-1)?.pending??null}))
      }));
    if(progress.kind==='terminated'&&
       runtime.state.control.a0.completion?.kind==='return'){
      const owned=ownedOutcome(runtime);
      const reference=referenceOutcome({
        source,entry:'run',args:runtime.entrySpec.arguments,
        initialHeap:runtime.initialState.heap});
      record.owned=owned;record.reference=reference;
      record.referenceMatches=isDeepStrictEqual(owned,reference);
      if(!record.referenceMatches)
        record.failure='Independent V8 observable result disagrees';
      const values=realizeGraph(runtime.state.heap,[
        ...runtime.entrySpec.arguments,
        runtime.state.control.a0.completion.value]);
      if(Object.hasOwn(fixture,'expected')){
        record.expectedMatches=isDeepStrictEqual(values.at(-1),fixture.expected);
        if(!record.expectedMatches)
          record.failure='Expected owned result disagrees';
      }
      if(fixture.expectedArgument){
        record.argumentMatches=JSON.stringify(values[0])===
          JSON.stringify(fixture.expectedArgument);
        if(!record.argumentMatches)
          record.failure='Expected argument mutation disagrees';
      }
    }
  }catch(error){
    record.executionStatus='refused';
    record.failure=String(error.message);
  }
  rows.push(record);
  console.log(JSON.stringify({name:record.name,status:record.executionStatus,
    events:record.events??null,referenceMatches:record.referenceMatches??null,
    expectedMatches:record.expectedMatches??null,
    argumentMatches:record.argumentMatches??null,errors:record.failure??null,
    completionFacts:record.completionFacts?.map(({event,operation,frameChanges})=>
      ({event,operation,frameChanges}))??[]}));
}
if(output)writeFileSync(output,rows.map(JSON.stringify).join('\n')+'\n');
if(rows.some(r=>r.referenceMatches===false||r.expectedMatches===false||
  r.argumentMatches===false))process.exitCode=1;
