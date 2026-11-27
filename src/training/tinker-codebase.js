// Virtual multi-file JS/TS codebase support, on-demand `code.load` server,
// compact repository manifest, and in-memory single-file CJS module runner
// with causal `code.load` teacher event synthesis.
import {createHash} from 'node:crypto';
import {posix as pathPosix} from 'node:path';
import vm from 'node:vm';
import {parse} from 'acorn';
import ts from 'typescript';
import {instrumentNativeTraceSource} from './native-trace.js';

export const WHOLE_FILE_LOAD_MAX_BYTES = 3072;
export const MAX_CODEBASE_FILES = 256;
export const MAX_CODEBASE_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_CODEBASE_FILE_BYTES = 262144;
export const MAX_CODE_LOAD_BATCH = 64;

const MODULE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_TO_TS_MAP = Object.freeze({
  '.js': ['.ts', '.tsx', '.mts'],
  '.mjs': ['.mts', '.ts'],
  '.cjs': ['.cts', '.ts'],
});

const own = Object.hasOwn;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const demand = (condition, message) => { if (!condition) throw new TypeError(message); };

/** Normalize a relative repository path (POSIX forward slashes, no traversal). */
export function normalizeRepoPath(rawPath) {
  demand(typeof rawPath === 'string' && rawPath.length > 0 && rawPath.length <= 240, 'Repository file path must be a bounded string');
  demand(!rawPath.includes('\0'), 'Repository file path cannot contain null bytes');
  let cleaned = rawPath.replaceAll('\\', '/').trim();
  while (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  demand(cleaned.length > 0 && !cleaned.startsWith('/'), 'Repository file path must be relative: ' + rawPath);
  const normalized = pathPosix.normalize(cleaned);
  demand(normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.startsWith('/'),
    'Repository file path cannot escape root: ' + rawPath);
  return normalized;
}

/** Validate and normalize a task's multi-file codebase specification. */
export function normalizeCodebaseSpec(input) {
  demand(plain(input.files), 'Task files must be a plain object mapping relative paths to source strings');
  const entries = Object.entries(input.files);
  demand(entries.length >= 1 && entries.length <= MAX_CODEBASE_FILES,
    `Codebase must contain between 1 and ${MAX_CODEBASE_FILES} files`);
  const files = {};
  let totalBytes = 0;
  for (const [rawPath, content] of entries) {
    const relPath = normalizeRepoPath(rawPath);
    demand(!own(files, relPath), 'Duplicate normalized repository path: ' + relPath);
    demand(typeof content === 'string', 'File content must be a string: ' + relPath);
    const bytes = Buffer.byteLength(content, 'utf8');
    demand(bytes <= MAX_CODEBASE_FILE_BYTES, 'File exceeds size limit: ' + relPath);
    totalBytes += bytes;
    demand(totalBytes <= MAX_CODEBASE_TOTAL_BYTES, 'Total codebase size exceeds limit');
    files[relPath] = content;
  }
  const entryFile = normalizeRepoPath(input.entryFile);
  demand(own(files, entryFile), 'entryFile must exist in files: ' + entryFile);
  let initialLoadedFiles;
  if (input.initialLoadedFiles === undefined || input.initialLoadedFiles === null) {
    initialLoadedFiles = [entryFile];
  } else {
    demand(Array.isArray(input.initialLoadedFiles) && input.initialLoadedFiles.length <= MAX_CODEBASE_FILES,
      'initialLoadedFiles must be an array of repository paths');
    const seen = new Set();
    initialLoadedFiles = [];
    for (const raw of input.initialLoadedFiles) {
      const norm = normalizeRepoPath(raw);
      demand(own(files, norm), 'initialLoadedFiles entry missing from files: ' + norm);
      if (!seen.has(norm)) {
        seen.add(norm);
        initialLoadedFiles.push(norm);
      }
    }
    if (!seen.has(entryFile)) initialLoadedFiles.unshift(entryFile);
  }
  return {files, entryFile, initialLoadedFiles};
}

/** Deterministic content hash across all files in a multi-file codebase. */
export function codebaseSourceHash(files, entryFile, entry) {
  const ordered = Object.keys(files).sort().map(relPath => [relPath, files[relPath]]);
  return createHash('sha256')
    .update(JSON.stringify({entryFile, entry, files: ordered}))
    .digest('hex');
}

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1; // 1-based
}

function isRequireExpression(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') return true;
  if (node.type === 'MemberExpression') return isRequireExpression(node.object);
  return false;
}

