import {createRuntime} from '/workspace/scratch/9faed68167fb/async-return-producer/src/runtime.js';
import {compileProtocolSourceV8} from '/workspace/scratch/9faed68167fb/async-return-producer/src/semantic/protocol-source-compiler-v8.js';

const source = '"use strict"; async function run(){return new Proxy({}, {get(t,k){if(k==="then") return function(resolve){resolve(9);}; return Reflect.get(t,k);}});}';
const baseline = await (new Function(`${source}; return run();`))();
const runtime = createRuntime().startEntry({text: source, functionName: 'run', args: [], allowAsync: true});
try {
  runtime.drive();
  const exported = runtime.exportRun();
  const projection = compileProtocolSourceV8(exported);
  process.stdout.write(JSON.stringify({baseline, result: 'accepted', roots: projection.outcome.graph.roots}));
} catch (error) {
  process.stdout.write(JSON.stringify({baseline, result: 'refused', name: error?.name, message: error?.message, category: error?.category}));
}
