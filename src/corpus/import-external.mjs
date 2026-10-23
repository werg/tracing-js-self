// External JS/TS source and test-input acquisition. No guest code is evaluated.
// Records are DISCOVERY FIXTURES, never owned semantic traces or admitted examples.
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {relative, resolve, join, sep, extname} from 'node:path';
import ts from 'typescript';

const sha = value => createHash('sha256').update(value).digest('hex');
const normalize = p => p.split(sep).join('/');
const ensure = (ok, why) => {if(!ok)throw new Error(why);};
const pathIn = (root, p) => {
  const rel=relative(root,p);
  ensure(rel!==''&&!rel.startsWith('..'+sep)&&rel!=='..'&&!rel.startsWith(sep),
    'Path escapes fixture root: '+p);
  return normalize(rel);
};
export function frozenSplit(project) {
  const n=parseInt(sha(project).slice(0,8),16)%10;
  return n===0?'test':n<=2?'validation':'train';
}
export async function* walk(root) {
  const names=(await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of names) {
    if(entry.name.startsWith('.')||['node_modules','.git','vendor','dist','build'].includes(entry.name))continue;
    const file=join(root,entry.name);
    if(entry.isDirectory())yield* walk(file);
    else if(entry.isFile())yield file;
  }
}
const array = text => {
  const trimmed=text.trim();
  if(trimmed.startsWith('[')&&trimmed.endsWith(']'))
    return trimmed.slice(1,-1).split(',').map(x=>x.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean);
  return trimmed? [trimmed.replace(/^['"]|['"]$/g,'')]:[];
};
// Parse only the Test262 metadata fields needed to route cases. Unknown YAML is
// retained as source text; never interpret it as successful executable evidence.
export function test262Metadata(source) {
  const m=/\/\*---\r?\n([\s\S]*?)\r?\n---\*\//.exec(source);
  if(!m)return {flags:[],includes:[],features:[],negative:null,metadataStatus:'missing'};
  const body=m[1], fields={};
  let key=null;
  for(const line of body.split(/\r?\n/)){
    const top=/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if(top){key=top[1];fields[key]=top[2]??'';continue;}
    const item=/^\s+-\s+(.+)$/.exec(line);
    if(item&&key&&['includes','features','flags'].includes(key)){
      if(!Array.isArray(fields[key]))fields[key]=array(fields[key]);
      fields[key].push(...array(item[1]));
    }
  }
  const neg=/^negative:[ \t]*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m.exec(body)?.[1]??null;
  const phase=/^[ \t]+phase:[ \t]*(\S+)/m.exec(neg??'')?.[1]??null;
  const type=/^[ \t]+type:[ \t]*(\S+)/m.exec(neg??'')?.[1]??null;
  return {
    flags:Array.isArray(fields.flags)?fields.flags:array(fields.flags??''),
    includes:Array.isArray(fields.includes)?fields.includes:array(fields.includes??''),
    features:Array.isArray(fields.features)?fields.features:array(fields.features??''),
    negative:phase&&type?{phase,type}:null,
    metadataStatus:neg!==null&&(!phase||!type)?'unparsed-negative':'parsed'
  };
}
const enrich = (source, filename, program, fixture, expected, extra={}) => {
  const project=extra.project;
  ensure(typeof project==='string'&&project.length>0,'Missing source project');
  ensure(/^[a-f0-9]{40}$/.test(extra.revision),'Require full 40-character revision');
  ensure(typeof extra.license==='string'&&extra.license.length>0,'Missing source license');
  const digest=sha(source);
  const identity=sha(JSON.stringify([project,extra.revision,filename,
    program,fixture,expected]));
  return {
    schema:'external-corpus-fixture/1',authority:'acquired-fixture-only',
    admitted:false,verified:false,id:identity,project,split:frozenSplit(project),
    provenance:{repository:extra.repository,revision:extra.revision,license:extra.license,
      path:filename,sha256:digest,inputOrigin:extra.origin},
    program,fixture,expected,
    hardness:extra.details?.hardness??(['test262-program','parameterized-test','upstream-test-declaration'].includes(program?.kind)?
      hardness(source,filename):{features:[],nodeCount:0,maxDepth:0,score:0}),...extra.details
  };
};
// Static triage hints: these are NOT dynamic coverage or a complete parser.
export function hardness(source, filename='fixture.js') {
  const sf=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,
    /\.(ts|tsx|mts|cts)$/i.test(filename)?ts.ScriptKind.TS:ts.ScriptKind.JS);
  const counts=Object.create(null);
  const kinds=new Map([
    [ts.SyntaxKind.TryStatement,'try-catch-finally'],
    [ts.SyntaxKind.ThrowStatement,'throws'],
    [ts.SyntaxKind.AwaitExpression,'await'],
    [ts.SyntaxKind.YieldExpression,'generator'],
    [ts.SyntaxKind.NewExpression,'constructors'],
    [ts.SyntaxKind.ClassDeclaration,'classes'],
    [ts.SyntaxKind.GetAccessor,'accessors'],
    [ts.SyntaxKind.SetAccessor,'accessors'],
    [ts.SyntaxKind.RegularExpressionLiteral,'regexp'],
    [ts.SyntaxKind.ImportDeclaration,'esm'],
    [ts.SyntaxKind.DynamicImportKeyword,'dynamic-import'],
    [ts.SyntaxKind.ForOfStatement,'iterators'],
    [ts.SyntaxKind.WithStatement,'with-statement'],
    [ts.SyntaxKind.PrivateIdentifier,'private-fields']
  ]);
  let nodes=0, depth=0, maxDepth=0;
  const visit=(node,level)=>{
    nodes++;depth=level;maxDepth=Math.max(maxDepth,depth);
    const label=kinds.get(node.kind);
    if(label)counts[label]=(counts[label]??0)+1;
    ts.forEachChild(node,child=>visit(child,level+1));
  };
  visit(sf,0);
  for(const [re,label] of [
    [/\bProxy\s*\(/g,'proxy'],[/\bReflect\./g,'reflect'],
    [/\bPromise\./g,'promises'],[/\b(?:queueMicrotask|setTimeout)\s*\(/g,'scheduler'],
    [/\b(?:Map|Set|WeakMap|WeakSet)\s*\(/g,'collections'],
    [/\bObject\.defineProperty\s*\(/g,'descriptors'],
    [/\b(?:require|import)\s*\(/g,'module-load'],
    [/\b(?:getReader|pipeTo|pipeThrough)\s*\(/g,'streams']
  ]) if(re.test(source))counts[label]=(counts[label]??0)+1;
  const features=Object.keys(counts).sort();
  return {features,nodeCount:nodes,maxDepth,score:features.length*3+
    Math.min(10,Math.floor(nodes/100))+Math.min(10,Math.floor(maxDepth/10))};
}
export async function* test262(root, options) {
  const base=resolve(root);
  for await(const file of walk(join(base,'test'))){
    if(extname(file)!=='.js')continue;
    const filename=pathIn(base,file);
    const source=await readFile(file,'utf8'), meta=test262Metadata(source);
    const flags=meta.flags;
    const execution=flags.includes('module')?'module':'script';
    // Every variant is an independent Test262 execution configuration.
    const modes=flags.includes('raw')?['raw']:
      flags.includes('module')?['module']:
      flags.includes('onlyStrict')?['strict']:
      flags.includes('noStrict')?['sloppy']:['sloppy','strict'];
    for(const mode of modes)yield enrich(source,filename,
      {kind:'test262-program',goal:execution,mode,sourceFile:filename,
        harness:flags.includes('raw')?[]:['assert.js','sta.js',...meta.includes],
        flags,features:meta.features},
      {kind:'embedded-input',args:[]},
      {kind:meta.negative?'expected-error':'test262-assertions',
        ...(meta.negative?meta.negative:{})},
      {...options,origin:'upstream-test262',details:{
        status:meta.metadataStatus==='parsed'?'requires-harness':'metadata-review'}});
  }
}
function casesIn(value,ancestor=[]) {
  if(!value||typeof value!=='object')return [];
  const rows=[];
  if(Array.isArray(value))for(const item of value)rows.push(...casesIn(item,ancestor));
  else{
    const desc=[...ancestor,...(typeof value.description==='string'?[value.description]:[])];
    if('input'in value&&'expected'in value)
      rows.push({id:String(value.uuid??desc.join(' / ')),property:value.property??null,
        input:value.input,expected:value.expected,description:desc});
    if(Array.isArray(value.cases))rows.push(...casesIn(value.cases,desc));
  }
  return rows;
}
export async function* exercism(root,options) {
  const base=resolve(root);
  for await(const file of walk(join(base,'exercises'))){
    if(file.split(sep).at(-1)!=='canonical-data.json')continue;
    const filename=pathIn(base,file), source=await readFile(file,'utf8');
    let parsed;try{parsed=JSON.parse(source);}catch{continue;}
    for(const row of casesIn(parsed)){
      yield enrich(source,filename,{kind:'exercise-contract',
        slug:filename.split('/').at(-2),property:row.property},
      {kind:'canonical-input',id:row.id,input:row.input},
      {kind:'canonical-expected',value:row.expected}, {...options,
        origin:'exercism-canonical-data',details:{status:'requires-solution',
          description:row.description}});
    }
  }
}
export async function* jsonSchema(root,options) {
  const base=resolve(root);
  const candidate=join(base,'tests');
  for await(const file of walk(candidate)){
    if(extname(file)!=='.json')continue;
    const filename=pathIn(base,file), source=await readFile(file,'utf8');
    let groups;try{groups=JSON.parse(source);}catch{continue;}
    if(!Array.isArray(groups))continue;
    for(const [groupIndex,group] of groups.entries()){
      if(!Array.isArray(group.tests)||!('schema'in group))continue;
      for(const [testIndex,t] of group.tests.entries()){
        if(typeof t.valid!=='boolean'||!('data'in t))continue;
        yield enrich(source,filename,{kind:'json-schema-contract',
          draft:filename.split('/')[1]??null,description:group.description??''},
        {kind:'schema-validation',schema:group.schema,data:t.data,
          groupIndex,testIndex},
        {kind:'validity',valid:t.valid}, {...options,origin:'json-schema-tests',
          details:{status:'requires-validator',description:t.description??''}});
      }
    }
  }
}
export async function* commonmark(root,options) {
  const base=resolve(root);
  const file=join(base,'spec.json'), source=await readFile(file,'utf8');
  const rows=JSON.parse(source);
  ensure(Array.isArray(rows),'Expected CommonMark spec.json array');
  for(const [index,t] of rows.entries()){
    if(typeof t.markdown!=='string'||typeof t.html!=='string')continue;
    yield enrich(source,'spec.json',{kind:'commonmark-contract',
      section:t.section??null,example:t.example??index},
    {kind:'markdown-input',markdown:t.markdown},
    {kind:'rendered-html',html:t.html}, {...options,origin:'commonmark-spec',
      details:{status:'requires-renderer'}});
  }
}
function literal(node) {
  if(ts.isParenthesizedExpression(node))return literal(node.expression);
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
  if(ts.isNumericLiteral(node))return Number(node.text.replace(/_/g,''));
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false;
  if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isPrefixUnaryExpression(node)&&
     [ts.SyntaxKind.MinusToken,ts.SyntaxKind.PlusToken].includes(node.operator)){
    const n=literal(node.operand);
    if(typeof n==='number')return node.operator===ts.SyntaxKind.MinusToken?-n:n;
  }
  if(ts.isArrayLiteralExpression(node))return node.elements.map(literal);
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(p=>{
    if(!ts.isPropertyAssignment(p)||p.name.kind===ts.SyntaxKind.ComputedPropertyName)
      throw new Error('Dynamic object property');
    const name=ts.isIdentifier(p.name)||ts.isStringLiteral(p.name)||
      ts.isNumericLiteral(p.name)?p.name.text:null;
    if(name===null)throw new Error('Unsupported key');
    return [name,literal(p.initializer)];
  }));
  throw new Error('Nonliteral test table');
}
export async function* parameterizedTests(root,options) {
  const base=resolve(root);
  for await(const file of walk(base)){
    if(!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))continue;
    const filename=pathIn(base,file), source=await readFile(file,'utf8');
    const sf=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
    const found=[];
    const visit=node=>{
      if(ts.isCallExpression(node)&&ts.isCallExpression(node.expression)){
        const inner=node.expression,callee=inner.expression;
        if(ts.isPropertyAccessExpression(callee)&&callee.name.text==='each'&&
            ts.isIdentifier(callee.expression)&&
            ['test','it'].includes(callee.expression.text)&&inner.arguments.length===1){
          const title=node.arguments[0];
          if(title&&(ts.isStringLiteral(title)||ts.isNoSubstitutionTemplateLiteral(title))){
            try{
              const table=literal(inner.arguments[0]);
              if(Array.isArray(table))
                for(const [index,args] of table.entries())
                  found.push({index,title:title.text,args});
            }catch{/* Nonliteral data is intentionally rejected. */}
          }
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(sf);
    for(const row of found)yield enrich(source,filename,
      {kind:'parameterized-test',framework:'jest-or-vitest',
        sourceFile:filename,title:row.title},
      {kind:'test-each-row',index:row.index,args:row.args},
      {kind:'upstream-test-assertions'}, {...options,origin:'upstream-test-each',
        details:{status:'requires-test-runner'}});
  }
}

// Offline test inventory only: source ranges are UTF-16 offsets in original code.
// No upstream test body, expression or dependency is evaluated by this importer.
function catalogApi(expr,bases){
 const modifiers=[];
 while(ts.isPropertyAccessExpression(expr)){
  modifiers.unshift(expr.name.text);expr=expr.expression;
 }
 const allowed=['skip','only','todo','concurrent','failing','each','serial','test'];
 if(modifiers.some(x=>!allowed.includes(x)))return null;
 if(ts.isIdentifier(expr)&&bases.includes(expr.text))return {api:expr.text,modifiers};
 if(ts.isIdentifier(expr)&&['Deno','QUnit'].includes(expr.text)&&modifiers.join('.')==='test'&&
    bases.includes('test'))return {api:expr.text+'.test',modifiers:[]};
 return null;
}
function catalogTitle(arg){
 if(!arg)return null;
 if(ts.isStringLiteral(arg)||ts.isNoSubstitutionTemplateLiteral(arg))
  return arg.text;
 if(ts.isObjectLiteralExpression(arg)){
  const p=arg.properties.find(x=>ts.isPropertyAssignment(x)&&
    (ts.isIdentifier(x.name)||ts.isStringLiteral(x.name))&&x.name.text==='name');
  if(p)return catalogTitle(p.initializer);
 }
 return null;
}
function catalogPortable(value){
 if(typeof value==='number')return Number.isFinite(value)&&!Object.is(value,-0);
 if(value===null||typeof value==='string'||typeof value==='boolean')return true;
 if(Array.isArray(value))return value.every(catalogPortable);
 if(value&&typeof value==='object')return Object.values(value).every(catalogPortable);
 return false;
}
function catalogTest(expr){
 if(ts.isCallExpression(expr)){
  const api=catalogApi(expr.expression,['test','it','specify']);
  if(api&&api.modifiers.at(-1)==='each')
   return {api,kind:'table',table:expr.arguments[0]};
 }
 if(ts.isTaggedTemplateExpression(expr)){
  const api=catalogApi(expr.tag,['test','it','specify']);
  if(api&&api.modifiers.at(-1)==='each')return {api,kind:'dynamic-table'};
 }
 const api=catalogApi(expr,['test','it','specify']);
 if(api&&!api.modifiers.includes('each'))return {api,kind:'single'};
 return null;
}
export async function* testCatalog(root,options){
 const base=resolve(root);
 for await(const file of walk(base)){
  const filename=pathIn(base,file);
   // Accept Deno *_test.ts and conventional Mocha/QUnit test/*.js suites.
   // This inventories declarations only; it never runs test source.
   const named=/(?:^|\/)(?:__tests__\/[^/]+|[^/]+\.(?:test|spec)|[^/]+_test)\.[cm]?[jt]sx?$/i.test(filename);
   const tree=/(?:^|\/)test\/(?:[^/]+\/)*[^/]+\.[cm]?[jt]sx?$/i.test(filename);
   if(!named&&!tree)continue;
  const source=await readFile(file,'utf8');
  const sf=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,
    ts.getScriptKindFromFileName(filename));
  const found=[];
  const visit=(node,ctx)=>{
   if(ts.isCallExpression(node)){
    const direct=catalogApi(node.expression,['describe','suite']);
    const inner=ts.isCallExpression(node.expression)?
      catalogApi(node.expression.expression,['describe','suite']):null;
    const tableSuite=Boolean(inner?.modifiers.includes('each'));
    if(direct||tableSuite){
     const title=catalogTitle(node.arguments[0]);
     const callback=node.arguments.find(x=>ts.isArrowFunction(x)||ts.isFunctionExpression(x));
     if(callback){
      visit(callback.body,{names:[...ctx.names,title??'[dynamic suite]'],
       dynamic:ctx.dynamic||tableSuite||title===null,
       disabled:ctx.disabled||Boolean(direct?.modifiers.includes('skip'))});
      return;
     }
    }
    const info=catalogTest(node.expression);
    if(info){
     const title=catalogTitle(node.arguments[0]);
     const start=node.getStart(sf),end=node.getEnd();
     const disabled=ctx.disabled||info.api.modifiers.includes('skip')||
       info.api.modifiers.includes('todo');
     const push=(fixture,status)=>found.push({
      title:title??'[dynamic title]',suite:ctx.names,start,end,
      api:info.api.api,modifiers:info.api.modifiers,fixture,
      status:disabled?'disabled-upstream':
       ctx.dynamic||title===null?'requires-dynamic-recording':status
     });
     if(info.kind==='single'){
      push({kind:'embedded-test-body',args:[]},'requires-test-runner');
     }else if(info.kind==='table'&&info.table){
      let rows=null;
      try{
       rows=literal(info.table);
       if(!Array.isArray(rows)||!catalogPortable(rows))rows=null;
      }catch{/* Nonliteral inputs stay as dynamic declarations. */}
      if(rows===null)push({kind:'dynamic-test-table'},'requires-dynamic-recording');
      else if(rows.length===0)push({kind:'empty-test-table'},'no-instantiated-rows');
      else rows.forEach((args,index)=>push({kind:'literal-test-each-row',index,args},
        'requires-test-runner'));
     }else push({kind:'dynamic-test-table'},'requires-dynamic-recording');
     return; // Do not count the inner .each declaration as another test.
    }
   }
   ts.forEachChild(node,child=>visit(child,ctx));
  };
  visit(sf,{names:[],dynamic:false,disabled:false});
  const sourceHardness=hardness(source,filename);
  for(const item of found)yield enrich(source,filename,{
   kind:'upstream-test-declaration',framework:'unresolved-js-ts-test-api',
   sourceFile:filename,title:item.title,suite:item.suite,
   api:item.api,modifiers:item.modifiers,
   sourceSpan:{start:item.start,end:item.end,unit:'utf16'}
  },item.fixture,{kind:'upstream-test-assertions'},
  {...options,origin:'static-test-catalog',
   details:{status:item.status,hardness:sourceHardness}});
 }
}

export const importers=Object.freeze({
  test262,exercism,'json-schema':jsonSchema,commonmark,'jest-each':parameterizedTests,
  'test-catalog':testCatalog
});