function isSimpleConstInit(node, source) {
  if (!node) return false;
  if (['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(node.type)) return false;
  if (isRequireExpression(node)) return false;
  return (node.end - node.start) <= 400;
}

function isTsFilePath(filePath) {
  const ext = pathPosix.extname(filePath).toLowerCase();
  return TS_EXTENSIONS.has(ext);
}

function parseWithAcorn(code) {
  try {
    return parse(code, {ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, locations: true});
  } catch {
    try {
      return parse(code, {ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, locations: true});
    } catch {
      return null;
    }
  }
}

function analyzeAcornAst(ast, code, lineStarts) {
  const imports = [];
  const consts = [];
  const symbols = new Map();
  const addSymbol = (name, info) => {
    if (!name || typeof name !== 'string') return;
    const prev = symbols.get(name);
    if (!prev) {
      symbols.set(name, {name, ...info});
    } else if (info.exported && !prev.exported) {
      symbols.set(name, {...prev, exported: true});
    }
  };
  const spanInfo = (node, kind, exported) => ({
    kind,
    exported,
    start: node.start,
    end: node.end,
    startLine: node.loc?.start?.line ?? offsetToLine(lineStarts, node.start),
    endLine: node.loc?.end?.line ?? offsetToLine(lineStarts, Math.max(node.start, node.end - 1)),
  });

  function registerDeclaration(decl, outerNode, exported) {
    const node = outerNode ?? decl;
    if (!decl) return;
    if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
      addSymbol(decl.id.name, spanInfo(node, 'function', exported));
      return;
    }
    if (decl.type === 'ClassDeclaration' && decl.id?.name) {
      addSymbol(decl.id.name, spanInfo(node, 'class', exported));
      return;
    }
    if (decl.type === 'VariableDeclaration') {
      const allRequire = decl.declarations.length > 0 && decl.declarations.every(d => isRequireExpression(d.init));
      if (allRequire && !exported) {
        imports.push(spanInfo(node, 'require', false));
        return;
      }
      let allSimpleConst = decl.kind === 'const' && decl.declarations.length > 0;
      for (const d of decl.declarations) {
        if (d.id?.type === 'Identifier') {
          const initType = d.init?.type;
          const kind = (initType === 'FunctionExpression' || initType === 'ArrowFunctionExpression')
            ? 'function'
            : initType === 'ClassExpression'
              ? 'class'
              : decl.kind === 'const' ? 'const' : 'var';
          addSymbol(d.id.name, spanInfo(node, kind, exported));
          if (!isSimpleConstInit(d.init, code)) allSimpleConst = false;
        } else {
          allSimpleConst = false;
        }
      }
      if (allSimpleConst && (node.end - node.start) <= 450) {
        consts.push(spanInfo(node, 'const', exported));
      }
    }
  }

  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration') {
      imports.push(spanInfo(stmt, 'import', false));
      continue;
    }
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) {
        registerDeclaration(stmt.declaration, stmt, true);
      } else if (Array.isArray(stmt.specifiers)) {
        for (const spec of stmt.specifiers) {
          const exportedName = spec.exported?.name ?? spec.exported?.value;
          const localName = spec.local?.name;
          if (!exportedName) continue;
          if (!stmt.source && localName && symbols.has(localName)) {
            const target = symbols.get(localName);
            symbols.set(localName, {...target, exported: true});
            if (exportedName !== localName) {
              addSymbol(exportedName, {...target, exported: true});
            }
          } else {
            addSymbol(exportedName, spanInfo(stmt, 'export', true));
          }
        }
      }
      continue;
    }
    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration;
      const kind = (decl?.type === 'FunctionDeclaration' || decl?.type === 'FunctionExpression' || decl?.type === 'ArrowFunctionExpression')
        ? 'function'
        : (decl?.type === 'ClassDeclaration' || decl?.type === 'ClassExpression') ? 'class' : 'export';
      if (decl?.type === 'Identifier' && symbols.has(decl.name)) {
        const target = symbols.get(decl.name);
        symbols.set(decl.name, {...target, exported: true});
        addSymbol('default', {...target, exported: true});
      } else {
        const info = spanInfo(stmt, kind, true);
        addSymbol('default', info);
        if (decl?.id?.name) addSymbol(decl.id.name, info);
      }
      continue;
    }
    if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration' || stmt.type === 'VariableDeclaration') {
      registerDeclaration(stmt, stmt, false);
      continue;
    }
    if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'AssignmentExpression' && stmt.expression.operator === '=') {
      const {left, right} = stmt.expression;
      // exports.foo = ... or module.exports.foo = ...
      if (left.type === 'MemberExpression' && !left.computed && left.property?.type === 'Identifier') {
        const propName = left.property.name;
        const isExportsProp = (left.object.type === 'Identifier' && left.object.name === 'exports') ||
          (left.object.type === 'MemberExpression' && !left.object.computed &&
            left.object.object?.type === 'Identifier' && left.object.object.name === 'module' &&
            left.object.property?.type === 'Identifier' && left.object.property.name === 'exports');
        if (isExportsProp) {
          if (right.type === 'Identifier' && symbols.has(right.name)) {
            const target = symbols.get(right.name);
            symbols.set(right.name, {...target, exported: true});
            if (propName !== right.name) addSymbol(propName, {...target, exported: true});
          } else {
            const kind = ['FunctionExpression', 'ArrowFunctionExpression'].includes(right.type)
              ? 'function'
              : right.type === 'ClassExpression' ? 'class' : 'export';
            addSymbol(propName, spanInfo(stmt, kind, true));
          }
          continue;
        }
        // module.exports = ...
        const isModuleExports = left.object.type === 'Identifier' && left.object.name === 'module' && propName === 'exports';
        if (isModuleExports) {
          if (right.type === 'Identifier' && symbols.has(right.name)) {
            const target = symbols.get(right.name);
            symbols.set(right.name, {...target, exported: true});
            addSymbol('default', {...target, exported: true});
          } else if (right.type === 'ObjectExpression') {
            for (const prop of right.properties) {
              if (prop.type !== 'Property' || prop.computed) continue;
              const keyName = prop.key?.type === 'Identifier' ? prop.key.name
                : (prop.key?.type === 'Literal' && typeof prop.key.value === 'string' ? prop.key.value : null);
              if (!keyName) continue;
              if (prop.value?.type === 'Identifier' && symbols.has(prop.value.name)) {
                const target = symbols.get(prop.value.name);
                symbols.set(prop.value.name, {...target, exported: true});
                if (keyName !== prop.value.name) addSymbol(keyName, {...target, exported: true});
              } else {
                const kind = ['FunctionExpression', 'ArrowFunctionExpression'].includes(prop.value?.type)
                  ? 'function'
                  : prop.value?.type === 'ClassExpression' ? 'class' : 'export';
                addSymbol(keyName, spanInfo(prop, kind, true));
              }
            }
          } else {
            const kind = ['FunctionExpression', 'ArrowFunctionExpression'].includes(right.type)
              ? 'function'
              : right.type === 'ClassExpression' ? 'class' : 'export';
            const info = spanInfo(stmt, kind, true);
            addSymbol('default', info);
            if (right.id?.name) addSymbol(right.id.name, info);
          }
        }
      }
    }
  }
  return {imports, consts, symbols};
}

