// Host-side TypeScript syntax lowering, not a guest execution path.
// The resulting ES2022 source is parsed and executed solely by the owned
// training-js/1 interpreter. The original TS text is never evaluated by Node.
import ts from 'typescript';
import {SourceMap} from 'node:module';

const COMPILER='typescript/'+ts.version;
export function compileBoundedTypeScript(text,{path='trace.ts'}={}) {
  if(typeof text!=='string'||text.length>131072)
    throw new TypeError('TypeScript source must be bounded text');
  // Keep optional syntax in the pinned ES2022 output. The owned frontend
  // records its nullish branches directly, rather than executing TypeScript
  // emitter temporaries. Receiver-sensitive optional method calls fail closed.
  const sourceFile=path.endsWith('.tsx')?'natlang-trace.tsx':'natlang-trace.ts';
  const options={
    target:ts.ScriptTarget.ES2022,
    module:ts.ModuleKind.ES2022,
    sourceMap:true,inlineSources:true,
    newLine:ts.NewLineKind.LineFeed,
    removeComments:false,isolatedModules:true,
    noEmitHelpers:true
  };
  const result=ts.transpileModule(text,{fileName:sourceFile,
    compilerOptions:options,reportDiagnostics:true});
  const errors=(result.diagnostics??[]).filter(d=>
    d.category===ts.DiagnosticCategory.Error);
  if(errors.length)throw new SyntaxError(errors.map(d=>
    ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
  if(typeof result.outputText!=='string'||!result.sourceMapText)
    throw new Error('TypeScript compiler did not emit an auditable source map');
  // The JS is intentionally not accepted here. The caller MUST compile via
  // parseTraining and never fall back to a native execution engine.
  return {javascript:result.outputText,
    sourceMap:JSON.parse(result.sourceMapText),compiler:COMPILER};
}

// Supplemental, non-authoritative generated -> TS mapping evidence. The
// source map is produced by a pinned TS compiler, not independent proof that
// transformed source sites preserve all original TypeScript semantics.
export function mapBoundedTypeScriptSites(lowering,sites,originalText) {
  if(lowering?.sourceMap?.version!==3 ||
     !Array.isArray(lowering.sourceMap.sourcesContent) ||
     !lowering.sourceMap.sourcesContent.includes(originalText))
    throw new TypeError('TypeScript map does not bind the original source bytes');
  if(!Array.isArray(sites)||typeof lowering.javascript!=='string')
    throw new TypeError('TypeScript site map requires generated source sites');
  const map=new SourceMap(lowering.sourceMap);
  function position(text,offset) {
    if(!Number.isSafeInteger(offset)||offset<0||offset>=text.length)return null;
    const before=text.slice(0,offset);
    const last=before.lastIndexOf('\n');
    return {line:before.split('\n').length-1,column:offset-last-1};
  }
  function resolve(offset) {
    const place=position(lowering.javascript,offset);
    if(!place)return null;
    const entry=map.findEntry(place.line,place.column);
    if(entry?.originalSource==null||entry.originalLine==null||
       entry.originalColumn==null)return null;
    const lines=originalText.split('\n');
    if(!Number.isInteger(entry.originalLine)||entry.originalLine<0||
       entry.originalLine>=lines.length||entry.originalColumn<0||
       entry.originalColumn>lines[entry.originalLine].length)return null;
    return {line:entry.originalLine,column:entry.originalColumn,
      source:entry.originalSource};
  }
  return sites.map(site=>{
    const start=resolve(site.start),end=resolve(site.end-1);
    return {siteId:site.siteId,generated:{start:site.start,end:site.end},
      status:start&&end&&start.source===end.source?'anchors':'generated-only',
      originalStart:start,originalEnd:end};
  });
}
