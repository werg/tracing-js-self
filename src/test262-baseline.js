// A deliberately limited, independently reproducible Test262 *script syntax* slice.
// No Test262 body is ever executed by this module. Runtime conformance requires
// a separate harness with realm isolation, includes, async and negative semantics.
import { createHash } from 'node:crypto';
import { parse, compile } from './frontend.js';

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function verifySuiteFile(entry, data) {
  if (!entry || typeof entry.path !== 'string' ||
      !/^test\/language\/[a-zA-Z0-9_./-]+\.js$/.test(entry.path) ||
      entry.path.split('/').includes('..') || entry.path.split('/').includes('.')) {
    throw new Error('Invalid pinned Test262 path');
  }
  if (!/^[0-9a-f]{40}$/.test(entry.gitBlobSha)) throw new Error('Invalid Test262 blob pin');
  const actual = gitBlobSha(data);
  if (actual !== entry.gitBlobSha) throw new Error(`Test262 blob mismatch at ${entry.path}: ${actual}`);
}

export function parseTest262Metadata(source) {
  const front = /\/\*---\s*\r?\n([\s\S]*?)---\*\//.exec(source);
  if (!front) throw new Error('Missing Test262 metadata header');
  const metadata = front[1];
  const flags = /^flags:\s*\[([^\]\r\n]*)\]/m.exec(metadata);
  // The pinned slice deliberately has no modes that require synthetic strict
  // directives, a module goal, async completion, or special harness behavior.
  if (flags && flags[1].trim()) {
    throw new Error(`Unsupported Test262 flags: ${flags[1]}`);
  }
  if (/^flags:/m.test(metadata) && !flags) throw new Error('Unsupported Test262 flag format');
  const neg = /^negative:\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n)+)/m.exec(metadata);
  if (/^negative:/m.test(metadata) && !neg) throw new Error('Unsupported negative metadata');
  let negativeParse = false;
  if (neg) {
    const phase = /^\s+phase:\s*(\S+)\s*$/m.exec(neg[1])?.[1];
    const type = /^\s+type:\s*(\S+)\s*$/m.exec(neg[1])?.[1];
    if (phase !== 'parse' || type !== 'SyntaxError')
      throw new Error(`Unsupported negative phase/type: ${phase}/${type}`);
    negativeParse = true;
  }
  if (/^includes:/m.test(metadata)) throw new Error('Includes require a full harness');
  return { negativeParse, expectedParseAccepted: !negativeParse };
}

export function inspectBoundedFrontend(source) {
  try {
    const syntaxTree = parse(source);
    try {
      compile(syntaxTree);
      return { parseAccepted: true, compileAccepted: true };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { parseAccepted: true, compileAccepted: false, compilerError: error.message };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { parseAccepted: false, compileAccepted: false, parserError: error.message };
  }
}

export function summarizeSyntaxRows(rows) {
  const summary = { total: rows.length, referencePassed: 0, boundedPassed: 0, boundedKnownGaps: 0,
    boundedParserAccepted: 0, boundedCompilerAccepted: 0 };
  for (const row of rows) {
    if (row.referencePassed) summary.referencePassed++;
    if (row.boundedPassed) summary.boundedPassed++;
    else summary.boundedKnownGaps++;
    if (row.bounded.parseAccepted) summary.boundedParserAccepted++;
    if (row.bounded.compileAccepted) summary.boundedCompilerAccepted++;
  }
  return summary;
}
