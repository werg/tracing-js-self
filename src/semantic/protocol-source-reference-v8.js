// Independent source evidence for the explicit v8 protocol path. The worker
// executes the supplied source in V8; no owned event can supply an operand.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {referenceCommand,referenceIsolationMode} from '../corpus/reference-isolation.mjs';
import {normalizeJournal} from './normalize.js';
import {compareOperationObservations} from '../training/operation-reference.js';
import {compareBranchObservations} from '../training/branch-reference.js';
import {ownedProtocolSourceObservations,compareProtocolCompletionObservations} from './protocol-source-observations-v8.js';

import {compareProtocolMetadata} from './protocol-metadata-v8.js';

const worker=fileURLToPath(new URL('../../tools/protocol-reference-v8.mjs',import.meta.url));
const fail=message=>{throw new TypeError('Protocol source reference: '+message);};
export function independentProtocolSourceReference(input,{timeoutMs=10000,maxOutputBytes=8388608,
  isolation=referenceIsolationMode()}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1)
    fail('positive deadline and byte bound required');
  return new Promise((resolve,reject)=>{
    let command;try{command=referenceCommand(worker,{timeoutMs,isolation});}catch(error){reject(error);return;}
    const child=spawn(command.command,command.args,{stdio:['pipe','pipe','pipe'],shell:false,env:command.env});
    const chunks=[];let bytes=0,stderr='',finished=false;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);
      if(error)child.kill('SIGKILL');command.cleanup();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new RangeError('Independent protocol source deadline exceeded')),timeoutMs);
    child.once('error',error=>finish(error));
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)finish(new RangeError('Independent protocol source output bound'));else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
    child.stdin.on('error',error=>finish(error));
    child.once('close',code=>{if(finished)return;
      try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(code!==0||value.error||value.schema!=='protocol-source-reference/1')
          throw new TypeError(value.error??'Malformed independent result: '+stderr);
        finish(null,value);
      }catch(error){finish(error);}
    });child.stdin.end(JSON.stringify({...input,timeoutMs}));
  });
}
function sourceSites(source){
  const operations=new Set(),branches=new Set(),logicalAssignments=new Set();
  function visit(node,parent=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child,parent);return;}
    const site=node.start+':'+node.end;
    if(['BinaryExpression','UnaryExpression','UpdateExpression'].includes(node.type)||
      node.type==='TemplateLiteral'&&parent?.type!=='TaggedTemplateExpression'||
      node.type==='AssignmentExpression'&&node.operator!=='=')operations.add(site);
    if(node.type==='AssignmentExpression'&&['&&=','||=','??='].includes(node.operator)){logicalAssignments.add(site);branches.add(site);}
    if(['IfStatement','WhileStatement','DoWhileStatement','ForStatement','ConditionalExpression'].includes(node.type)&&node.test)
      branches.add(node.test.start+':'+node.test.end);
    if(node.type==='LogicalExpression')branches.add(site);
    for(const [key,value]of Object.entries(node))if(!['start','end','loc'].includes(key))visit(value,node);
  }visit(parse(source,{ecmaVersion:'latest'}));return {operations,branches,logicalAssignments};
}
export async function auditProtocolSourceV8({bundle,referenceInput,outcome,timeoutMs=10000}){
  const modes=['original','operations','branches','completions'];
  const settled=await Promise.allSettled(modes.map(mode=>independentProtocolSourceReference({...referenceInput,mode},{timeoutMs})));
  for(const item of settled)if(item.status==='rejected')throw item.reason;
  const [original,operations,branches,completions]=settled.map(item=>item.value);
  for(const reference of [original,operations,branches,completions])
    if(!isDeepStrictEqual(reference.outcome,outcome))fail('original or instrumented completion graph differs from owned execution');
  const sites=sourceSites(referenceInput.source),events=new Map(bundle.events.map(row=>[row.eventId,row])),
    expectedOperations=[],expectedBranches=[];
  for(const row of normalizeJournal(bundle).events){
    const event=events.get(row.journalEvent),site=row.source?row.source.start+':'+row.source.end:null;
    if(event.completion?.type==='throw')continue;
    if(sites.logicalAssignments.has(site)){
      if(event.operation==='control.branch'&&row.path==='use-left')expectedOperations.push({site,value:row.test});
      else if(['binding.write','property.write'].includes(event.operation))expectedOperations.push({site,value:row.result});
    }else if(['primitive.binary','primitive.unary','binding.update','property.update','spec.operation.complete','template.substitute'].includes(event.operation)&&sites.operations.has(site))
      expectedOperations.push({site,value:row.result});
    if(event.operation==='control.branch'&&sites.branches.has(site))expectedBranches.push({site,decision:row.result});
  }
  const ownedObservations=ownedProtocolSourceObservations(bundle,referenceInput.source);
  const operationAudit=compareOperationObservations(expectedOperations,operations.operations),
    branchAudit=compareBranchObservations(expectedBranches,branches.decisions),
    completionAudit=compareProtocolCompletionObservations(ownedObservations.completions,completions.completions),
    metadataAudit=compareProtocolMetadata(ownedObservations.metadata,completions.metadata);
  if([operationAudit,branchAudit,completionAudit,metadataAudit].some(result=>result.status!=='agreed'))
    fail('independent operation/branch/completion observations differ: '+JSON.stringify({operationAudit,branchAudit,completionAudit,metadataAudit}));
  return {schema:'semantic-protocol-source-checks/1',status:'agreed',original,operationAudit,branchAudit,completionAudit,metadataAudit,
    observations:{operations:operations.operations,decisions:branches.decisions,completions:completions.completions,metadata:completions.metadata}};
}
