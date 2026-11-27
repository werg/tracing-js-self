#!/usr/bin/env node
// Real multi-file JS/TS OSS repository harvester for on-demand `code.load` training.
// Walks cached OSS repos, keeps modules as separate files (3–25 files including
// real sibling distractor files), probes entry exports that genuinely cross into
// >= 1 non-entry file, and verifies 100% through exportTinkerExample().
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, posix as pathPosix, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import vm from 'node:vm';
import {exportTinkerExample, encodeReadable} from '../src/training/tinker-execution.js';
import {
  analyzeSourceFile,
  executeVirtualCodebaseInContext,
  normalizeRepoPath,
  resolveVirtualModulePath,
} from '../src/training/tinker-codebase.js';

process.on('unhandledRejection', () => {});

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.vscode', '.idea', 'dist', 'build', 'out',
  'coverage', 'test', 'tests', '__tests__', '__mocks__', '__snapshots__', 'spec',
  'docs', 'doc', 'examples', 'example', 'demo', 'demos', 'bench', 'benchmark',
  'benchmarks', 'fixtures', 'fixture', 'scripts', 'bin', 'types', 'typings',
  'website', 'site', 'public', 'static', 'assets', 'vendor', 'third_party',
  '.next', '.nuxt', '.cache', 'tmp', 'temp',
]);

const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/i;
const SKIP_FILE_RE = /(?:\.d\.ts|\.test\.|\.spec\.|\.min\.|\.bundle\.|\.config\.|config\.js$|config\.ts$|rollup|webpack|vite\.|jest\.|vitest\.|babel\.|eslint|prettier|gulpfile|gruntfile)/i;
const MAX_SINGLE_FILE_BYTES = 48 * 1024;
const MIN_SINGLE_FILE_BYTES = 20;
const MAX_PACKAGE_TOTAL_BYTES = 350 * 1024;

function extractStaticSpecifiers(code) {
  const specs = new Set();
  const importRe = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  const requireRe = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  for (const m of code.matchAll(importRe)) specs.add(m[1]);
  for (const m of code.matchAll(requireRe)) specs.add(m[1]);
  return [...specs];
}

function walkSourceFiles(rootDir, maxDepth = 5, maxFiles = 200) {
  const results = [];
  function visit(dir, depth) {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
          visit(join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        if (!SOURCE_EXT_RE.test(entry.name) || SKIP_FILE_RE.test(entry.name)) continue;
        const abs = join(dir, entry.name);
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size < MIN_SINGLE_FILE_BYTES || st.size > MAX_SINGLE_FILE_BYTES) continue;
        results.push(abs);
      }
    }
  }
  visit(rootDir, 0);
  return results;
}

function collectCandidateRoots(repoDir) {
  const candidates = [];
  const tryRoot = dir => {
    if (existsSync(dir)) {
      try {
        if (statSync(dir).isDirectory()) candidates.push(dir);
      } catch {}
    }
  };
  tryRoot(join(repoDir, 'src'));
  tryRoot(join(repoDir, 'lib'));
  const packagesDir = join(repoDir, 'packages');
  if (existsSync(packagesDir)) {
    try {
      for (const entry of readdirSync(packagesDir, {withFileTypes: true}).slice(0, 8)) {
        if (!entry.isDirectory()) continue;
        const pDir = join(packagesDir, entry.name);
        if (existsSync(join(pDir, 'src'))) tryRoot(join(pDir, 'src'));
        else if (existsSync(join(pDir, 'lib'))) tryRoot(join(pDir, 'lib'));
        else tryRoot(pDir);
      }
    } catch {}
  }
  tryRoot(repoDir);
  return candidates;
}

/** Build a clean multi-file map (minFiles..maxFiles) for a candidate package root,
 * ensuring the entry module + its reachable local closure are self-contained and
 * accompanied by real sibling distractor files from the same repo. */