function analyzeTypeScriptAst(code, filePath, lineStarts) {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = [];
  const consts = [];
  const symbols = new Map();
  const addSymbol = (name, info) => {
    if (!name) return;
    const prev = symbols.get(name);
    if (!prev) symbols.set(name, {name, ...info});
    else if (info.exported && !prev.exported) symbols.set(name, {...prev, exported: true});
  };
  const hasModifier = (node, kind) => Boolean(node.modifiers?.some(m => m.kind === kind));
  const spanInfo = (node, kind, exported) => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    return {
      kind,
      exported,
      start,
      end,
      startLine: offsetToLine(lineStarts, start),
      endLine: offsetToLine(lineStarts, Math.max(start, end - 1)),
    };
  };
  const isTsRequire = expr => {
    if (!expr) return false;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require') return true;
    if (ts.isPropertyAccessExpression(expr)) return isTsRequire(expr.expression);
    return false;
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      imports.push(spanInfo(stmt, 'import', false));
      continue;
    }
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(stmt)) {
      const info = spanInfo(stmt, 'function', exported);
      if (stmt.name?.text) addSymbol(stmt.name.text, info);
      if (isDefault) addSymbol('default', info);
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      const info = spanInfo(stmt, 'class', exported);
      if (stmt.name?.text) addSymbol(stmt.name.text, info);
      if (isDefault) addSymbol('default', info);
      continue;
    }
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      const info = spanInfo(stmt, 'type', exported);
      if (stmt.name?.text) addSymbol(stmt.name.text, info);
      if ((info.end - info.start) <= 450) consts.push(info);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations;
      const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
      if (!exported && decls.length > 0 && decls.every(d => isTsRequire(d.initializer))) {
        imports.push(spanInfo(stmt, 'require', false));
        continue;
      }
      let allSimpleConst = isConst && decls.length > 0;
      for (const d of decls) {
        if (ts.isIdentifier(d.name)) {
          const init = d.initializer;
          const isFn = init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init));
          const isCls = init && ts.isClassExpression(init);
          const kind = isFn ? 'function' : isCls ? 'class' : isConst ? 'const' : 'var';
          addSymbol(d.name.text, spanInfo(stmt, kind, exported));
          if (!init || isFn || isCls || isTsRequire(init) || (init.getEnd() - init.getStart(sf)) > 400) {
            allSimpleConst = false;
          }
        } else {
          allSimpleConst = false;
        }
      }
      if (allSimpleConst && (stmt.getEnd() - stmt.getStart(sf)) <= 450) {
        consts.push(spanInfo(stmt, 'const', exported));
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        const exportedName = spec.name.text;
        const localName = spec.propertyName?.text ?? exportedName;
        if (!stmt.moduleSpecifier && symbols.has(localName)) {
          const target = symbols.get(localName);
          symbols.set(localName, {...target, exported: true});
          if (exportedName !== localName) addSymbol(exportedName, {...target, exported: true});
        } else {
          addSymbol(exportedName, spanInfo(stmt, 'export', true));
        }
      }
      continue;
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isIdentifier(stmt.expression) && symbols.has(stmt.expression.text)) {
        const target = symbols.get(stmt.expression.text);
        symbols.set(stmt.expression.text, {...target, exported: true});
        addSymbol('default', {...target, exported: true});
      } else {
        addSymbol('default', spanInfo(stmt, 'export', true));
      }
    }
  }
  return {imports, consts, symbols};
}

