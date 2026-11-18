// Bounded, deterministic statement deletion for trusted-source debugging.
// A reduction is accepted only after the production verifier reproduces the
// same failure category/phase. It does not prove a globally minimal program.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {decodeOwnedGraph} from '../host/graph-codec.js';
import {verifyFailureRecord} from './failure-record.js';
import {identityDigest,admissionEnvironment} from './admission-identity.js';

const sha=source=>createHash('sha256').update(source).digest('hex');
const reproducible=new Set(['unsupported_source','teacher_execution_failed','projection_refused',
  'reference_outcome_mismatch','reference_operation_mismatch','reference_branch_mismatch',
  'reference_callback_failure','reference_unhandled_rejection']);
function removableStatements(source,entry){
  const ranges=[];
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const item of node)visit(item);return;}
    if(node.type==='Program'||node.type==='BlockStatement')for(const child of node.body){
      if(child.directive||child.type==='FunctionDeclaration'&&child.id?.name===entry)continue;
      ranges.push({start:child.start,end:child.end});
    }
    for(const [key,value] of Object.entries(node))if(!['start','end','loc'].includes(key))visit(value);
  }
  visit(parse(source,{ecmaVersion:2022,sourceType:'script'}));
  return ranges.sort((a,b)=>(b.end-b.start)-(a.end-a.start)||a.start-b.start);
}
export async function minimizeFailureRecord(record,{maxAttempts=32,maxTimeMs=30000,verify=null}={}){
  verifyFailureRecord(record);
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>256||
    !Number.isSafeInteger(maxTimeMs)||maxTimeMs<1||maxTimeMs>60000)
    throw new TypeError('Minimization requires 1..256 attempts and a 1..60000 ms deadline');
  const output=structuredClone(record),original=record.original,start=performance.now();
  let source=original.source,attempts=0,accepted=0,last=null,budgetExhausted=false;
  const finish=(status,reason=null)=>{
    output.minimization={schema:'semantic-failure-minimization/1',status,reason,
      originalFailureDigest:record.failureDigest,algorithm:'greedy-statement-deletion/1',
      scope:'same-first-failure-category-and-phase; no global-minimality claim',
      limits:{maxAttempts,maxTimeMs,deadlineKind:'between-bounded-verifier-attempts',
        perAttemptMaxSteps:original.limits.maxSteps,perAttemptTimeoutMs:original.limits.timeoutMs},
      attempts,accepted,environment:admissionEnvironment(),
      counterexample:accepted?{source,sourceDigest:sha(source),failure:last.failure}:null};
    output.minimizationDigest=identityDigest(output.minimization);
    verifyFailureRecord(output);return output;
  };
  if(!['repository-fixture','trusted-owned-source'].includes(original.trustTier)||
    !reproducible.has(original.category)||original.inputGraph===null)
    return finish('not_attempted','This failure requires external native policy, resource or process diagnosis; source reduction is not an equivalent check.');
  const verifier=verify??(await import('./effectful-admit.js')).verifyEffectfulTrainingCase;
  const matches=result=>result?.failure?.original.category===original.category&&
    result.failure.original.phase===original.phase;
  const run=async candidateSource=>{
    attempts++;
    return verifier({source:candidateSource,entry:original.entry,
      args:decodeOwnedGraph(JSON.stringify(original.inputGraph)),fixture:original.fixture,
      family:original.family,ancestorIds:original.ancestorIds,taskId:original.taskId,
      license:original.license,trustTier:original.trustTier,provenance:{...original.provenance,
        minimizationParent:record.failureDigest},seeds:original.seeds,seed:original.seeds.split,
      randomSeed:original.seeds.guestRng,maxSteps:original.limits.maxSteps,
      timeoutMs:original.limits.timeoutMs,projectionOptions:original.projectionOptions,
      producerRevision:original.producerRevision,nativePolicy:original.nativePolicy});
  };
  last=await run(source);
  if(!matches(last))return finish('not_reproduced','The original failure no longer reproduces under this verifier.');
  for(;;){
    let changed=false,ranges;
    try{ranges=removableStatements(source,original.entry);}catch{
      return finish('not_attempted','The original source cannot be parsed for syntax-preserving statement reduction.');
    }
    for(const {start:from,end} of ranges){
      if(attempts>=maxAttempts||performance.now()-start>=maxTimeMs){budgetExhausted=true;break;}
      const proposed=source.slice(0,from)+source.slice(end);
      try{parse(proposed,{ecmaVersion:2022,sourceType:'script'});}catch{continue;}
      const checked=await run(proposed);
      if(matches(checked)){
        source=proposed;last=checked;accepted++;changed=true;break;
      }
    }
    if(budgetExhausted||!changed)break;
  }
  return finish(budgetExhausted?'budget_exhausted':accepted?'reduced':'unchanged');
}
