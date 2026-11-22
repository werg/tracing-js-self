// Static source sites for the experimental, unadmitted module namespace owner.
// This verifies the linker-generated pure getter wrappers before any source
// event may be assigned to a module namespace component.
import {parse} from 'acorn';
import {verifyExperimentalModuleNamespacePlan} from './module-namespace-state-v8.js';

const fail=message=>{throw new TypeError('Experimental module namespace source sites: '+message);};

export function deriveExperimentalModuleNamespaceSourceSites({source,moduleNamespacePlan}={}){
  if(typeof source!=='string')fail('generated source text is required');
  verifyExperimentalModuleNamespacePlan(moduleNamespacePlan);
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const cells=new Map(moduleNamespacePlan.cells.map(cell=>[cell.id,cell]));
  const declarations=new Map();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child);return;}
    if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&
       node.init?.type==='CallExpression'&&node.init.callee?.type==='Identifier'&&
       node.init.callee.name==='__traced_eval_create_module_namespace'){
      const name=node.id.name;
      if(declarations.has(name))fail('namespace source binding is duplicated');
      declarations.set(name,node);
    }
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))
      visit(value);
  }
  visit(ast);
  const claimed=new Set(),sites=[];
  for(const namespace of moduleNamespacePlan.namespaces){
    if(claimed.has(namespace.namespaceName))fail('namespace source binding is reused');
    claimed.add(namespace.namespaceName);
    const declaration=declarations.get(namespace.namespaceName);
    if(!declaration||declaration.init.arguments.length!==1)
      fail('linker namespace initializer is absent or malformed for '+namespace.file);
    const list=declaration.init.arguments[0];
    if(list?.type!=='ArrayExpression'||list.elements.length!==namespace.exports.length)
      fail('namespace initializer entries differ from the source export table for '+namespace.file);
    const exports=[];
    for(let index=0;index<list.elements.length;index++){
      const pair=list.elements[index],expected=namespace.exports[index];
      if(pair?.type!=='ArrayExpression'||pair.elements.length!==2||
         pair.elements[0]?.type!=='Literal'||typeof pair.elements[0].value!=='string')
        fail('namespace initializer contains a noncanonical export entry');
      const getter=pair.elements[1],binding=cells.get(expected.cell);
      if(!binding||pair.elements[0].value!==expected.name||
         getter?.type!=='ArrowFunctionExpression'||getter.async||getter.params.length!==0||
         getter.body?.type!=='Identifier'||getter.body.name!==binding.loweredName)
        fail('namespace export getter is not a pure read of its source-owned live cell');
      exports.push({name:expected.name,cell:expected.cell,loweredName:binding.loweredName,
        getterStart:getter.start,getterEnd:getter.end});
    }
    sites.push({file:namespace.file,namespaceName:namespace.namespaceName,
      start:declaration.start,end:declaration.end,exports});
  }
  if(declarations.size!==claimed.size)
    fail('generated source contains an unplanned module namespace initializer');
  return sites;
}