/** Extract top-level imports, simple consts, and symbols from a JS/TS/JSON file. */
export function analyzeSourceFile(code, filePath = 'module.js') {
  const bytes = Buffer.byteLength(code, 'utf8');
  const lineArray = code.length === 0 ? [] : code.split(/\r?\n/);
  const lines = lineArray.length;
  if (filePath.toLowerCase().endsWith('.json')) {
    return {lines, bytes, lineArray, imports: [], consts: [], symbols: new Map(), symbolNames: []};
  }
  const lineStarts = buildLineStarts(code);
  let analyzed;
  if (!isTsFilePath(filePath)) {
    const ast = parseWithAcorn(code);
    if (ast) analyzed = analyzeAcornAst(ast, code, lineStarts);
  }
  if (!analyzed) {
    try {
      analyzed = analyzeTypeScriptAst(code, filePath, lineStarts);
    } catch {
      analyzed = {imports: [], consts: [], symbols: new Map()};
    }
  }
  return {
    lines,
    bytes,
    lineArray,
    imports: analyzed.imports,
    consts: analyzed.consts,
    symbols: analyzed.symbols,
    symbolNames: [...analyzed.symbols.keys()],
  };
}

/** Render a concise deterministic manifest of all files in the virtual codebase. */
export function renderRepoManifest(files, entryFile, initialLoadedFiles = [entryFile]) {
  const loaded = new Set(initialLoadedFiles);
  const paths = Object.keys(files).sort();
  const isLargeRepo = paths.length > 64;
  const isVeryLargeRepo = paths.length > 128;
  const exportLimit = isVeryLargeRepo ? 6 : (isLargeRepo ? 8 : 12);
  const defLimit = isVeryLargeRepo ? 3 : (isLargeRepo ? 4 : 8);
  const maxPartChars = isVeryLargeRepo ? 72 : (isLargeRepo ? 96 : Infinity);
  const fmtList = (list, limit) => {
    if (!list.length) return '';
    const kept = [];
    let chars = 0;
    for (let i = 0; i < list.length && kept.length < limit; i++) {
      const item = list[i];
      const nextChars = chars + (kept.length ? 2 : 0) + item.length;
      if (kept.length > 0 && nextChars > maxPartChars) break;
      kept.push(item);
      chars = nextChars;
    }
    const remaining = list.length - kept.length;
    return remaining > 0 ? kept.join(', ') + ` (+${remaining} more)` : kept.join(', ');
  };
  const rows = [`Repository manifest (${paths.length} file${paths.length === 1 ? '' : 's'}):`];
  for (const relPath of paths) {
    const info = analyzeSourceFile(files[relPath], relPath);
    const tag = loaded.has(relPath) ? ' [loaded]' : '';
    const exportedNames = [];
    const defNames = [];
    for (const sym of info.symbols.values()) {
      if (sym.exported) exportedNames.push(sym.name);
      else if (sym.kind === 'function' || sym.kind === 'class') defNames.push(sym.name);
    }
    const summaryParts = [];
    if (exportedNames.length) summaryParts.push('exports: ' + fmtList(exportedNames, exportLimit));
    if (defNames.length && (!isVeryLargeRepo || exportedNames.length === 0)) {
      summaryParts.push('defs: ' + fmtList(defNames, defLimit));
    }
    const suffix = summaryParts.length ? ' — ' + summaryParts.join('; ') : '';
    rows.push(`- ${relPath}${tag} (${info.lines} lines, ${info.bytes} bytes)${suffix}`);
  }
  return rows.join('\n');
}

function mergeLineRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    const last = merged[merged.length - 1];
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function buildSymbolSnippet(analysis, sym) {
  const ranges = [];
  let importChars = 0;
  for (const imp of analysis.imports) {
    const len = imp.end - imp.start;
    if (importChars + len > 2000) break;
    ranges.push([imp.startLine, imp.endLine]);
    importChars += len;
  }
  let constChars = 0;
  for (const c of analysis.consts) {
    if (c.startLine >= sym.startLine && c.endLine <= sym.endLine) continue;
    const len = c.end - c.start;
    if (constChars + len > 1600) break;
    ranges.push([c.startLine, c.endLine]);
    constChars += len;
  }
  ranges.push([sym.startLine, sym.endLine]);
  const merged = mergeLineRanges(ranges);
  const chunks = [];
  for (const [start, end] of merged) {
    chunks.push(analysis.lineArray.slice(start - 1, end).join('\n'));
  }
  return chunks.join('\n// ...\n');
}