export function buildMultiFilePackagesFromRoot(repoDir, {minFiles = 3, maxFiles = 25} = {}) {
  const packages = [];
  const seenFileSets = new Set();

  for (const root of collectCandidateRoots(repoDir)) {
    const absFiles = walkSourceFiles(root, 4, 120);
    if (absFiles.length < minFiles) continue;

    const allFiles = {};
    for (const abs of absFiles) {
      const relRaw = relative(repoDir, abs).replaceAll('\\', '/');
      let norm;
      try { norm = normalizeRepoPath(relRaw); } catch { continue; }
      let content;
      try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      allFiles[norm] = content;
    }

    const allPaths = Object.keys(allFiles).sort();
    if (allPaths.length < minFiles) continue;

    // Build local dependency graph & identify files with purely-local closures.
    const deps = new Map();
    const hasExternalDep = new Map();
    for (const relPath of allPaths) {
      const specs = extractStaticSpecifiers(allFiles[relPath]);
      const localDeps = [];
      let ext = false;
      for (const spec of specs) {
        if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
          const resolved = resolveVirtualModulePath(allFiles, relPath, spec);
          if (resolved) localDeps.push(resolved);
          else ext = true;
        } else {
          ext = true;
        }
      }
      deps.set(relPath, localDeps);
      hasExternalDep.set(relPath, ext);
    }

    const computeClosure = start => {
      const visited = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift();
        if (hasExternalDep.get(cur)) return null;
        for (const nxt of deps.get(cur) ?? []) {
          if (!visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
      return visited;
    };

    // Rank entry candidates: index/main files with >= 1 local dependency first.
    const entryCandidates = allPaths
      .filter(p => (deps.get(p)?.length ?? 0) > 0 && !hasExternalDep.get(p))
      .sort((a, b) => {
        const aIdx = /(?:^|\/)(?:index|main)\.[^/]+$/i.test(a) ? 0 : 1;
        const bIdx = /(?:^|\/)(?:index|main)\.[^/]+$/i.test(b) ? 0 : 1;
        return (aIdx - bIdx) || a.localeCompare(b);
      });

    for (const entryFile of entryCandidates.slice(0, 6)) {
      const closure = computeClosure(entryFile);
      if (!closure || closure.size < 2 || closure.size > maxFiles) continue;

      // Assemble files map: closure + real sibling distractors from allPaths up to maxFiles.
      const selectedPaths = [...closure].sort();
      let totalBytes = selectedPaths.reduce((s, p) => s + Buffer.byteLength(allFiles[p], 'utf8'), 0);
      if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) continue;

      const entryDir = pathPosix.dirname(entryFile);
      const distractors = allPaths
        .filter(p => !closure.has(p))
        .sort((a, b) => {
          const aSame = pathPosix.dirname(a) === entryDir ? 0 : 1;
          const bSame = pathPosix.dirname(b) === entryDir ? 0 : 1;
          return (aSame - bSame) || a.localeCompare(b);
        });

      const targetCount = Math.min(maxFiles, Math.max(minFiles, Math.min(allPaths.length, closure.size + 6)));
      for (const distPath of distractors) {
        if (selectedPaths.length >= targetCount) break;
        const b = Buffer.byteLength(allFiles[distPath], 'utf8');
        if (totalBytes + b > MAX_PACKAGE_TOTAL_BYTES) continue;
        selectedPaths.push(distPath);
        totalBytes += b;
      }

      if (selectedPaths.length < minFiles) continue;
      selectedPaths.sort();
      const files = {};
      for (const p of selectedPaths) files[p] = allFiles[p];

      const key = entryFile + '|' + selectedPaths.join(',');
      if (seenFileSets.has(key)) continue;
      seenFileSets.add(key);

      packages.push({
        files,
        entryFile,
        closureSize: closure.size,
        distractorCount: selectedPaths.length - closure.size,
      });
      if (packages.length >= 4) break;
    }
    if (packages.length >= 4) break;
  }

  return packages;
}

