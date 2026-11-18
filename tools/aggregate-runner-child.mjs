// Internal entry point. A workload is never spawned before all actual kernel
// limits and the writable filesystem boundary are verified inside the unit.
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {AGGREGATE_READY,verifyAggregateKernelBoundary} from '../src/corpus/aggregate-runner.mjs';

const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(request.schema!=='aggregate-runner-request/1'||typeof request.nonce!=='string')throw Error('Invalid aggregate request');
const receipt=verifyAggregateKernelBoundary(request);
await new Promise((resolve,reject)=>process.stdout.write(AGGREGATE_READY+request.nonce+' '+JSON.stringify(receipt)+'\n',error=>error?reject(error):resolve()));
const child=spawn(request.command,request.args,{cwd:request.workspace,env:request.environment,stdio:'inherit',shell:false});
child.once('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=127;});
child.once('close',(code,signal)=>{process.exitCode=code!==null&&code>=0?code:signal?128:127;});