/** Serve one or a batch of flexible `code.load` requests without throwing on
 * missing files or missing symbols. */
export function serveCodeLoad(files, requests) {
  const list = Array.isArray(requests) ? requests : (plain(requests) ? [requests] : null);
  if (!list || list.length === 0) {
    return [{path: '', error: 'Expected a non-empty array of code.load request objects', availableSymbols: []}];
  }
  const capped = list.slice(0, MAX_CODE_LOAD_BATCH);
  const analysisCache = new Map();
  const getAnalysis = relPath => {
    let info = analysisCache.get(relPath);
    if (!info) {
      info = analyzeSourceFile(files[relPath], relPath);
      analysisCache.set(relPath, info);
    }
    return info;
  };

  return capped.map(req => {
    if (!plain(req) || typeof req.path !== 'string' || !req.path.trim()) {
      return {path: String(req?.path ?? ''), error: 'Invalid code.load request: path is required', availableSymbols: []};
    }
    let normPath;
    try {
      normPath = normalizeRepoPath(req.path);
    } catch {
      return {path: req.path, error: 'Invalid file path: ' + req.path, availableSymbols: []};
    }
    if (!own(files, normPath)) {
      return {path: normPath, error: 'File not found: ' + normPath, availableSymbols: []};
    }
    const content = files[normPath];
    const info = getAnalysis(normPath);

    // 1. Symbol snippet mode
    if (typeof req.symbol === 'string' && req.symbol.trim().length > 0) {
      const symbolName = req.symbol.trim();
      const sym = info.symbols.get(symbolName);
      if (!sym) {
        return {
          path: normPath,
          error: `Symbol '${symbolName}' not found in ${normPath}`,
          availableSymbols: info.symbolNames,
        };
      }
      const snippet = buildSymbolSnippet(info, sym);
      return {
        path: normPath,
        mode: 'symbol',
        symbol: symbolName,
        startLine: sym.startLine,
        endLine: sym.endLine,
        totalLines: info.lines,
        bytes: Buffer.byteLength(snippet, 'utf8'),
        content: snippet,
      };
    }

    // 2. Line range mode (accepts startLine/endLine or start_line/end_line)
    const rawStart = req.startLine ?? req.start_line;
    const rawEnd = req.endLine ?? req.end_line;
    if (rawStart !== undefined || rawEnd !== undefined) {
      const startLine = rawStart === undefined ? 1 : Number(rawStart);
      const endLine = rawEnd === undefined ? info.lines : Number(rawEnd);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        return {
          path: normPath,
          error: `Invalid line range [${rawStart}, ${rawEnd}] for ${normPath}`,
          availableSymbols: info.symbolNames,
        };
      }
      const clampedStart = Math.min(startLine, Math.max(1, info.lines));
      const clampedEnd = Math.min(endLine, info.lines);
      const snippet = info.lines === 0 ? '' : info.lineArray.slice(clampedStart - 1, clampedEnd).join('\n');
      return {
        path: normPath,
        mode: 'range',
        startLine: clampedStart,
        endLine: clampedEnd,
        totalLines: info.lines,
        bytes: Buffer.byteLength(snippet, 'utf8'),
        content: snippet,
      };
    }

    // 3. Whole file mode
    return {
      path: normPath,
      mode: 'file',
      lines: info.lines,
      bytes: info.bytes,
      content,
    };
  });
}

export function codeLoadResultBytes(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + (Number.isFinite(item?.bytes) ? item.bytes : 0), 0);
}

/** Resolve a relative module specifier against the in-memory `files` map. */
export function resolveVirtualModulePath(files, fromFile, specifier) {
  if (typeof specifier !== 'string') return null;
  if (!specifier.startsWith('./') && !specifier.startsWith('../') && specifier !== '.' && specifier !== '..') {
    return null;
  }
  const baseDir = pathPosix.dirname(fromFile);
  const joined = pathPosix.normalize(baseDir === '.' ? specifier : pathPosix.join(baseDir, specifier));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;

  const candidates = [joined];
  const ext = pathPosix.extname(joined).toLowerCase();
  if (ext && own(JS_TO_TS_MAP, ext)) {
    const stem = joined.slice(0, -ext.length);
    for (const tsExt of JS_TO_TS_MAP[ext]) candidates.push(stem + tsExt);
  }
  for (const e of MODULE_EXTENSIONS) candidates.push(joined + e);
  for (const e of MODULE_EXTENSIONS) candidates.push(joined + '/index' + e);

  for (const candidate of candidates) {
    const clean = candidate.startsWith('./') ? candidate.slice(2) : candidate;
    if (own(files, clean)) return clean;
  }
  return null;
}

