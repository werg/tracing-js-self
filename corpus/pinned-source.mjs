// Shared pinned-source extraction for native observation and owned verification.
// Original vendored code and explicitly listed declarations are never rewritten.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import ts from 'typescript';
import {sources} from './cases.mjs';

const cache=new Map();
// Pull the literal upstream declarations for dependencies, without rewriting
// or mocking production code. The named dependencies are inspectable and pinned.
const helperNames={
  'arrays.ts/binarySearch':['binarySearch2'],
  'arrays.ts/insertInto':['getActualStartIndex'],
  'arrays.ts/splice':['getActualStartIndex','insertInto'],
  'strings.ts/format':['_formatRegexp'],
  'strings.ts/format2':['_format2Regexp'],
  'strings.ts/trim':['ltrim','rtrim'],
  'strings.ts/firstNonWhitespaceIndex':['CharCode'],
  'strings.ts/getLeadingWhitespace':['CharCode'],
  'strings.ts/lastNonWhitespaceIndex':['CharCode'],
  'strings.ts/getIndentationLength':['firstNonWhitespaceIndex','CharCode'],
  'strings.ts/isBasicASCII':['IS_BASIC_ASCII'],
  'strings.ts/containsRTL':['CONTAINS_RTL','makeContainsRtl']
};
export function original(spec){
  const path=resolve('corpus/upstream',spec.project,spec.file);
  if(!cache.has(path))cache.set(path,readFileSync(path,'utf8'));
  const text=cache.get(path);
  const source=sources[spec.project];
  if(!source)throw new TypeError('Unknown source project');
  if(spec.project==='lodash')return {text,path,sourceFile:text,
    sourceURL:'https://github.com/lodash/lodash/blob/'+source.revision+'/'+spec.file};
  const file=ts.createSourceFile(spec.file,text,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
  const originalFunction=file.statements.find(node=>ts.isFunctionDeclaration(node)&&
    node.name?.text===spec.entry&&node.body);
  if(!originalFunction)throw new Error('Missing original TypeScript implementation '+spec.entry);
  const extras=[];
  const depends=helperNames[spec.file+'/'+spec.entry]??[];
  for(const name of depends){
    let owner=file,document=text;
    if(name==='CharCode'){
      const filename='corpus/upstream/vscode/charCode.ts';
      document=readFileSync(filename,'utf8');
      owner=ts.createSourceFile(filename,document,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
    }
    const declaration=owner.statements.find(node=>
      ts.isFunctionDeclaration(node)&&node.body&&node.name?.text===name||
      ts.isEnumDeclaration(node)&&node.name.text===name||
      ts.isVariableStatement(node)&&node.declarationList.declarations.some(
        d=>ts.isIdentifier(d.name)&&d.name.text===name));
    if(!declaration)throw new Error('Unpinned source dependency '+name+' for '+spec.entry);
    extras.push(declaration.getText(owner));
  }
  return {text:[...extras,originalFunction.getText(file)].join('\n\n'),
    path,sourceFile:text,
    sourceURL:'https://github.com/microsoft/vscode/blob/'+source.revision+
      '/'+source.sourcePrefix+spec.file};
}

export function corpusSplit(key){
  const n=parseInt(createHash('sha256').update(key).digest('hex').slice(0,8),16)%10;
  return n===0?'test':n<=2?'validation':'train';
}

// Compile-time lowering of the pinned VS Code `const enum` used by four
// whitespace helpers. TypeScript erases const enums in a full compile; the
// single-file transpileModule bridge instead produces a 25KB runtime enum.
// This transformer replaces *only verified enum member references* with their
// original numeric compile-time values, leaving the production functions and
// their actual runtime control flow intact. No runtime JS or host fallback.
export function lowerPinnedCharCode(spec,source){
  const families=new Set(['firstNonWhitespaceIndex','getLeadingWhitespace',
    'lastNonWhitespaceIndex','getIndentationLength']);
  if(spec.project!=='vscode'||spec.file!=='strings.ts'||!families.has(spec.entry))
    return {text:source,lowering:null};
  const sf=ts.createSourceFile(spec.file,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
  const en=sf.statements.filter(ts.isEnumDeclaration);
  if(en.length!==1||en[0].name.text!=='CharCode'||
     !en[0].modifiers?.some(m=>m.kind===ts.SyntaxKind.ConstKeyword))
    throw new SyntaxError('Pinned const enum dependency mismatch');
  const values=new Map();
  for(const member of en[0].members){
    const name=member.name.text;
    if(!ts.isNumericLiteral(member.initializer))continue;
    values.set(name,Number(member.initializer.text));
  }
  if(values.get('Space')!==32||values.get('Tab')!==9)
    throw new SyntaxError('Pinned whitespace enum constants mismatch');
  const originals=sf.statements.filter(ts.isFunctionDeclaration);
  if(!originals.length)throw new SyntaxError('Missing compiled function for enum lowering');
  const used=new Set();
  const transformer=context=>{
    const visit=node=>{
      if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&
         node.expression.text==='CharCode'){
        const name=node.name.text;
        if(!values.has(name))throw new SyntaxError('Unmodeled CharCode member '+name);
        used.add(name);
        return ts.factory.createNumericLiteral(values.get(name));
      }
      if(ts.isIdentifier(node)&&node.text==='CharCode' &&
         !ts.isPropertyAccessExpression(node.parent))
        throw new SyntaxError('Nonmember use of a compile-time enum');
      return ts.visitEachChild(node,visit,context);
    };
    return node=>ts.visitNode(node,visit);
  };
  const input=ts.factory.updateSourceFile(sf,originals);
  const result=ts.transform(input,[transformer]);
  const text=ts.createPrinter().printFile(result.transformed[0]);
  result.dispose();
  if(!used.has('Space')||!used.has('Tab'))
    throw new SyntaxError('Required whitespace source constants are unused');
  return {text,lowering:{kind:'pinned-typescript-const-enum-inlining/1',
    sourceMember:'CharCode',
    pinnedDependencySha256:createHash('sha256').update(
      readFileSync(resolve('corpus/upstream/vscode/charCode.ts'),'utf8')).digest('hex'),
    constants:Object.fromEntries([...used].sort().map(x=>[x,values.get(x)]))}};
}
