// Bounded independent ESM observation for an acyclic module scheduler plan.
// This rewrites only standalone top-level await statements with synchronous
// markers; it adds no Promise or microtask and is not a production authority.
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import vm from 'node:vm';
import {posix} from 'node:path';

const HASH=/^[a-f0-9]{64}$/;
const NAME=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw new TypeError('Original ESM scheduler observation unsupported: '+message);};
const canonicalPath=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&
  !value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
function stable(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(!value||typeof value!=='object')fail('plan data');
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
}
const digest=value=>createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
function resolve(owner,specifier,modules){
  if(typeof specifier!=='string'||!/^[.][.]?\//.test(specifier)||/[\\?#\0]/.test(specifier))
    fail('only declared relative module specifiers are supported');
  const target=posix.normalize(posix.join(posix.dirname(owner),specifier));
  if(target.startsWith('../')||!Object.hasOwn(modules,target))fail('dependency is unavailable');
  return target;
}
function validate(plan,modules,entryModule){
  if(!exact(plan,['schema','entryModule','modules','digest'])||
     plan.schema!=='semantic-module-scheduler-plan/1'||plan.entryModule!==entryModule||
     !Array.isArray(plan.modules)||!HASH.test(plan.digest??''))
    fail('plan envelope');
  const files=plan.modules.map(row=>row.file);
  const actualFiles=Object.keys(modules);
  if(files.length!==actualFiles.length||files.length<1||files.length>64||
     new Set(actualFiles).size!==actualFiles.length||
     files.some(file=>!canonicalPath(file)||!Object.hasOwn(modules,file))||
     actualFiles.some(file=>!files.includes(file)))fail('module file set');
  const byFile=new Map();
  for(let i=0;i<plan.modules.length;i++){
    const row=plan.modules[i];
    if(!exact(row,['file','index','sourceDigest','dependencies','hasTLA'])||
       row.index!==i||!canonicalPath(row.file)||!files.includes(row.file)||byFile.has(row.file)||
       !HASH.test(row.sourceDigest??'')||row.sourceDigest!==digest(modules[row.file])||
       !Array.isArray(row.dependencies)||typeof row.hasTLA!=='boolean'||
       new Set(row.dependencies).size!==row.dependencies.length||
       row.dependencies.some(file=>!files.includes(file)))
      fail('source-qualified module row');
    byFile.set(row.file,row);
  }
  if(!byFile.has(entryModule))fail('entry absent');
  const body={schema:plan.schema,entryModule:plan.entryModule,modules:plan.modules};
  if(digest(body)!==plan.digest)fail('plan digest');
  const asts=new Map();
  for(const file of files){
    const ast=parse(modules[file],{ecmaVersion:2022,sourceType:'module',allowHashBang:true});
    const dependencies=[];
    for(const node of ast.body){
      if(node.type==='ImportDeclaration'||
         node.type==='ExportNamedDeclaration'&&node.source||
         node.type==='ExportAllDeclaration'){
        const target=resolve(file,node.source.value,modules);
        if(!dependencies.includes(target))dependencies.push(target);
      }
    }
    const planned=byFile.get(file).dependencies;
    if(dependencies.length!==planned.length||dependencies.some(dep=>!planned.includes(dep)))
      fail('static source dependencies differ from the source plan');
    if(byFile.get(file).hasTLA!==(topLevelAwaitNodes(ast).length>0))
      fail('top-level await source fact differs from the source plan');
    asts.set(file,ast);
  }
  const visiting=new Set(),visited=new Set();
  function visit(file){
    if(visiting.has(file))fail('cyclic module graph is outside the DAG profile');
    if(visited.has(file))return;
    visiting.add(file);
    for(const dep of byFile.get(file).dependencies)visit(dep);
    visiting.delete(file);visited.add(file);
  }
  visit(entryModule);
  if(visited.size!==files.length)fail('unreachable source module');
  return {files,asts,byFile};
}
function renderEdits(source,edits){
  edits.sort((a,b)=>a.start-b.start||a.end-b.end||(a.priority??0)-(b.priority??0));
  let cursor=0,out='';
  for(const edit of edits){
    if(edit.start<cursor)fail('overlapping observer edits');
    out+=source.slice(cursor,edit.start)+edit.text;
    cursor=edit.end;
  }
  return out+source.slice(cursor);
}
function topLevelAwaitNodes(ast){
  const rows=[];
  function walk(node,parent=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)walk(child,parent);return;}
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))return;
    if(node.type==='AwaitExpression'){
      if(parent?.type!=='ExpressionStatement'||parent.expression!==node)
        fail('only standalone top-level await statements are instrumented');
      rows.push({node,parent});return;
    }
    if(node.type==='ForOfStatement'&&node.await)fail('for-await is outside the DAG observer profile');
    if(node.type==='ImportExpression')fail('dynamic import is outside the DAG observer profile');
    for(const [key,value] of Object.entries(node)){
      if(['start','end','loc','range','raw','regex'].includes(key))continue;
      if(value&&typeof value==='object')walk(value,node);
    }
  }
  for(const statement of ast.body)walk(statement,null);
  return rows;
}
function caughtBySource(node,ast){
  function contains(parent,child){return parent.start<=child.start&&parent.end>=child.end;}
  const stack=[];
  function walk(current){
    if(!current||typeof current!=='object')return;
    if(Array.isArray(current)){current.forEach(walk);return;}
    if(current!==node&&contains(current,node))stack.push(current);
    for(const [key,value]of Object.entries(current)){
      if(['start','end','loc','range','raw','regex'].includes(key))continue;
      if(value&&typeof value==='object')walk(value);
    }
  }
  walk(ast);
  return stack.some(parent=>parent.type==='TryStatement'&&parent.handler&&
    contains(parent.block,node));
}
export function prepareOriginalModuleSchedulerModules({
  modules,entryModule,moduleSchedulerPlan,observerSpecifier,observerLocal
}={}){
  if(!modules||typeof modules!=='object'||Array.isArray(modules)||
     typeof observerSpecifier!=='string'||!observerSpecifier||!NAME.test(observerLocal??''))
    fail('worker inputs');
  const {files,asts,byFile}=validate(moduleSchedulerPlan,modules,entryModule);
  const output=Object.create(null),sites=new Map();
  for(const file of files){
    if(Object.values(modules).some(source=>typeof source!=='string'))fail('module source text');
    const source=modules[file],ast=asts.get(file);
    if(typeof source!=='string'||source.length>65536)fail('module source bound');
    if(ast.body.some(node=>(node.type==='ImportDeclaration'||
       node.type==='ExportNamedDeclaration'&&node.source||node.type==='ExportAllDeclaration')&&
       node.source?.value===observerSpecifier))fail('observer specifier collides with source dependency');
    let directEval=false;
    function findDirectEval(node){
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){node.forEach(findDirectEval);return;}
      if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='eval')
        directEval=true;
      if(node.type==='MetaProperty'&&node.meta?.name==='import')
        fail('import.meta is outside the VM observer profile');
      for(const [key,value] of Object.entries(node)){
        if(['start','end','loc','range','raw','regex'].includes(key))continue;
        if(value&&typeof value==='object')findDirectEval(value);
      }
    }
    findDirectEval(ast);
    if(directEval)fail('direct eval is outside the observer profile');
    const localNames=new Set();
    function names(node){
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){node.forEach(names);return;}
      if(node.type==='Identifier'&&node.name===observerLocal)localNames.add(node.name);
      for(const [key,value]of Object.entries(node)){
        if(['start','end','loc','range','raw','regex'].includes(key))continue;
        if(value&&typeof value==='object')names(value);
      }
    }
    names(ast);
    if(localNames.size)fail('observer binding collides with source');
    const edits=[],awaits=topLevelAwaitNodes(ast);
    for(const {node,parent} of awaits){
      if(caughtBySource(node,ast))fail('await inside a source try/catch is outside the observer profile');
      const statement=parent;
      const siteId=file+':await:'+node.start+':'+node.end;
      const statementText=source.slice(statement.start,statement.end);
      const awaitOperand=source.slice(node.argument.start,node.argument.end);
      const prefix=statementText.slice(0,node.start-statement.start);
      const suffix=statementText.slice(node.end-statement.start);
      if(prefix.trim()||!['',';'].includes(suffix.trim()))fail('await statement has surrounding syntax');
      edits.push({start:statement.start,end:statement.end,text:
        '{try{await '+observerLocal+'.await('+JSON.stringify(file)+','+
        JSON.stringify(siteId)+',('+awaitOperand+'));}catch(__schedulerError){'+
        observerLocal+'.reject('+JSON.stringify(file)+','+JSON.stringify(siteId)+
        ');throw __schedulerError;}'+observerLocal+'.resume('+
        JSON.stringify(file)+','+JSON.stringify(siteId)+');}'});
      if(sites.has(siteId))fail('duplicate await site');
      sites.set(siteId,{file,siteId,start:node.start,end:node.end});
    }
    const topLevelThrows=new Set(ast.body.filter(node=>node.type==='ThrowStatement'));
    function rejectUnsupportedThrows(node,inFunction=false){
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){node.forEach(child=>rejectUnsupportedThrows(child,inFunction));return;}
      const functionNode=['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type);
      if(functionNode)return;
      if(node.type==='ThrowStatement'&&!caughtBySource(node,ast)&&!topLevelThrows.has(node))
        fail('nested uncaught throws are outside the DAG observer profile');
      for(const [key,value] of Object.entries(node)){
        if(['start','end','loc','range','raw','regex'].includes(key))continue;
        if(value&&typeof value==='object')rejectUnsupportedThrows(value,inFunction);
      }
    }
    ast.body.forEach(node=>rejectUnsupportedThrows(node));
    for(const statement of topLevelThrows){
      const siteId=file+':throw:'+statement.start+':'+statement.end;
      edits.push({start:statement.start,end:statement.start,text:
        observerLocal+'.reject('+JSON.stringify(file)+','+JSON.stringify(siteId)+');'});
      sites.set(siteId,{file,siteId,start:statement.start,end:statement.end});
    }
    const firstBody=ast.body.find(node=>node.type!=='ImportDeclaration');
    const start=firstBody?.start??source.length;
    edits.push({start,end:start,priority:-1,text:observerLocal+'.start('+JSON.stringify(file)+');'});
    edits.push({start:source.length,end:source.length,text:
      '\n'+observerLocal+'.complete('+JSON.stringify(file)+');\n'});
    const rewritten=renderEdits(source,edits);
    output[file]=rewritten+'\nimport '+observerLocal+' from '+
      JSON.stringify(observerSpecifier)+';\n';
  }
  return {modules:output,moduleSchedulerPlan,sites:[...sites.values()].sort((a,b)=>a.start-b.start)};
}


