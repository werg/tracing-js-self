// Independent original-source authority. This process executes original guest
// source and instruments separate diagnostic runs; it imports no selected wire
// compiler, public harness, or teacher evaluator.
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {normalizeJournal} from './normalize.js';
import {AdmissionFailure} from '../training/failure-record.js';
import {referenceCommand,referenceIsolationMode} from '../corpus/reference-isolation.mjs';
import {ownedCompletionObservations,compareCompletionObservations} from '../training/completion-reference.js';
const referenceWorker=fileURLToPath(new URL('../../tools/effectful-reference-worker.mjs',import.meta.url));
export function independentEffectfulReference(input,{timeoutMs=5000,maxOutputBytes=4194304,
    isolation=referenceIsolationMode()}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1)
    throw new TypeError('Reference deadline and output bound must be positive safe integers');
  return new Promise((resolve,reject)=>{
    let command;
    try{command=referenceCommand(referenceWorker,{timeoutMs,isolation});}
    catch(error){reject(new AdmissionFailure('reference_isolation_failure',error.message));return;}
    const child=spawn(command.command,command.args,{stdio:['pipe','pipe','pipe'],shell:false,
      env:command.env});
    const chunks=[];let outputBytes=0,stderr='',done=false;
    const fail=(category,message,details=null)=>new AdmissionFailure(category,message,details);
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);
      if(error){
        // Keep the generation worker's process group so campaign cancellation
        // reaches the complete tree. unshare --kill-child also reaps the isolated
        // PID-namespace init when this direct child is killed on a deadline.
        child.kill('SIGKILL');
        command.cleanup();reject(error);
      }else{command.cleanup();resolve(value);}};
    const timer=setTimeout(()=>finish(fail('reference_timeout','Independent source-reference deadline exceeded',
      {timeoutMs,mode:input.mode??'original'})),timeoutMs);
    child.once('error',error=>finish(fail('reference_process_failure','Independent source process failed to start',
      {code:error.code??null,message:error.message})));
    child.stdout.on('data',bytes=>{outputBytes+=bytes.length;
      if(outputBytes>maxOutputBytes)finish(fail('reference_output_limit','Independent reference output bound exceeded',
        {maxOutputBytes,mode:input.mode??'original'}));
      else chunks.push(bytes);});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4096);});
    child.once('close',code=>{
      if(done)return;
      const stdout=Buffer.concat(chunks).toString('utf8');
      try{
        const result=JSON.parse(stdout);
        if(code!==0||result.error){
          const category=result.failure?.category??'reference_process_failure';
          finish(fail(category,String(result.error??stderr??'Independent reference failed'),
            {code,stderr,mode:input.mode??'original',failure:result.failure??null}));return;
        }
        if(result.schema!=='effectful-reference/4'||!['return','throw'].includes(result.outcome?.kind)||
          !Array.isArray(result.effects)||!Array.isArray(result.callbackFailures))
          throw new Error('Incomplete independent reference response');
        finish(null,result);
      }catch(error){
        const setupFailed=isolation==='linux-namespace'&&(code===126||/^(?:unshare:|mount:|Reference isolation setup failed)/m.test(stderr));
        const resourceFailed=isolation==='linux-namespace'&&([137,152].includes(code)||/out of memory|heap limit/i.test(stderr));
        finish(fail(setupFailed?'reference_isolation_failure':resourceFailed?'reference_resource_limit':'reference_process_failure',
        'Independent source process '+code+': '+error.message,
        {code,stderr,stdout:stdout.slice(0,8192),mode:input.mode??'original'}));}
    });
    child.stdin.on('error',error=>finish(fail('reference_process_failure','Independent reference input failed',
      {code:error.code??null,message:error.message})));
    child.stdin.end(JSON.stringify({...input,timeoutMs}));
  });
}
function staticSites(source){
  const operation=new Set(),branch=new Set();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child);return;}
    if(['BinaryExpression','UnaryExpression','UpdateExpression','TemplateLiteral'].includes(node.type)||
      node.type==='AssignmentExpression'&&node.operator!=='=')operation.add(node.start+':'+node.end);
    if(['IfStatement','WhileStatement','DoWhileStatement','ForStatement','ConditionalExpression'].includes(node.type)&&node.test)
      branch.add(node.test.start+':'+node.test.end);
    if(node.type==='LogicalExpression')branch.add(node.start+':'+node.end);
    for(const [key,value] of Object.entries(node))if(!['start','end','loc'].includes(key))visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));return {operation,branch};
}
export function independentSemanticChecks(bundle,source,operations,decisions,completions){
  const sites=staticSites(source),semantic=normalizeJournal(bundle);
  const events=new Map(bundle.events.map(event=>[event.eventId,event]));
  const types=new Set(['primitive.binary','primitive.unary','template.substitute',
    'spec.operation.complete','binding.update','property.update']);
  const expectedOperations=[],expectedBranches=[];
  for(const row of semantic.events){
    const event=events.get(row.journalEvent),site=row.source?row.source.start+':'+row.source.end:null;
    if(types.has(event.operation)&&sites.operation.has(site)&&event.completion?.type!=='throw')
      expectedOperations.push({site,value:row.result});
    if(event.operation==='control.branch'&&sites.branch.has(site)&&event.completion?.type!=='throw')
      expectedBranches.push({site,decision:row.result});
  }
  if(!isDeepStrictEqual(expectedOperations,operations))
    throw new AdmissionFailure('reference_operation_mismatch','Independent executed computation receipts disagree',
      {expectedOperations,operations});
  if(!isDeepStrictEqual(expectedBranches,decisions))
    throw new AdmissionFailure('reference_branch_mismatch','Independent executed branch receipts disagree',
      {expectedBranches,decisions});
  let completionChecks;
  try{completionChecks=compareCompletionObservations(ownedCompletionObservations(bundle,source),completions);}
  catch(error){throw new AdmissionFailure('reference_completion_unsupported',error.message);}
  if(completionChecks.status!=='agreed')throw new AdmissionFailure('reference_completion_mismatch',
    'Independent assignment, statement, call or abrupt-completion receipts disagree',completionChecks);
  return {schema:'effectful-source-checks/5',status:'agreed',
    computations:operations.length,branches:decisions.length,completions:completionChecks};
}
