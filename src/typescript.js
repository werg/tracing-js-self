// Host-side TypeScript syntax lowering, not a guest execution path.
// The resulting ES2022 source is parsed and executed solely by the owned
// training-js/1 interpreter. The original TS text is never evaluated by Node.
import ts from 'typescript';

const COMPILER='typescript/'+ts.version;
export function compileBoundedTypeScript(text,{path='trace.ts'}={}) {
  if(typeof text!=='string'||text.length>131072)
    throw new TypeError('TypeScript source must be bounded text');
  // No downlevel JS helpers, eval, injected module loader or host runtime.
  const options={
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,
    sourceMap:true,inlineSources:true,
    newLine:ts.NewLineKind.LineFeed,
    removeComments:false,isolatedModules:true,
    noEmitHelpers:true
  };
  const sourceFile=path.endsWith('.tsx')?'natlang-trace.tsx':'natlang-trace.ts';
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