function generateProbeArguments(fnName) {
  const lower = fnName.toLowerCase();
  const candidates = [];
  // Domain-informed probes first based on export name
  if (/parse|lex|token|compile|eval|match|glob|path|url|query|format|slug|camel|kebab|snake|trim|escape|decode|encode|hash|split|join|strip|clean|normalize|sanitize|template|render/.test(lower)) {
    candidates.push(
      ['hello-world_123'],
      ['foo/bar/baz.js'],
      ['a=1&b=two&c=3'],
      ['{"name":"alice","count":3}'],
      ['1 + 2 * 3'],
      ['  Hello, World!  '],
      ['alpha/beta', 'gamma'],
      ['https://example.com/a/b?x=1'],
    );
  }
  if (/sort|filter|map|reduce|merge|diff|chunk|flatten|uniq|group|zip|clamp|range|sum|mean|avg|median|stats|math|calc|add|sub|mul|div|fib|prime|vector|matrix|graph|tree|search|find/.test(lower)) {
    candidates.push(
      [[3, 1, 4, 1, 5, 9]],
      [[1, 2, 3, 4], 2],
      [10, 25],
      [5, 3, 8],
      [[{id: 1, v: 10}, {id: 2, v: 20}]],
      [{a: 1, b: 2}, {b: 3, c: 4}],
    );
  }
  // General-purpose diverse probes
  candidates.push(
    ['sample'],
    ['foo', 'bar'],
    [42],
    [3, 7],
    [[1, 2, 3]],
    [['a', 'b', 'c']],
    [{a: 1, b: 'two', nested: {c: true}}],
    [{x: 10, y: 20}, {scale: 2}],
    [true, 'active'],
    [],
  );
  // Deduplicate serialized probes
  const seen = new Set();
  const unique = [];
  for (const args of candidates) {
    const k = JSON.stringify(args);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(args);
    }
  }
  return unique;
}

/** Fast in-memory probe of (files, entryFile, entry, args) to see whether
 * execution succeeds cleanly, crosses into >= 1 non-entry file, and yields
 * a representable data outcome. */
async function probeMultiFileCall(files, entryFile, entry, args, {timeoutMs = 250, compiledCache = null} = {}) {
  const codeLoadEvents = [];
  const recordedCalls = [];
  let clockMs = 1700000100000;
  let overflow = false;

  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone,
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(lvl => [lvl, (...xs) => {
      if (recordedCalls.length >= 16) { overflow = true; return; }
      const msg = xs.length ? xs[0] : undefined;
      try {
        recordedCalls.push({
          operation: 'platform.console.' + lvl,
          arguments: [encodeReadable(msg)],
          status: 'fulfilled',
          result: {$js: 'undefined'},
        });
      } catch {
        overflow = true;
      }
    }])),
    queueMicrotask: cb => queueMicrotask(cb),
  }, {codeGeneration: {strings: false, wasm: false}});

  context.__recDateNow = () => {
    const v = clockMs;
    clockMs += 37;
    if (recordedCalls.length >= 16) { overflow = true; return v; }
    recordedCalls.push({operation: 'platform.dateNow', arguments: [], status: 'fulfilled', result: v});
    return v;
  };
  new vm.Script('Date.now = __recDateNow;').runInContext(context, {timeout: 100});
  new vm.Script(`(function(){let state=17>>>0;
    Math.random=function(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};})()`)
    .runInContext(context, {timeout: 100});

  const clonedArgs = structuredClone(args);
  let res;
  let timer;
  try {
    const execPromise = executeVirtualCodebaseInContext({
      context,
      files,
      entryFile,
      entry,
      initialLoadedFiles: [entryFile],
      args: clonedArgs,
      timeoutMs,
      traceMode: false,
      compiledCache,
      onCodeLoadEvent(req) {
        codeLoadEvents.push(req);
      },
      setTraceActive() {},
    });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe-async-timeout')), timeoutMs);
    });
    res = await Promise.race([execPromise, timeoutPromise]);
  } catch (err) {
    return {bootstrapError: String(err?.message ?? err)};
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (overflow || codeLoadEvents.length === 0) return null;
  if (res.kind === 'throw') return null;

  let encodedOutcome;
  try {
    encodedOutcome = encodeReadable({arguments: clonedArgs, value: res.value});
  } catch {
    return null;
  }

  // Skip completely trivial undefined/null returns unless input mutated or external calls occurred.
  const inputChanged = JSON.stringify(encodeReadable(args)) !== JSON.stringify(encodedOutcome.arguments);
  const trivialValue = res.value === undefined || res.value === null || res.value === '';
  if (trivialValue && !inputChanged && recordedCalls.length === 0) return null;

  // Guard against overly huge return values
  const outBytes = Buffer.byteLength(JSON.stringify(encodedOutcome), 'utf8');
  if (outBytes > 8192) return null;

  return {
    codeLoadEvents,
    recordedCalls,
    outcomeSignature: createHash('sha256').update(JSON.stringify(encodedOutcome)).digest('hex').slice(0, 16),
  };
}