// Execute instrumented original ESM in an isolated V8 module realm. The
// observation sink is a private SyntheticModule closure, never a global property.
export async function observeOriginalModuleSchedulerV8({
  modules,entryModule,moduleSchedulerPlan,entryExportName='run',
  callEntry=false,entryArgs=[],observerSpecifier='./__module_scheduler_observer__.mjs',
  observerLocal='__moduleSchedulerObserver'
}={}){
  const prepared=prepareOriginalModuleSchedulerModules({
    modules,entryModule,moduleSchedulerPlan,observerSpecifier,observerLocal
  });
  const context=vm.createContext({});
  const rows=[];
  const record=(kind,moduleFile,siteId)=>rows.push({
    kind,moduleFile,...(siteId?{siteId}:{})
  });
  const observer=Object.freeze({
    start:file=>record('module.start',file),
    await:(file,siteId,value)=>{record('module.await',file,siteId);return value;},
    resume:(file,siteId)=>record('module.resume',file,siteId),
    reject:(file,siteId)=>record('module.reject',file,siteId),
    complete:file=>record('module.complete',file)
  });
  const observerModule=new vm.SyntheticModule(['default'],function(){
    this.setExport('default',observer);
  },{context,identifier:'module-scheduler-observer:private'});
  const table=new Map(Object.entries(prepared.modules).map(([file,source])=>
    [file,new vm.SourceTextModule(source,{context,identifier:file})]));
  const root=table.get(entryModule);
  if(!root)fail('entry module is unavailable');
  let failure=null,settled=false;
  const evaluation=async()=>{
    await root.link((specifier,referencing)=>{
      if(specifier===observerSpecifier)return observerModule;
      const target=resolve(referencing.identifier,specifier,modules);
      const dependency=table.get(target);
      if(!dependency)fail('linked dependency is unavailable');
      return dependency;
    });
    return root.evaluate();
  };
  const work=evaluation();
  work.then(()=>{settled=true;},error=>{failure=error;settled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  if(!settled)fail('module graph remains pending after the bounded ESM job drain');
  const knownFiles=new Set(moduleSchedulerPlan.modules.map(row=>row.file));
  const siteById=new Map(prepared.sites.map(site=>[site.siteId,site]));
  const started=new Set(),terminal=new Set(),pending=new Map();
  for(const row of rows){
    if(!row||!knownFiles.has(row.moduleFile))fail('observer row module identity');
    if(row.kind==='module.start'){
      if(started.has(row.moduleFile))fail('module started more than once');
      started.add(row.moduleFile);
    }else if(row.kind==='module.await'){
      const site=siteById.get(row.siteId);
      if(!started.has(row.moduleFile)||terminal.has(row.moduleFile)||!site||
         site.file!==row.moduleFile||pending.has(row.moduleFile))fail('await owner or phase');
      pending.set(row.moduleFile,row.siteId);
    }else if(row.kind==='module.resume'||row.kind==='module.reject'){
      const site=siteById.get(row.siteId);
      if(!started.has(row.moduleFile)||terminal.has(row.moduleFile)||
         !site||site.file!==row.moduleFile)fail('settlement site owner');
      const awaited=pending.get(row.moduleFile);
      if(awaited){
        if(awaited!==row.siteId)fail('await settlement identity');
        pending.delete(row.moduleFile);
      }else if(row.kind==='module.resume')fail('resume without a pending await');
      if(row.kind==='module.reject')terminal.add(row.moduleFile);
    }else if(row.kind==='module.complete'){
      if(!started.has(row.moduleFile)||terminal.has(row.moduleFile)||pending.has(row.moduleFile))
        fail('completion phase');
      terminal.add(row.moduleFile);
    }else fail('unknown observer operation');
  }
  if(pending.size||[...started].some(file=>!terminal.has(file)))
    fail('started module lacks an observed terminal operation');
  if(!failure&&started.size!==knownFiles.size)
    fail('successful module graph did not start every planned module');
  const namespace=failure?null:root.namespace;
  let value=namespace&&Object.hasOwn(namespace,entryExportName)?namespace[entryExportName]:undefined;
  if(callEntry&&!failure){
    if(typeof value!=='function'||!Array.isArray(entryArgs))fail('entry export invocation');
    value=value(...entryArgs);
  }
  return {
    outcome:failure?{status:'rejected',name:String(failure?.name??'Error')}:
      {status:'fulfilled',value},
    observations:{schema:'semantic-module-scheduler-observations/1',
      planDigest:moduleSchedulerPlan.digest,rows}
  };
}