function sourceNeedsCjsTranspile(code, relPath) {
  if (isTsFilePath(relPath)) return true;
  if (relPath.toLowerCase().endsWith('.mjs')) return true;
  const modAst = parseWithAcorn(code);
  if (!modAst) return true;
  return modAst.body.some(stmt =>
    stmt.type === 'ImportDeclaration' ||
    stmt.type === 'ExportNamedDeclaration' ||
    stmt.type === 'ExportDefaultDeclaration' ||
    stmt.type === 'ExportAllDeclaration');
}

/** Lower a single JS/ESM/TS/JSON module to CommonJS WITHOUT bundling files together. */
export function transpileSingleModuleToCjs(code, relPath) {
  if (relPath.toLowerCase().endsWith('.json')) {
    return 'module.exports = ' + JSON.stringify(JSON.parse(code)) + ';\n';
  }
  if (!sourceNeedsCjsTranspile(code, relPath)) {
    return code;
  }
  const result = ts.transpileModule(code, {
    fileName: relPath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowJs: true,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new SyntaxError(`${relPath}: ` + errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '));
  }
  return result.outputText;
}

/** Inject `globalThis.__traceEnterSymbol(relPath, symbolName)` at the very start
 * of every top-level function/class/method body in a compiled CJS module. */
export function instrumentModuleCodeLoadHooks(cjsCode, relPath, originalSymbols) {
  let ast;
  try {
    ast = parse(cjsCode, {ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true});
  } catch {
    return cjsCode;
  }

  // Detect TypeScript's `exports.default = default_1;` mapping so default exports resolve to 'default'.
  const exportAliasMap = new Map();
  for (const stmt of ast.body) {
    if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'AssignmentExpression' &&
        stmt.expression.operator === '=' && stmt.expression.left.type === 'MemberExpression' &&
        !stmt.expression.left.computed && stmt.expression.left.object?.type === 'Identifier' &&
        stmt.expression.left.object.name === 'exports' && stmt.expression.left.property?.type === 'Identifier' &&
        stmt.expression.right?.type === 'Identifier') {
      const expName = stmt.expression.left.property.name;
      const localName = stmt.expression.right.name;
      if (!exportAliasMap.has(localName) && originalSymbols.has(expName)) {
        exportAliasMap.set(localName, expName);
      }
    }
  }

  const resolveSym = candidate => {
    if (candidate && originalSymbols.has(candidate)) return candidate;
    if (candidate && exportAliasMap.has(candidate)) return exportAliasMap.get(candidate);
    return null;
  };

  const edits = [];
  const makeHookCall = symName => `globalThis.__traceEnterSymbol(${JSON.stringify(relPath)},${JSON.stringify(symName)})`;

  function hookFunctionLike(fnNode, symName) {
    if (!fnNode || !fnNode.body) return;
    const hook = makeHookCall(symName);
    if (fnNode.body.type === 'BlockStatement') {
      let insertAt = fnNode.body.start + 1;
      // Preserve any leading directive ('use strict') at the top of the function body.
      for (const s of fnNode.body.body) {
        if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') {
          insertAt = s.end;
        } else {
          break;
        }
      }
      edits.push({pos: insertAt, text: ' ' + hook + '; '});
    } else {
      // Concise arrow expression body: `(x) => expr` -> `(x) => (hook, (expr))`
      edits.push({pos: fnNode.body.start, text: '(' + hook + ', ('});
      edits.push({pos: fnNode.body.end, text: '))'});
    }
  }

  function hookClassLike(clsNode, symName) {
    if (!clsNode?.body?.body) return;
    for (const member of clsNode.body.body) {
      if (member.type === 'MethodDefinition' && member.value) {
        hookFunctionLike(member.value, symName);
      } else if (member.type === 'PropertyDefinition' && member.value &&
          (member.value.type === 'FunctionExpression' || member.value.type === 'ArrowFunctionExpression')) {
        hookFunctionLike(member.value, symName);
      }
    }
  }

  function hookExpression(expr, symName) {
    if (!expr) return;
    if (expr.type === 'FunctionExpression' || expr.type === 'ArrowFunctionExpression') {
      hookFunctionLike(expr, symName);
    } else if (expr.type === 'ClassExpression') {
      hookClassLike(expr, symName);
    } else if (expr.type === 'ObjectExpression') {
      for (const prop of expr.properties) {
        if (prop.type === 'Property' && prop.value) {
          const propKey = !prop.computed && prop.key?.type === 'Identifier' ? prop.key.name : null;
          hookExpression(prop.value, symName ?? resolveSym(propKey));
        }
      }
    }
  }

  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      hookFunctionLike(stmt, resolveSym(stmt.id.name));
    } else if (stmt.type === 'ClassDeclaration' && stmt.id?.name) {
      hookClassLike(stmt, resolveSym(stmt.id.name));
    } else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id?.type === 'Identifier' && decl.init) {
          hookExpression(decl.init, resolveSym(decl.id.name));
        }
      }
    } else if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'AssignmentExpression' &&
        stmt.expression.operator === '=') {
      const {left, right} = stmt.expression;
      if (left.type === 'MemberExpression' && !left.computed && left.property?.type === 'Identifier') {
        const propName = left.property.name;
        const isExportsProp = (left.object.type === 'Identifier' && left.object.name === 'exports') ||
          (left.object.type === 'MemberExpression' && !left.object.computed &&
            left.object.object?.type === 'Identifier' && left.object.object.name === 'module' &&
            left.object.property?.type === 'Identifier' && left.object.property.name === 'exports');
        if (isExportsProp) {
          hookExpression(right, resolveSym(propName));
        } else if (left.object.type === 'Identifier' && left.object.name === 'module' && propName === 'exports') {
          if (right.type === 'ObjectExpression') {
            for (const prop of right.properties) {
              if (prop.type === 'Property' && prop.value) {
                const keyName = !prop.computed && prop.key?.type === 'Identifier' ? prop.key.name : null;
                hookExpression(prop.value, resolveSym(keyName) ?? resolveSym('default'));
              }
            }
          } else {
            hookExpression(right, resolveSym(right.id?.name) ?? resolveSym('default'));
          }
        }
      }
    }
  }

  if (!edits.length) return cjsCode;
  // Stable reverse-offset splice (preserve insertion order for identical offsets).
  const indexed = edits.map((edit, idx) => ({...edit, idx}));
  indexed.sort((a, b) => (b.pos - a.pos) || (b.idx - a.idx));
  let out = cjsCode;
  for (const edit of indexed) {
    out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos);
  }
  try {
    parse(out, {ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true});
    return out;
  } catch {
    return cjsCode;
  }
}

