#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {causalPrefix} from '../src/causal.js';
const args=process.argv.slice(2);
const command=args.shift();
const output=args.includes('--output')?args[args.indexOf('--output')+1]:null;
function present(runtime,progress) {
  const bundle=runtime.exportRun();
  if(output)writeFileSync(output,JSON.stringify(bundle,null,2)+'\n');
  console.log(JSON.stringify({progress,chunks:bundle.chunks.length,events:bundle.events.length,
    effects:Object.values(bundle.effects).map(e=>({id:e.id,operation:e.operation,external:e.external})),
    verification:validateBundle(bundle),...(output?{output}:{})},null,2));
}
try {
  if(command==='demo') {
    const src=readFileSync(new URL('../examples/async-demo.js',import.meta.url),'utf8');
    const stored=[];
    const runtime=createRuntime({adapters:{'demo.store':({args})=>{stored.push(args);return {kind:'normal',value:undefined};}}}).start(src);
    const first=runtime.drive();
    const [a,b]=Object.values(runtime.state.effects).filter(e=>e.operation==='demo.readAsync');
    const inputB=runtime.recordInputArrival({effectId:b.id,kind:'completion',value:20});
    runtime.deliverInput(inputB.inputId);const second=runtime.drive();
    const inputA=runtime.recordInputArrival({effectId:a.id,kind:'completion',value:10});
    runtime.deliverInput(inputA.inputId);const third=runtime.drive();
    present(runtime,{chunks:[first.kind,second.kind,third.kind],stored,causalPrefixEvents:causalPrefix(runtime.exportRun(),{throughEventId:runtime.events.at(-1).eventId}).events.length});
  } else if(command==='run') {
    const path=args[0];if(!path)throw new Error('Usage: tracing-js-self run path.js [--output trace.json]');
    const runtime=createRuntime().start(readFileSync(path,'utf8'));
    present(runtime,runtime.drive());
  } else if(command==='validate') {
    const bundle=JSON.parse(readFileSync(args[0],'utf8'));console.log(JSON.stringify(validateBundle(bundle),null,2));
  } else if(command==='replay') {
    const bundle=JSON.parse(readFileSync(args[0],'utf8'));console.log(JSON.stringify(replayExact(bundle),null,2));
  } else if(command==='causal') {
    const bundle=JSON.parse(readFileSync(args[0],'utf8'));console.log(JSON.stringify(causalPrefix(bundle,{throughEventId:args[1]??null}),null,2));
  } else throw new Error('Usage: tracing-js-self demo | run path.js [--output trace.json] | validate trace.json | replay trace.json | causal trace.json [eventId]');
} catch(error){console.error(error.stack);process.exitCode=1;}
