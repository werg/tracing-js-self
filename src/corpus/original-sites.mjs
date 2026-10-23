// Auditable per-span source provenance for the conservative Exercism
// function-entry projection. This maps genuine unchanged token spans only:
// synthetic 'function', 'return', wrapper parentheses and the strict prologue
// have NO original source coordinate and are never guessed.
import ts from 'typescript';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const parse=(s)=>ts.createSourceFile('proof.ci.js',s,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
const nameOf=statement=>{
 if(ts.isFunctionDeclaration(statement))return statement.name?.text;
 if(ts.isVariableStatement(statement)&&statement.declarationList.declarations.length===1)
   return statement.declarationList.declarations[0].name?.text;
 return null;
};
function bodyOf(statement){
 if(ts.isFunctionDeclaration(statement))return statement.body;
 if(ts.isVariableStatement(statement)){
   const init=statement.declarationList.declarations[0]?.initializer;
   if(init&&ts.isArrowFunction(init))return init.body;
 }
 return null;
}
function paramsOf(statement){
 if(ts.isFunctionDeclaration(statement))return statement.parameters;
 if(ts.isVariableStatement(statement)){
   const init=statement.declarationList.declarations[0]?.initializer;
   if(init&&ts.isArrowFunction(init))return init.parameters;
 }
 return [];
}
export function buildOwnedSourceMap(original,lowered){
 const a=parse(original),b=parse(lowered);
 if(a.parseDiagnostics.length||b.parseDiagnostics.length)throw new SyntaxError('Invalid source-site map inputs');
 const o=new Map(a.statements.map(s=>[nameOf(s),s]).filter(([n])=>n));
 const segments=[];
 const insert=(generatedStart,generatedEnd,originalStart,originalEnd,owner)=>{
   const first=lowered.slice(generatedStart,generatedEnd);
   const second=original.slice(originalStart,originalEnd);
   if(!first||first!==second)throw new Error('Source-site mapping requires unchanged original bytes: '+owner);
   segments.push({generatedStart,generatedEnd,originalStart,originalEnd,owner});
 };
 for(const fn of b.statements.filter(ts.isFunctionDeclaration)){
   const originalFn=o.get(fn.name?.text),body=originalFn&&bodyOf(originalFn);
   if(!body)throw new Error('No original callable source site for '+fn.name?.text);
   const originalBody=body.getText(a),start=fn.body.getStart(b),end=fn.body.end;
   const offset=lowered.slice(start,end).indexOf(originalBody);
   if(offset<0)throw new Error('Cannot anchor original body for '+fn.name.text);
   insert(start+offset,start+offset+originalBody.length,body.getStart(a),body.end,fn.name.text);
   const origParams=paramsOf(originalFn);
   if(origParams.length!==fn.parameters.length)throw new Error('Function parameter transformation mismatch');
   for(let i=0;i<origParams.length;i++){
     const p=origParams[i],q=fn.parameters[i];
     insert(q.getStart(b),q.end,p.getStart(a),p.end,fn.name.text+':param:'+i);
   }
 }
 segments.sort((x,y)=>x.generatedStart-y.generatedStart);
 for(let i=1;i<segments.length;i++){
   if(segments[i].generatedStart<segments[i-1].generatedEnd)
     throw new Error('Overlapping source-site map segments');
 }
 return {schema:'owned-original-sites/1',originalSha256:sha(original),
   generatedSha256:sha(lowered),segments};
}
export function mapSourceSite(sourceMap,start,end){
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start)return null;
 const s=sourceMap.segments.find(x=>x.generatedStart<=start&&end<=x.generatedEnd);
 if(!s)return null;
 const p=s.originalStart+(start-s.generatedStart);
 return {start:p,end:p+(end-start),owner:s.owner};
}
export function auditSourceSites(sourceMap,semantic,original,lowered){
 if(sha(original)!==sourceMap.originalSha256||sha(lowered)!==sourceMap.generatedSha256)
   throw new Error('Source bytes changed after original-site mapping');
 const receipts=[],totals={total:0,mapped:0,syntheticOrCrossBoundary:0,unlocated:0};
 const ids=new Set();
 for(const e of semantic.events){
   const s=e.source;
   if(!s){totals.unlocated++;continue;}
   totals.total++;
   const mapped=mapSourceSite(sourceMap,s.start,s.end);
   if(!mapped){totals.syntheticOrCrossBoundary++;continue;}
   if(lowered.slice(s.start,s.end)!==original.slice(mapped.start,mapped.end))
     throw new Error('Mapped semantic site did not retain original bytes');
   if(ids.has(e.id))throw new Error('Duplicate semantic event mapping');
   ids.add(e.id);totals.mapped++;
   receipts.push({event:e.id,site:e.site,generated:{start:s.start,end:s.end},
     original:{start:mapped.start,end:mapped.end},owner:mapped.owner});
 }
 return {schema:'owned-source-site-audit/1',totals,receipts,
   valid:true,scope:'literal-original-token-spans-only',
   unmappedPolicy:'retain-lowered-source-site-with-explicit-synthetic-refusal'};
}