/** Decide the canonical teacher `code.load` request on first entry into
 * `(relPath, symbolName)`. Small files (<= 3072 B) load whole-file to save
 * round-trips; larger files load symbol snippets to save tokens. */
export function chooseCanonicalCodeLoad(files, relPath, symbolName, loadedFiles, loadedSymbols, analysisCache) {
  if (loadedFiles.has(relPath)) return null;
  const content = files[relPath];
  if (typeof content !== 'string') return null;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= WHOLE_FILE_LOAD_MAX_BYTES) {
    loadedFiles.add(relPath);
    return {path: relPath};
  }
  let info = analysisCache.get(relPath);
  if (!info) {
    info = analyzeSourceFile(content, relPath);
    analysisCache.set(relPath, info);
  }
  if (symbolName && info.symbols.has(symbolName)) {
    const key = relPath + '::' + symbolName;
    if (loadedSymbols.has(key)) return null;
    loadedSymbols.add(key);
    return {path: relPath, symbol: symbolName};
  }
  loadedFiles.add(relPath);
  return {path: relPath};
}

/** Execute a multi-file JS/TS virtual codebase inside an already-initialized
 * `vm.Context`, tracking causal `code.load` teacher events and per-turn traces
 * without ever bundling the files together. */
export async function executeVirtualCodebaseInContext({
  context,
  files,
  entryFile,
  entry,
  initialLoadedFiles = [entryFile],
  args,
  timeoutMs = 5000,
  traceMode = false,
  onCodeLoadEvent,
  setTraceActive,
  onCallbackFailure = null,
  compiledCache = null,
}) {
  const loadedFiles = new Set(initialLoadedFiles);
  const loadedSymbols = new Set();
  const analysisCache = compiledCache?.analysisCache ?? new Map();
  const cjsCache = compiledCache?.cjsCache ?? null;
  const moduleCache = new Map();
  let codeLoadActive = false;

  const getAnalysis = relPath => {
    let info = analysisCache.get(relPath);
    if (!info) {
      info = analyzeSourceFile(files[relPath], relPath);
      analysisCache.set(relPath, info);
    }
    return info;
  };

  function maybeEmitCodeLoad(relPath, symbolName) {
    if (!codeLoadActive) return;
    const req = chooseCanonicalCodeLoad(files, relPath, symbolName, loadedFiles, loadedSymbols, analysisCache);
    if (req) onCodeLoadEvent(req);
  }

  context.__traceEnterSymbol = (relPath, symbolName) => {
    maybeEmitCodeLoad(relPath, symbolName);
  };

  function wrapExportsForCodeLoad(relPath, exportsObj) {
    if (loadedFiles.has(relPath)) return exportsObj;
    if (!exportsObj || typeof exportsObj !== 'object') return exportsObj;
    return new Proxy(exportsObj, {
      get(target, prop, receiver) {
        if (codeLoadActive && typeof prop === 'string' && prop !== '__esModule' && prop !== 'then' && own(target, prop)) {
          maybeEmitCodeLoad(relPath, prop);
        }
        const desc = Object.getOwnPropertyDescriptor(target, prop);
        if (desc && !desc.get && !desc.set) return desc.value;
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  let entryFallbackFn = null;

  function loadModule(relPath) {
    if (moduleCache.has(relPath)) return moduleCache.get(relPath).wrappedExports;
    const cacheKey = `${relPath}|${traceMode ? 1 : 0}|${loadedFiles.has(relPath) ? 1 : 0}|${relPath === entryFile ? entry : ''}`;
    let cjsCode = cjsCache?.get(cacheKey);
    if (cjsCode === undefined) {
      const rawCode = files[relPath];
      cjsCode = transpileSingleModuleToCjs(rawCode, relPath);
      if (traceMode) {
        cjsCode = instrumentNativeTraceSource(cjsCode, {
          entryName: relPath === entryFile ? entry : null,
        }).source;
      }
      if (!loadedFiles.has(relPath)) {
        const info = getAnalysis(relPath);
        cjsCode = instrumentModuleCodeLoadHooks(cjsCode, relPath, info.symbols);
      }
      if (cjsCache) cjsCache.set(cacheKey, cjsCode);
    }

    const mod = {exports: {}, id: relPath, filename: relPath, loaded: false};
    const record = {mod, wrappedExports: mod.exports};
    moduleCache.set(relPath, record);

    const localRequire = specifier => {
      const resolved = resolveVirtualModulePath(files, relPath, specifier);
      if (!resolved) {
        const err = new Error(`Cannot find virtual module '${specifier}' from '${relPath}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      const loaded = loadModule(resolved);
      // If a module is lazily required while executing entry and has non-callable data exports,
      // wait for property read or function entry; for pure JSON data, load whole file immediately.
      if (codeLoadActive && resolved.toLowerCase().endsWith('.json')) {
        maybeEmitCodeLoad(resolved, null);
      }
      return loaded;
    };

    const entryProbeFooter = relPath === entryFile
      ? `\nif (typeof ${entry} === 'function') __captureEntryFallback(${entry});`
      : '';
    const wrapperSource = `(function(exports, require, module, __filename, __dirname, __captureEntryFallback) {\n${cjsCode}${entryProbeFooter}\n})`;
    const script = new vm.Script(wrapperSource, {filename: relPath});
    const wrapper = script.runInContext(context, {timeout: timeoutMs});
    const dir = pathPosix.dirname(relPath);
    wrapper(mod.exports, localRequire, mod, relPath, dir === '.' ? '' : dir, fn => { entryFallbackFn = fn; });
    mod.loaded = true;
    record.wrappedExports = wrapExportsForCodeLoad(relPath, mod.exports);
    return record.wrappedExports;
  }

  // Bootstrap entry module (and statically required deps) with tracing and code.load paused
  // so module top-level imports never produce dead-branch loads or pre-entry trace noise.
  if (setTraceActive) setTraceActive(false);
  codeLoadActive = false;
  const entryExports = loadModule(entryFile);

  let entryFn = null;
  if (entryExports && typeof entryExports === 'object' && typeof entryExports[entry] === 'function') {
    entryFn = entryExports[entry];
  } else if (entry === 'default' && typeof entryExports === 'function') {
    entryFn = entryExports;
  } else if (entry === 'default' && entryExports && typeof entryExports.default === 'function') {
    entryFn = entryExports.default;
  } else if (typeof entryExports === 'function' && (entryExports.name === entry || entry === 'run')) {
    entryFn = entryExports;
  } else if (typeof entryFallbackFn === 'function') {
    entryFn = entryFallbackFn;
  }
  if (typeof entryFn !== 'function') {
    throw new TypeError(`Entry function '${entry}' not found in '${entryFile}'`);
  }

  context.__entryFn = entryFn;
  context.__args = args;
  context.__result = undefined;
  context.__kind = 'return';

  codeLoadActive = true;
  if (setTraceActive) setTraceActive(true);
  const invokeScript = new vm.Script(
    'try { __result = __entryFn.apply(undefined, __args); } catch (__guestThrown) { __kind = "throw"; __result = __guestThrown; }',
    {filename: entryFile},
  );
  invokeScript.runInContext(context, {timeout: timeoutMs});
  let value = context.__result;
  let kind = context.__kind;
  if (kind === 'return') {
    if (value && typeof value.then === 'function' && typeof context.__browserHasPendingTimers === 'function') {
      let settled = false;
      const tracked = Promise.resolve(value).then(
        res => { settled = true; return {ok: true, res}; },
        err => { settled = true; return {ok: false, err}; },
      );
      let idleTicks = 0;
      for (let steps = 0; steps < 2000 && !settled; steps++) {
        await new Promise(resolve => setImmediate(resolve));
        if (settled) break;
        if (context.__browserHasPendingTimers()) {
          idleTicks = 0;
          try { context.__browserStepNextTimer(); } catch (error) {
            if (typeof onCallbackFailure === 'function') onCallbackFailure(error);
          }
        } else if (++idleTicks >= 16) {
          break;
        }
      }
      const outcomeBox = await tracked;
      if (outcomeBox.ok) value = outcomeBox.res;
      else { kind = 'throw'; value = outcomeBox.err; }
    } else {
      try {
        value = await value;
      } catch (error) {
        kind = 'throw';
        value = error;
      }
    }
  }
  return {kind, value};
}