function slugify(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo';
}

/** Harvest verified multi-file JS/TS tasks from one or more repo parent directories. */
export async function harvestMultiFileRepos(reposDirs, {
  outputDir = null,
  maxRepos = 100,
  maxPerRepo = 8,
  maxPerFn = 2,
  minFiles = 3,
  maxFiles = 25,
  maxTasks = 200,
  traceFormat = 'compact',
  reasoningChannel = 'thinking',
  singleRepoMode = false,
} = {}) {
  const dirs = Array.isArray(reposDirs) ? reposDirs : [reposDirs];
  const repoEntries = [];

  if (singleRepoMode) {
    for (const d of dirs) {
      if (existsSync(d)) repoEntries.push({name: slugify(pathPosix.basename(d.replaceAll('\\', '/'))), dir: resolve(d)});
    }
  } else {
    for (const parent of dirs) {
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        repoEntries.push({name: entry.name, dir: join(parent, entry.name)});
      }
    }
  }

  const selectedRepos = repoEntries.slice(0, maxRepos);
  const examples = [];
  const stats = {
    reposScanned: 0,
    reposWithPackages: 0,
    reposHarvested: 0,
    packagesInspected: 0,
    probesAttempted: 0,
    probesCrossFilePassed: 0,
    exportAttempts: 0,
    exportFailures: 0,
    verifiedTasks: 0,
    totalCodeLoadCalls: 0,
    symbolLoadTasks: 0,
    wholeFileLoadTasks: 0,
    effectfulTasks: 0,
    byRepo: {},
  };

  for (const repo of selectedRepos) {
    if (examples.length >= maxTasks) break;
    stats.reposScanned++;
    const packages = buildMultiFilePackagesFromRoot(repo.dir, {minFiles, maxFiles});
    if (!packages.length) continue;
    stats.reposWithPackages++;

    let repoTasks = 0;
    for (const pkg of packages) {
      if (repoTasks >= maxPerRepo || examples.length >= maxTasks) break;
      stats.packagesInspected++;

      const entryInfo = analyzeSourceFile(pkg.files[pkg.entryFile], pkg.entryFile);
      const exportFns = [];
      for (const sym of entryInfo.symbols.values()) {
        if (sym.exported && (sym.kind === 'function' || sym.kind === 'export') && /^[A-Za-z_$][\w$]*$/.test(sym.name)) {
          exportFns.push(sym.name);
        }
      }
      if (!exportFns.length) continue;

      const pkgCache = {analysisCache: new Map(), cjsCache: new Map()};
      let pkgFatal = false;
      for (const fnName of exportFns.slice(0, 12)) {
        if (pkgFatal || repoTasks >= maxPerRepo || examples.length >= maxTasks) break;
        let fnTasks = 0;
        const seenSigs = new Set();
        const probes = generateProbeArguments(fnName);

        for (const probeArgs of probes) {
          if (fnTasks >= maxPerFn || repoTasks >= maxPerRepo || examples.length >= maxTasks) break;
          stats.probesAttempted++;
          const hit = await probeMultiFileCall(pkg.files, pkg.entryFile, fnName, probeArgs, {compiledCache: pkgCache});
          if (hit?.bootstrapError) {
            if (/Cannot find virtual module|is not defined|SyntaxError|ReferenceError/.test(hit.bootstrapError)) {
              pkgFatal = true;
            }
            break;
          }
          if (!hit) continue;
          if (seenSigs.has(hit.outcomeSignature)) continue;
          seenSigs.add(hit.outcomeSignature);
          stats.probesCrossFilePassed++;

          const isTs = /\.(?:ts|tsx|mts|cts)$/i.test(pkg.entryFile);
          const hasSymbolLoad = hit.codeLoadEvents.some(e => Boolean(e.symbol));
          const hasWholeFileLoad = hit.codeLoadEvents.some(e => !e.symbol);
          const taskId = `multifile-js-${slugify(repo.name)}-${slugify(fnName)}-${examples.length + 1}`;
          const task = {
            id: taskId,
            family: `multifile-js/${repo.name}/${pkg.entryFile}`,
            language: isTs ? 'ts' : 'js',
            executionMode: 'native',
            files: pkg.files,
            entryFile: pkg.entryFile,
            entry: fnName,
            initialLoadedFiles: [pkg.entryFile],
            args: encodeReadable(probeArgs),
            fixture: {calls: hit.recordedCalls},
            randomSeed: 17,
            tier: hit.codeLoadEvents.length >= 2 || hit.recordedCalls.length > 0 ? 5 : 4,
            features: [
              'multi-file',
              'code-load',
              'native-v8',
              ...(isTs ? ['typescript'] : []),
              ...(hasSymbolLoad ? ['symbol-load'] : []),
              ...(hasWholeFileLoad ? ['whole-file-load'] : []),
              ...(pkg.distractorCount > 0 ? ['distractor-files'] : []),
              ...(hit.recordedCalls.length > 0 ? ['effectful'] : []),
            ],
            metadata: {
              repo: repo.name,
              fileCount: Object.keys(pkg.files).length,
              closureSize: pkg.closureSize,
              distractorFiles: pkg.distractorCount,
            },
          };

          stats.exportAttempts++;
          try {
            const exported = await exportTinkerExample(task, {traceFormat, reasoningChannel});
            const loadCount = exported.metadata?.codeLoadCalls ?? 0;
            if (loadCount < 1 || !exported.metadata?.traceAudit?.replayVerified) {
              stats.exportFailures++;
              continue;
            }
            examples.push(exported);
            fnTasks++;
            repoTasks++;
            stats.verifiedTasks++;
            stats.totalCodeLoadCalls += loadCount;
            if (hasSymbolLoad) stats.symbolLoadTasks++;
            if (hasWholeFileLoad) stats.wholeFileLoadTasks++;
            if (hit.recordedCalls.length > 0) stats.effectfulTasks++;
            stats.byRepo[repo.name] = (stats.byRepo[repo.name] ?? 0) + 1;
          } catch {
            stats.exportFailures++;
          }
        }
      }
    }
    if (repoTasks > 0) stats.reposHarvested++;
  }

  if (outputDir) {
    const out = resolve(outputDir);
    mkdirSync(out, {recursive: true});
    const datasetPath = join(out, 'dataset.jsonl');
    const reportPath = join(out, 'report.json');
    writeFileSync(datasetPath, examples.map(ex => JSON.stringify(ex)).join('\n') + (examples.length ? '\n' : ''));
    writeFileSync(reportPath, JSON.stringify(stats, null, 2) + '\n');
  }

  return {examples, stats};
}

