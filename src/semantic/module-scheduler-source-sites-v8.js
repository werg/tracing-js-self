// Private ownership map for the generated acyclic module scheduler.
// It identifies exact generated helper/call/await ranges; it is not a runtime
// source claim and grants no public/native admission by itself.
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {verifyModuleSchedulerPlanV8} from './module-scheduler-state-v8.js';

const fail=message=>{throw new TypeError('Module scheduler source sites: '+message);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const functionArities=new Map([
  ['__traced_eval_visit',1],['__traced_eval_start_async',1],
  ['__traced_eval_async',1],['__traced_eval_sync',1],
  ['__traced_eval_fulfilled',1],['__traced_eval_failed',2],
  ['__traced_eval_gather',2],['__traced_eval_complete',1]
]);
const functionNames=new Set(functionArities.keys());
const helperName=node=>node?.type==='Identifier'&&functionNames.has(node.name)?node.name:null;
const children=node=>Object.entries(node).flatMap(([key,value])=>
  ['start','end','loc','range','raw','regex'].includes(key)?[]:
    Array.isArray(value)?value.filter(item=>item?.type):
      value?.type?[value]:[]);

export function deriveModuleSchedulerSourceSitesV8({source,moduleSchedulerPlan,bundle=null}={}){
  if(typeof source!=='string'||!moduleSchedulerPlan||
     moduleSchedulerPlan.schema!=='semantic-module-scheduler-plan/1')
    fail('generated source and source-derived scheduler plan are required');
  verifyModuleSchedulerPlanV8(moduleSchedulerPlan);
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const functions=new Map(),calls=[],records=[],awaitSites=[],completionAwaitSites=[];
  function walk(node,owner=null){
    if(!node)return;
    const name=node.type==='FunctionDeclaration'?helperName(node.id):null;
    const current=name??owner;
    if(name){
      if(functions.has(name))fail('generated scheduler helper is duplicated: '+name);
      if(node.params.length!==functionArities.get(name)||
         node.params.some(param=>param.type!=='Identifier'))
        fail('scheduler helper arity differs from its owned signature: '+name);
      functions.set(name,{name,start:node.start,end:node.end,parameter:node.params[0].name});
    }
    if(node.type==='AwaitExpression'){
      if(owner==='__traced_eval_async')
        awaitSites.push({owner,start:node.start,end:node.end,source:source.slice(node.start,node.end)});
      else if(owner===null&&node.argument?.type==='Identifier'&&
          node.argument.name==='__traced_eval_completion')
        completionAwaitSites.push({start:node.start,end:node.end,
          source:source.slice(node.start,node.end)});
      // Source async functions have their own awaits. They acquire no module
      // scheduler ownership merely by appearing in this generated source.
    }
    if(node.type==='CallExpression'){
      const helper=helperName(node.callee);
      if(helper){
        if(node.arguments.length!==functionArities.get(helper)||
           node.arguments.some(argument=>argument.type==='SpreadElement'))
          fail('scheduler helper call differs from its owned signature: '+helper);
        if(current!==null&&!functions.has(current))fail('scheduler helper call lacks an exact owning helper');
        if(current===null&&helper!=='__traced_eval_visit')fail('only the scheduler entry may call a helper at top level');
        calls.push({helper,caller:current,start:node.start,end:node.end,
          argument:node.arguments[0]?source.slice(node.arguments[0].start,node.arguments[0].end):null});
      }
    }
    if(node.type==='ExpressionStatement'&&node.expression?.type==='AssignmentExpression'){
      const assign=node.expression,left=assign.left;
      if(left?.type==='MemberExpression'&&left.object?.type==='Identifier'&&
         left.object.name==='__traced_eval_modules'&&left.computed&&
         left.property?.type==='Literal'&&Number.isSafeInteger(left.property.value)&&
         assign.operator==='='&&assign.right?.type==='ObjectExpression'){
        const index=left.property.value,module=moduleSchedulerPlan.modules[index];
        if(!module)fail('generated scheduler record index is outside the source plan');
        const fields=new Map(assign.right.properties.filter(property=>property.type==='Property'&&
          property.key?.type==='Identifier').map(property=>[property.key.name,property.value]));
        const dependencyArray=fields.get('dependencies');
        if(fields.get('file')||fields.get('index')?.type!=='Literal'||fields.get('index').value!==index||
           fields.get('hasTLA')?.type!=='Literal'||fields.get('hasTLA').value!==module.hasTLA||
           dependencyArray?.type!=='ArrayExpression'||
           dependencyArray.elements.some(item=>item?.type!=='Literal'||!Number.isSafeInteger(item.value)||
             item.value<0||!moduleSchedulerPlan.modules[item.value])||
           JSON.stringify(dependencyArray.elements.map(item=>moduleSchedulerPlan.modules[item.value].file))!==
             JSON.stringify(module.dependencies))
          fail('generated module record initializer differs from the source plan');
        records.push({index,file:module.file,start:assign.right.start,end:assign.right.end,
          dependencies:module.dependencies.slice(),hasTLA:module.hasTLA});
      }
    }
    for(const child of children(node))walk(child,current);
  }
  walk(ast);
  for(const name of functionNames)if(!functions.has(name))
    fail('required scheduler helper is absent: '+name);
  if(records.length!==moduleSchedulerPlan.modules.length||
     new Set(records.map(row=>row.index)).size!==records.length)
    fail('generated module record table does not match the source plan');
  if(awaitSites.length!==1||completionAwaitSites.length!==1)
    fail('scheduler requires its unique module-driver and entry-completion await sites');
  if(bundle){
    if(!Array.isArray(bundle.sites)||!bundle.programs||typeof bundle.programs!=='object'||
       Array.isArray(bundle.programs))fail('owned archive source sites are malformed');
    for(const call of calls){
      const matches=bundle.sites.filter(site=>site.start===call.start&&site.end===call.end&&
        ['CALL','CALL_METHOD','CALL_METHOD_OPTIONAL'].includes(site.op));
      if(matches.length!==1)fail('scheduler helper call does not map to one exact bytecode call site');
      const code=bundle.programs[matches[0].codeId],instructions=code?.instructions;
      const instruction=instructions?.filter(row=>row.siteId===matches[0].siteId&&row.op===matches[0].op);
      if(!instruction||instruction.length!==1)fail('scheduler helper call site has no unique bytecode instruction');
      call.siteId=matches[0].siteId;
      call.codeId=matches[0].codeId;
      call.op=matches[0].op;
    }
    for(const site of awaitSites){
      const matches=bundle.sites.filter(row=>row.start===site.start&&row.end===site.end);
      if(matches.length<1)fail('scheduler await site is absent from the owned archive');
      site.siteIds=matches.map(row=>row.siteId);
      site.codeIds=[...new Set(matches.map(row=>row.codeId))];
    }
  }
  const planBody={planDigest:moduleSchedulerPlan.digest,sourceDigest:digest(source),
    functions:[...functions.values()].sort((a,b)=>a.start-b.start),
    calls:calls.sort((a,b)=>a.start-b.start),
    records:records.sort((a,b)=>a.index-b.index),
    awaitSites:awaitSites.sort((a,b)=>a.start-b.start),
    completionAwaitSites:completionAwaitSites.sort((a,b)=>a.start-b.start)};
  return {...planBody,schema:'semantic-module-scheduler-source-sites/1',
    digest:digest(JSON.stringify(planBody))};
}
