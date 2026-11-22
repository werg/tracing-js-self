// Source-bound instrumentation for the independent original-ESM namespace reference.
// This helper validates/re-writes source ranges only; native namespace operations execute
// in the worker's vm.SourceTextModule graph.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';

const HASH=/^[a-f0-9]{64}$/;
const NAME=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NS_NAME=/^__traced_eval_namespace_(?:0|[1-9][0-9]*)$/;
const LOWERED=/^__traced_eval_m(?:[1-9][0-9]*)_[A-Za-z_$][A-Za-z0-9_$]*$/;
const canonicalPath=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&
  !value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const fail=message=>{throw new TypeError('Original ESM namespace observation unsupported: '+message);};
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
  (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function stable(value){
  const seen=new Set();
  function order(node){
    if(node===null||typeof node==='string'||typeof node==='boolean')return node;
    if(typeof node==='number'&&Number.isFinite(node)&&!Object.is(node,-0))return node;
    if(typeof node!=='object'||seen.has(node))fail('plan contains noncanonical data');
    seen.add(node);let result;
    if(Array.isArray(node)){
      for(let i=0;i<node.length;i++)if(!Object.hasOwn(node,i))fail('sparse plan array');
      result=node.map(order);
    }else{
      if(!plain(node))fail('plan contains a non-data object');
      result=Object.fromEntries(Object.keys(node).sort().map(key=>[key,order(node[key])]));
    }
    seen.delete(node);return result;
  }
  return JSON.stringify(order(value));
}
function digest(value){
  return createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
}
const bindingNames=pattern=>{
  const names=[];
  function visit(node){
    if(!node)return;
    if(node.type==='Identifier'){names.push(node.name);return;}
    if(node.type==='RestElement'){visit(node.argument);return;}
    if(node.type==='AssignmentPattern'){visit(node.left);return;}
    if(node.type==='ArrayPattern'){for(const item of node.elements)visit(item);return;}
    if(node.type==='ObjectPattern'){for(const item of node.properties)
      visit(item.type==='RestElement'?item.argument:item.value);}
  }
  visit(pattern);return names;
};
function resolveModule(owner,specifier,modules){
  if(typeof specifier!=='string'||!/^\.\.?\//.test(specifier)||/[\\?#\0]/.test(specifier))
    fail('namespace import is not a declared relative module');
  const target=posix.normalize(posix.join(posix.dirname(owner),specifier));
  if(target.startsWith('../')||!Object.hasOwn(modules,target))fail('namespace import target is unavailable');
  return target;
}
function validatePlan(plan,modules,entryModule){
  if(!exact(plan,['schema','entryModule','modules','cells','namespaces','digest'])||
     plan.schema!=='semantic-module-namespace-plan/1'||plan.entryModule!==entryModule||
     !Array.isArray(plan.modules)||!Array.isArray(plan.cells)||!Array.isArray(plan.namespaces)||
     !HASH.test(plan.digest??''))
    fail('module namespace plan fields differ');
  const files=Object.keys(modules).sort(),planned=plan.modules;
  if(files.some(file=>!canonicalPath(file)))fail('module file path is not canonical');
  if(files.length<1||files.length>64||files.length!==planned.length||
     planned.some((row,index)=>!exact(row,['file','sourceDigest'])||row.file!==files[index]||
       !HASH.test(row.sourceDigest??'')||row.sourceDigest!==digest(modules[row.file])))
    fail('module sources differ from the source-bound namespace plan');
  const {digest:planDigest,...body}=plan;
  if(digest(body)!==planDigest)fail('module namespace plan digest differs');
  if(plan.cells.length>4096||plan.namespaces.length>64)fail('namespace plan exceeds bounds');
  const cells=new Map();
  for(const cell of plan.cells){
    if(!exact(cell,['id','file','local','kind','mutable','loweredName'])||
       !files.includes(cell.file)||!NAME.test(cell.local)||!LOWERED.test(cell.loweredName)||
       !['let','const','var','function','class'].includes(cell.kind)||
       cell.mutable!==(cell.kind!=='const')||cell.id!==cell.file+'#'+cell.local||cells.has(cell.id))
      fail('source cell record is malformed');
    cells.set(cell.id,cell);
  }
  const namespaces=new Map(),exportsByFile=new Map();
  let exportTotal=0;
  for(const record of plan.namespaces){
    if(!exact(record,['file','namespaceName','exports'])||!files.includes(record.file)||
       !NS_NAME.test(record.namespaceName)||!Array.isArray(record.exports)||namespaces.has(record.file)||
       record.exports.length>2048||[...namespaces.values()].some(row=>row.namespaceName===record.namespaceName))
      fail('namespace link record is malformed');
    let previous='';
    const exports=new Map();
    for(const item of record.exports){
      if(!exact(item,['name','cell'])||typeof item.name!=='string'||!item.name||item.name.length>256||
         ++exportTotal>4096||item.name<=previous||!cells.has(item.cell))
        fail('namespace export-to-cell binding is malformed');
      previous=item.name;
      const cell=cells.get(item.cell);
        if(cell.kind!=='let'&&cell.kind!=='const')
        fail('namespace exports must be initialized scalar let/const cells');
      exports.set(item.name,item.cell);
    }
    namespaces.set(record.file,record);exportsByFile.set(record.file,exports);
  }
  if(namespaces.size===0)fail('namespace plan has no linked namespace objects');
  return {files,cells,namespaces,exportsByFile};
}

function literalName(node){
  if(node?.type==='Identifier')return node.name;
  if(node?.type==='Literal'&&typeof node.value==='string')return node.value;
  return null;
}
function verifyOriginalExportBindings(modules,plan,canonical){
  const localByFile=new Map(),exportRefsByFile=new Map(),asts=new Map();
  for(const file of canonical.files){
    const ast=parse(modules[file],{ecmaVersion:2022,sourceType:'module',allowHashBang:true});
    asts.set(file,ast);localByFile.set(file,new Map());exportRefsByFile.set(file,new Map());
  }
  const put=(map,key,value)=>{
    if(typeof key!=='string'||!key)fail('original module has an ambiguous export binding');
    if(map.has(key)){
      const prior=map.get(key);
      if(prior.cell&&value.cell&&prior.cell===value.cell)return;
      fail('original module has an ambiguous export binding');
    }
    map.set(key,value);
  };
  for(const file of canonical.files){
    const ast=asts.get(file),locals=localByFile.get(file),refs=exportRefsByFile.get(file);
    for(const node of ast.body){
      if(node.type==='VariableDeclaration'){
        for(const declarator of node.declarations)if(declarator.id?.type==='Identifier')
          put(locals,declarator.id.name,{cell:file+'#'+declarator.id.name});
      }else if(node.type==='FunctionDeclaration'||node.type==='ClassDeclaration'){
        if(node.id)put(locals,node.id.name,{cell:file+'#'+node.id.name});
      }else if(node.type==='ImportDeclaration'){
        const target=resolveModule(file,node.source.value,modules);
        for(const specifier of node.specifiers)if(specifier.type==='ImportSpecifier')
          put(locals,specifier.local.name,{target,name:literalName(specifier.imported)});
      }
      if(node.type==='ExportAllDeclaration')
        fail('star exports are outside the independent namespace plan profile');
      if(node.type!=='ExportNamedDeclaration')continue;
      if(node.declaration){
        const declaration=node.declaration;
        if(declaration.type==='VariableDeclaration'){
          for(const declarator of declaration.declarations)if(declarator.id?.type==='Identifier'){
            const binding={cell:file+'#'+declarator.id.name};
            put(locals,declarator.id.name,binding);put(refs,declarator.id.name,binding);
          }
        }else if((declaration.type==='FunctionDeclaration'||declaration.type==='ClassDeclaration')&&declaration.id){
          const binding={cell:file+'#'+declaration.id.name};
          put(locals,declaration.id.name,binding);put(refs,declaration.id.name,binding);
        }
      }
      for(const specifier of node.specifiers??[]){
        const name=literalName(specifier.exported),localName=literalName(specifier.local);
        if(name===null||localName===null)fail('original export name is not a static string');
        if(node.source){
          put(refs,name,{target:resolveModule(file,node.source.value,modules),name:localName});
        }else{
          const local=locals.get(localName);
          if(!local)fail('original local export binding is unavailable');
          put(refs,name,local);
        }
      }
    }
  }
  function resolve(file,name,trail=new Set()){
    const key=file+'\\0'+name;
    if(trail.has(key))fail('cyclic original namespace export binding is outside this profile');
    const ref=exportRefsByFile.get(file)?.get(name);
    if(!ref)fail('original namespace export is missing from source modules');
    if(ref.cell)return ref.cell;
    const next=new Set(trail);next.add(key);
    return resolve(ref.target,ref.name,next);
  }
  for(const namespace of plan.namespaces){
    const actual=exportRefsByFile.get(namespace.file),expected=new Map(namespace.exports.map(row=>[row.name,row.cell]));
    if(!actual||actual.size!==expected.size)fail('original namespace export table differs from the plan');
    for(const name of actual.keys())if(!expected.has(name)||resolve(namespace.file,name)!==expected.get(name))
      fail('original namespace reexport does not resolve to its planned source cell');
  }
}
function renderEdits(source,edits,start=0,end=source.length){
  const inside=edits.filter(edit=>edit.start>=start&&edit.end<=end);
  const top=inside.filter(edit=>!inside.some(other=>other!==edit&&other.start<=edit.start&&
    other.end>=edit.end&&(other.start<edit.start||other.end>edit.end)));
  top.sort((a,b)=>a.start-b.start||a.end-b.end);
  let cursor=start,out='';
  for(const edit of top){
    if(edit.start<cursor)fail('overlapping source instrumentation ranges');
    out+=source.slice(cursor,edit.start);
    const children=inside.filter(child=>child!==edit&&child.start>=edit.start&&child.end<=edit.end);
    const body=renderEdits(source,children,edit.start,edit.end);
    out+=edit.render(body);cursor=edit.end;
  }
  return out+source.slice(cursor,end);
}
function collectBindings(node,found){
  if(!node||typeof node!=='object')return;
  if(Array.isArray(node)){for(const item of node)collectBindings(item,found);return;}
  if(node.type==='VariableDeclarator')for(const name of bindingNames(node.id))found.push(name);
  if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression'||node.type==='ArrowFunctionExpression'){
    if(node.id)for(const name of bindingNames(node.id))found.push(name);
    for(const parameter of node.params??[])for(const name of bindingNames(parameter))found.push(name);
  }
  if(node.type==='ClassDeclaration'||node.type==='ClassExpression')if(node.id)
    for(const name of bindingNames(node.id))found.push(name);
  if(node.type==='CatchClause'&&node.param)for(const name of bindingNames(node.param))found.push(name);
  for(const [key,value]of Object.entries(node)){
    if(['start','end','loc','range','raw'].includes(key))continue;
    if(value&&typeof value==='object')collectBindings(value,found);
  }
}
export function prepareOriginalNamespaceModules({modules,entryModule,plan,observerSpecifier,observerLocal}={}){
  if(!plain(modules)||!exact(plan,['schema','entryModule','modules','cells','namespaces','digest'])||
     typeof observerSpecifier!=='string'||!observerSpecifier||!NAME.test(observerLocal??''))
    fail('worker observation preparation inputs are malformed');
  const canonical=validatePlan(plan,modules,entryModule);
  verifyOriginalExportBindings(modules,plan,canonical);
  const namespaceFiles=new Set(canonical.namespaces.keys());
  const output=Object.create(null),namespaceImports=new Map();
  for(const file of canonical.files){
    const source=modules[file];
    if(typeof source!=='string'||source.length>65536)fail('module source exceeds bound');
    const ast=parse(source,{ecmaVersion:2022,sourceType:'module',allowHashBang:true});
    const aliases=new Map();
    const allBindings=[];collectBindings(ast,allBindings);
    if(allBindings.includes(observerLocal))fail('private observer binding collides with original source');
    for(const statement of ast.body){
      if(statement.type!=='ImportDeclaration')continue;
      if(statement.source.value===observerSpecifier)fail('private observer specifier collides with original source');
      const target=resolveModule(file,statement.source.value,modules);
      for(const specifier of statement.specifiers){
        if(specifier.type==='ImportNamespaceSpecifier'&&!namespaceFiles.has(target))
          fail('source namespace import is absent from the namespace plan');
        if(specifier.type==='ImportNamespaceSpecifier'&&namespaceFiles.has(target)){
          aliases.set(specifier.local.name,target);
          namespaceImports.set(file,namespaceImports.get(file)??new Set());
          namespaceImports.get(file).add(target);
        }
      }
    }
    const bindings=[];collectBindings(ast,bindings);
    for(const alias of aliases.keys())if(bindings.includes(alias))
      fail('namespace import is shadowed by another lexical binding');
    const usesObjectNamespaceCall=source.includes('Object.keys')||source.includes('Object.getOwnPropertyDescriptor');
    if(usesObjectNamespaceCall&&bindings.includes('Object'))
      fail('Object intrinsic is shadowed');
    const cellRows=[...canonical.cells.values()].filter(cell=>cell.file===file&&
      [...canonical.exportsByFile.values()].some(exports=>[...exports.values()].includes(cell.id)));
    for(const cell of cellRows)if(bindings.filter(name=>name===cell.local).length!==1)
      fail('namespace cell is shadowed by another lexical binding');
    const backed=new Map(cellRows.map(cell=>[cell.local,cell]));
    const edits=[],initialized=new Set(),seenDeclarations=new Set(),seenAliases=new Set();
    const add=(node,render)=>edits.push({start:node.start,end:node.end,render});
    function walk(node,parent=null,key=null,grandparent=null){
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){for(const child of node)walk(child,parent,key,grandparent);return;}
      if(node.type==='ImportNamespaceSpecifier'&&aliases.has(node.local.name)){walk(node.source??null,node,'source',parent);return;}
      if(node.type==='Identifier'&&aliases.has(node.name))
        fail('namespace import escapes a supported source operation');
      if(node.type==='CallExpression'){
        const callee=node.callee;
        if(callee?.type==='MemberExpression'&&callee.object?.type==='Identifier'&&callee.object.name==='Object'){
          const prop=callee.computed&&callee.property.type==='Literal'?callee.property.value:
            !callee.computed&&callee.property.type==='Identifier'?callee.property.name:null;
          const first=node.arguments?.[0];
          if(prop==='keys'&&first?.type==='Identifier'&&aliases.has(first.name)){
            if(node.arguments.length!==1)fail('Object.keys namespace operation has extra arguments');
            const target=aliases.get(first.name);
            seenAliases.add(first.name);
            add(node,()=>observerLocal+'.keys('+JSON.stringify(target)+',Object.keys,'+first.name+')');
            return;
          }
          if(prop==='getOwnPropertyDescriptor'&&first?.type==='Identifier'&&aliases.has(first.name)){
            if(node.arguments.length!==2||node.arguments[1].type!=='Literal'||
               typeof node.arguments[1].value!=='string')
              fail('namespace descriptor requires a literal export name');
            const target=aliases.get(first.name),exportName=node.arguments[1].value;
            if(!canonical.exportsByFile.get(target)?.has(exportName))
              fail('descriptor name is not a planned namespace export');
            seenAliases.add(first.name);
            add(node,()=>observerLocal+'.descriptor('+JSON.stringify(target)+
              ',Object.getOwnPropertyDescriptor,'+first.name+','+JSON.stringify(exportName)+')');
            return;
          }
        }
      }
      if(node.type==='MemberExpression'&&node.object?.type==='Identifier'&&aliases.has(node.object.name)){
        if(parent?.type==='AssignmentExpression'&&key==='left'||
           parent?.type==='UpdateExpression'&&key==='argument'||
           parent?.type==='UnaryExpression'&&parent.operator==='delete')
          fail('namespace property mutation is outside the observation profile');
        const target=aliases.get(node.object.name);
        if(node.computed&&node.property.type==='Identifier'){
          seenAliases.add(node.object.name);
          add(node,()=>observerLocal+'.dynamicRead('+JSON.stringify(target)+','+
            node.object.name+','+node.property.name+')');
          return;
        }
        const exportName=node.computed?(node.property.type==='Literal'&&typeof node.property.value==='string'?
          node.property.value:null):node.property.type==='Identifier'?node.property.name:null;
        if(exportName===null||!canonical.exportsByFile.get(target)?.has(exportName))
          fail('namespace read is not a declared static scalar export');
        seenAliases.add(node.object.name);
        const original=source.slice(node.start,node.end);
        add(node,()=>observerLocal+'.read('+JSON.stringify(target)+','+node.object.name+','+
          JSON.stringify(exportName)+','+original+')');
        return;
      }
      if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&backed.has(node.id.name)){
        const cell=backed.get(node.id.name);
        if((node.init===null)||!['let','const'].includes(node.kind??parent?.kind))
          fail('namespace cell must have a scalar let/const initializer');
        const declaration=parent,topLevel=declaration?.type==='VariableDeclaration'&&
          (grandparent?.type==='Program'||grandparent?.type==='ExportNamedDeclaration');
        if(!topLevel)fail('namespace cells must be module-level declarations');
        const kind=declaration.kind;
        if(kind!==cell.kind)fail('namespace cell declaration kind differs from its source plan');
        if(seenDeclarations.has(cell.id))fail('namespace cell declaration is repeated');
        seenDeclarations.add(cell.id);
        add(node.init,body=>observerLocal+'.cellInitialize('+JSON.stringify(cell.id)+','+
          JSON.stringify(cell.loweredName)+',('+body+'))');
      }
      if(node.type==='AssignmentExpression'&&node.left?.type==='Identifier'&&backed.has(node.left.name)){
        const cell=backed.get(node.left.name);
        if(node.operator!=='=')fail('namespace cell write must be a simple assignment');
        if(cell.kind!=='let')fail('immutable namespace cell write is unsupported');
        add(node,body=>observerLocal+'.cellWrite('+JSON.stringify(cell.id)+','+
          JSON.stringify(cell.loweredName)+',('+body+'))');
      }
      if(node.type==='UpdateExpression'&&node.argument?.type==='Identifier'&&backed.has(node.argument.name))
        fail('namespace cell update is unsupported');
      for(const [childKey,value]of Object.entries(node)){
        if(['start','end','loc','range','raw','regex'].includes(childKey))continue;
        if(node.type==='MemberExpression'&&childKey==='property'&&!node.computed)continue;
        if(node.type==='Property'&&childKey==='key'&&!node.computed)continue;
        if(value&&typeof value==='object')walk(value,node,childKey,parent);
      }
    }
    walk(ast);
    for(const alias of aliases.keys())if(!seenAliases.has(alias))fail('namespace import is not used by a supported operation');
    for(const cell of cellRows)if(!seenDeclarations.has(cell.id))
      fail('namespace export cell declaration is missing from source');
    let sourceWithEdits=renderEdits(source,edits);
    let insertion=source.startsWith('#!')?source.indexOf('\n')+1:0;
    if(insertion<0)insertion=0;
    const importText='import '+observerLocal+' from '+JSON.stringify(observerSpecifier)+';\n';
    output[file]=sourceWithEdits.slice(0,insertion)+importText+sourceWithEdits.slice(insertion);
  }
  if(![...namespaceFiles].every(file=>[...namespaceImports.values()].some(set=>set.has(file))))
    fail('planned namespace is not targeted by an original namespace import');
  return {modules:output,plan,namespaces:canonical.namespaces,exportsByFile:canonical.exportsByFile};
}
