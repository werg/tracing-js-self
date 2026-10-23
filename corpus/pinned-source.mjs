// Shared pinned-source extraction for native observation and owned verification.
// Original vendored code and explicitly listed declarations are never rewritten.
import {readFileSync} from 'node:fs';
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
