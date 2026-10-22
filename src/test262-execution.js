// Selected official Test262 script execution, not the full Test262 harness.
// Strict/module/async variants, includes, feature switches and $262 are not implemented.
import { parse, compile } from './frontend.js';
import { createRuntime } from './runtime.js';
import { validateBundle } from './validation.js';
import { replayExact } from './replay.js';
import { verifySuiteFile } from './test262-baseline.js';

export function validateSelection(manifest, profile) {
  if (manifest?.schema !== 'tracing-test262-selection/2' ||
      manifest.profile !== profile.profile ||
      manifest.test262Commit !== profile.conformanceSuiteRevisions.test262 ||
      manifest.referencePackage !== profile.referenceEngine.npmPackage ||
      manifest.referenceVersion !== profile.referenceEngine.npmVersion ||
      !Array.isArray(manifest.cases) || manifest.cases.length === 0)
    throw new Error('Unknown, unpinned, or empty Test262 execution selection');

  const seen = new Set();
  for (const entry of manifest.cases) {
    if (typeof entry.path !== 'string' ||
        !/^language\/[a-zA-Z0-9_./-]+\.js$/.test(entry.path) ||
        entry.path.split('/').some(part => part === '..' || part === '.') ||
        !/^[a-f0-9]{40}$/.test(entry.gitBlobSha) || seen.has(entry.path))
      throw new Error('Invalid, unpinned, or duplicate Test262 case path: ' + entry.path);
    if (!['pass','xfail','skip'].includes(entry.baseline))
      throw new Error('Unknown Test262 case expectation: ' + entry.path);
    if (entry.baseline !== 'pass' && (typeof entry.reason !== 'string' || !entry.reason.trim()))
      throw new Error('Every known failure/skip needs a nonempty reason: ' + entry.path);
    seen.add(entry.path);
  }
}

export function checkExecutionFixture(entry, bytes) {
  verifySuiteFile({ path:'test/' + entry.path, gitBlobSha:entry.gitBlobSha }, bytes);
}

export function parseExecutionMetadata(source) {
  const header = /\/\*---\s*\r?\n([\s\S]*?)---\*\//.exec(source)?.[1];
  if (!header) throw new Error('Missing official Test262 metadata');
  const list = name => {
    const line = new RegExp('^' + name + ':[ \t]*(.*)$', 'm').exec(header)?.[1];
    if (line === undefined) return [];
    const match = /^\[([^\]\r\n]*)\][ \t]*$/.exec(line);
    if (!match) throw new Error('Unsupported Test262 ' + name + ' metadata');
    return match[1].split(',').map(x => x.trim()).filter(Boolean);
  };
  const negBlock = /^negative:[ \t]*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)*)/m.exec(header);
  if (/^negative:/m.test(header) && !negBlock)
    throw new Error('Unsupported Test262 negative metadata');
  let negative = null;
  if (negBlock) {
    const phase = /^[ \t]+phase:[ \t]*(\S+)[ \t]*$/m.exec(negBlock[1])?.[1];
    const type = /^[ \t]+type:[ \t]*(\S+)[ \t]*$/m.exec(negBlock[1])?.[1];
    if (!['parse','runtime'].includes(phase) || !/^[A-Za-z]+Error$/.test(type ?? ''))
      throw new Error('Unsupported Test262 negative phase/type');
    negative = {phase,type};
  }
  return {flags:list('flags'),includes:list('includes'),features:list('features'),negative};
}

export function unavailableFeatures(meta, source) {
  return [
    ...meta.flags.filter(flag => flag !== 'noStrict').map(flag => 'flag:' + flag),
    ...meta.includes.map(include => 'include:' + include),
    ...meta.features.map(feature => 'feature:' + feature),
    ...(/\bassert\s*\./.test(source) ? ['assert-harness'] : []),
    ...(/\$262\b|\$DONE\b|\$DONOTEVALUATE\b/.test(source) ? ['test262-host-intrinsics'] : [])
  ];
}

export function runOwnedScript(source) {
  try { compile(parse(source)); }
  catch (error) {
    if (error instanceof SyntaxError) {
      // Early syntax rejection and unsupported compilation are distinct; a
      // compiler rejection must not be counted as a passing Test262 parse error.
      try { parse(source); }
      catch (parseError) { return {phase:'parse',errorName:parseError.name,message:parseError.message}; }
      return {phase:'compile',errorName:error.name,message:error.message};
    }
    throw error;
  }
  const runtime = createRuntime().start(source);
  try {
    const progress = runtime.drive();
    if (progress.kind !== 'terminated') return {phase:'incomplete',status:progress.kind};
    const bundle = runtime.exportRun();
    validateBundle(bundle);
    replayExact(bundle);
    return {phase:'normal'};
  } catch (error) {
    // The bounded VM does not have a complete guest exception lifecycle;
    // a host-side thrown interpreter error is only a diagnostic observation.
    return {phase:'runtime',errorName:error.name,message:error.message};
  }
}

export function matchesTest262Expectation(actual, negative) {
  if (negative) return actual.phase === negative.phase && actual.errorName === negative.type;
  return actual.phase === 'normal';
}

export function classifyExecutionCase(entry, source, referenceRun, ownedRun = runOwnedScript) {
  const meta = parseExecutionMetadata(source);
  const unimplemented = unavailableFeatures(meta,source);
  const row = {path:entry.path,baseline:entry.baseline,negative:meta.negative,
    flags:meta.flags,variant:'sloppy-script-only',blobSha:entry.gitBlobSha};
  if (unimplemented.length || entry.baseline === 'skip') {
    row.status = 'skip';
    row.reasons = [...unimplemented, ...(entry.reason ? [entry.reason] : [])];
    if (entry.baseline !== 'skip')
      row.unexpected = 'Unsupported test unexpectedly classified as ' + entry.baseline;
    return row;
  }

  row.owned = ownedRun(source);
  row.reference = referenceRun(source, {url:'test262/test/' + entry.path});
  row.referencePass = matchesTest262Expectation(row.reference, meta.negative);
  row.status = matchesTest262Expectation(row.owned, meta.negative) ? 'pass' : 'xfail';
  const reasons = [];
  if (!row.referencePass) reasons.push('Reference engine disagrees with official Test262 expectation');
  if (row.status !== entry.baseline)
    reasons.push('Expected ' + entry.baseline + ', observed ' + row.status);
  if (reasons.length) row.unexpected = reasons.join('; ');
  return row;
}

export function summarizeExecutionCases(rows) {
  return {selected:rows.length,executed:rows.filter(x=>x.status!=='skip').length,
    passed:rows.filter(x=>x.status==='pass').length,
    knownFailed:rows.filter(x=>x.status==='xfail').length,
    skipped:rows.filter(x=>x.status==='skip').length,
    unexpected:rows.filter(x=>x.unexpected).length};
}
