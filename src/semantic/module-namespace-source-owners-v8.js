// Private source-owner map for the experimental namespace projector.
// It binds runtime call-site identities to exact generated initializer AST nodes;
// callers still need fresh module relinking before this map can authorize use.
import {parse} from 'acorn';
import {deriveExperimentalModuleNamespaceSourceSites} from './module-namespace-source-sites-v8.js';

const fail=message=>{throw new TypeError('Experimental module namespace owners: '+message);};
const cmp=(a,b)=>a<b?-1:a>b?1:0;

export function deriveExperimentalModuleNamespaceOwnersV8({source,moduleNamespacePlan,bundle}={}){
  if(typeof source!=='string'||!bundle||!Array.isArray(bundle.sites)||
     (!bundle.programs||typeof bundle.programs!=='object'||Array.isArray(bundle.programs)))fail('exact generated source and owned archive are required');
  const checked=deriveExperimentalModuleNamespaceSourceSites({source,moduleNamespacePlan});
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'}),declarations=new Map();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&
       node.init?.type==='CallExpression'&&node.init.callee?.type==='Identifier'&&
       node.init.callee.name==='__traced_eval_create_module_namespace')
      declarations.set(node.id.name,node);
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value);
  }
  visit(ast);
  const owners=[];
  for(const site of checked){
    const declaration=declarations.get(site.namespaceName),call=declaration?.init;
    if(!call||call.arguments.length!==1)fail('initializer callsite is missing');
    const matches=bundle.sites.filter(row=>row.start===call.start&&row.end===call.end);
    if(matches.length!==1)fail('initializer callsite does not map to one owned source site');
    const exports=site.exports.map(row=>{
      const getterSites=bundle.sites.filter(candidate=>candidate.start===row.getterStart&&candidate.end===row.getterEnd);
      // The closure body and generated getter call are different sites. Keep
      // the AST byte ranges here; the runtime archive's function inventory
      // later confirms the exact lowered binding read for each getter.
      if(getterSites.length>1)fail('getter source range maps ambiguously');
      return {...row,getterSiteId:getterSites[0]?.siteId??null};
    });
    owners.push({file:site.file,namespaceName:site.namespaceName,
      declarationStart:site.start,declarationEnd:site.end,
      callStart:call.start,callEnd:call.end,siteId:matches[0].siteId,exports});
  }
  owners.sort((a,b)=>cmp(a.callStart,b.callStart));
  if(new Set(owners.map(row=>row.siteId)).size!==owners.length)
    fail('multiple namespaces share one initializer callsite');
  return owners;
}
