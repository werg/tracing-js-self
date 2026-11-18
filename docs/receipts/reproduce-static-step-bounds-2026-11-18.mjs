#!/usr/bin/env node
// Reproduce the bounded, source-specific F review. This compiles source only:
// it never instantiates Runtime, executes guest code, or changes campaign data.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const flags=new Map();
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  assert(['--tracer-root','--input','--out','--expected'].includes(key)&&value&&!flags.has(key));
  flags.set(key,value);
}
for(const key of ['--tracer-root','--input','--out'])assert(flags.has(key),'Missing '+key);
const root=resolve(flags.get('--tracer-root'));
const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(revision,'22eaac6a46e262b00986c63b4fc66f6240016252');
assert.equal(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}),'');
const hash=value=>createHash('sha256').update(value).digest('hex');
for(const [path,digest] of Object.entries({
  'src/runtime.js':'409ba2f858d9be918b3a3642052e865dd2ffe969103811c45f479ea8ff167b48',
  'src/frontend.js':'97b8ff87463164a4923c154fbe29c2b6c34b9eee5c964da0e8983570d64f987d',
  'src/training/profile.js':'90ed714e8b1e14f3fdbf1ee49e7df965ccd9fbd701d9add4af5f4183caa7d42a',
}))assert.equal(hash(readFileSync(join(root,path))),digest,path);
const {compile}=await import(pathToFileURL(join(root,'src/frontend.js')));
const {parseTraining}=await import(pathToFileURL(join(root,'src/training/profile.js')));
const reviewed=JSON.parse(readFileSync(resolve(flags.get('--input')),'utf8'));
const sourceHashes={
  'exercism/javascript:knapsack':'cdaabd81b0aa5e3c7aabb9cbb2dc0308974397af14fbf324a2862226a680ede3',
  'exercism/javascript:sum-of-multiples':'043ebf82c949f02852da7923a3f4819ec6d78ab90112a079b72a2f71a6ea7775',
};
function shortestCycle(instructions,start,end){
  const queue=[[start]],seen=new Set();
  for(let index=0;index<queue.length;index++){
    const path=queue[index],pc=path.at(-1);
    if(pc<start||pc>end||seen.has(pc))continue;
    seen.add(pc);
    if(pc===end)return path.map(pc=>({pc,op:instructions[pc].op,arg:instructions[pc].arg??null}));
    const {op,arg}=instructions[pc];
    const successors=op==='JUMP'?[arg]:op==='JUMP_IF_FALSE'?[pc+1,arg]:
      op==='LOGICAL_JUMP'?[pc+1,arg.to]:['RETURN','THROW'].includes(op)?[]:[pc+1];
    for(const next of successors)queue.push([...path,next]);
  }
  throw new Error('No in-loop path');
}
const cases=[];
for(const {review} of reviewed){
  if(review.family==='exercism/javascript:collatz-conjecture')continue; // No static claim.
  assert(Object.hasOwn(sourceHashes,review.family),'Unreviewed source family');
  const source=review.source.replaceAll('\\n','\n'),sourceSha256=hash(source);
  assert.equal(sourceSha256,sourceHashes[review.family]);
  const programs=Object.values(compile(parseTraining(source)).programs),cycles=[];
  for(const program of programs)for(let end=0;end<program.instructions.length;end++){
    const instruction=program.instructions[end];
    if(instruction.op!=='JUMP'||!Number.isInteger(instruction.arg)||instruction.arg>=end)continue;
    const start=instruction.arg,minimumPath=shortestCycle(program.instructions,start,end);
    cycles.push({codeId:program.id,start,end,minimumBytecodeInstructions:minimumPath.length,minimumPath});
  }
  const knapsack=review.family.endsWith(':knapsack');
  // For the two exact audited sources, monotonic loops execute capacity*items
  // inner iterations or limit-1 iterations. The sources have no early returns,
  // break, await, host operation, or callback mutation of the loop controls.
  const requiredIterations=knapsack?review.args[0]*review.args[1].length:review.args[1]-1;
  assert(Number.isSafeInteger(requiredIterations)&&requiredIterations>0);
  const inner=[...cycles].sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
  assert(inner);
  assert.equal(inner.minimumBytecodeInstructions,knapsack?55:16);
  const row={id:review.id,family:review.family,maxSteps:review.maxSteps,requiredIterations,sourceSha256,
    minimumBytecodeInstructionsPerIteration:inner.minimumBytecodeInstructions,
    optimisticInstructionLowerBound:requiredIterations*inner.minimumBytecodeInstructions,
    exceedsDeclaredStepBudget:requiredIterations*inner.minimumBytecodeInstructions>review.maxSteps,cycles};
  if(!knapsack){
    assert(Array.isArray(review.args[0])&&review.args[0].length>0);
    const callback=programs.find(program=>JSON.stringify(program.params)==='["multiple"]');
    assert(callback);
    const firstReturn=callback.instructions.findIndex(instruction=>instruction.op==='RETURN');
    const callbackMinimumPath=callback.instructions.slice(0,firstReturn+1).map((instruction,pc)=>
      ({pc,op:instruction.op,arg:instruction.arg??null}));
    assert.deepEqual(callbackMinimumPath.map(instruction=>instruction.op),['GET','GET','BINARY','CONST','BINARY','RETURN']);
    row.callbackMinimumBytecodeInstructions=callbackMinimumPath.length;
    row.callbackMinimumPath=callbackMinimumPath;
    row.callbackBoundBasis='Every supplied multiples array is nonempty, so some must invoke its owned callback at least once per loop iteration. The callback has an unconditional straight-line path to RETURN.';
    row.optimisticInstructionLowerBound=requiredIterations*(inner.minimumBytecodeInstructions+callbackMinimumPath.length);
    row.exceedsDeclaredStepBudget=row.optimisticInstructionLowerBound>review.maxSteps;
  }
  cases.push(row);
}
const proof={schema:'owned-static-step-lower-bound/1',producerRevision:revision,guestExecution:false,
  methodology:'Compile exact reviewed source with frozen F frontend. Find the shortest in-loop CFG path from a backward-jump target to that jump, counting each instruction once and calls as one. Multiply by required iterations. Ignore initialization, nested callback execution, arithmetic microsteps and final checks, making the bound optimistic. No guest source is executed. For nonempty some inputs, add the callback straight-line instruction path once per iteration; actual additional callback visits remain excluded.',cases};
if(flags.has('--expected'))assert.deepEqual(JSON.parse(JSON.stringify(proof)),JSON.parse(readFileSync(resolve(flags.get('--expected')),'utf8')));
writeFileSync(resolve(flags.get('--out')),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({cases:cases.length,overBudget:cases.filter(row=>row.exceedsDeclaredStepBudget).length,
  guestExecution:false,expectedMatched:flags.has('--expected'),proofSha256:hash(readFileSync(resolve(flags.get('--out'))))})+'\n');