async function main() {
  const {values} = parseArgs({
    options: {
      'repos-dir': {type: 'string', default: '/tmp/tinker-harvest-dgx'},
      'output-dir': {type: 'string', default: 'runs/multifile-js-harvest'},
      'max-repos': {type: 'string', default: '100'},
      'max-per-repo': {type: 'string', default: '8'},
      'max-per-fn': {type: 'string', default: '2'},
      'min-files': {type: 'string', default: '3'},
      'max-files': {type: 'string', default: '25'},
      'max-tasks': {type: 'string', default: '200'},
      'trace-format': {type: 'string', default: 'compact'},
    },
  });
  const reposDirs = values['repos-dir'].split(',').map(s => s.trim()).filter(Boolean);
  const {stats} = await harvestMultiFileRepos(reposDirs, {
    outputDir: values['output-dir'],
    maxRepos: Math.max(1, Number(values['max-repos']) || 100),
    maxPerRepo: Math.max(1, Number(values['max-per-repo']) || 8),
    maxPerFn: Math.max(1, Number(values['max-per-fn']) || 2),
    minFiles: Math.max(2, Number(values['min-files']) || 3),
    maxFiles: Math.max(3, Number(values['max-files']) || 25),
    maxTasks: Math.max(1, Number(values['max-tasks']) || 200),
    traceFormat: values['trace-format'],
  });
  console.log(JSON.stringify(stats, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
