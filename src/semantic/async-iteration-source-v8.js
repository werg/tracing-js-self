// The two language-created AsyncFromSync methods have no FunctionExpression
// in the source. Their immutable identities are the original awaited loop and
// their exact specification role, never a new source text or invented site.
import {parse} from 'acorn';
const roles=new Set(['async-from-sync-next','async-from-sync-return']);
export function asyncIterationSourceSitesV8(source){
  const sites=new Set();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='ForOfStatement'&&node.await)sites.add(node.start+':'+node.end);
    for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));return sites;
}
export function asyncIterationSourceCodeV8(role,start,end,sites){
  if(!roles.has(role)||!sites.has(start+':'+end))throw new TypeError('Async iterator helper lacks its exact original awaited loop');
  return role+':'+start+':'+end;
}
export function hasAsyncIterationSourceCallableV8(source,code){
  const match=/^(async-from-sync-(?:next|return)):([0-9]+):([0-9]+)$/.exec(code);
  return Boolean(match&&asyncIterationSourceSitesV8(source).has(match[2]+':'+match[3]));
}
