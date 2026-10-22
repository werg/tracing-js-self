// Read-only source inventory. This module never imports or executes engine262.
// The extractor records a textual denominator, not ECMAScript conformance.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

export const INVENTORY_SCHEMA = 'engine262-source-inventory/1';
export const INVENTORY_EXTRACTION = Object.freeze({
  version: 1,
  root: 'src/',
  declarations: 'column-zero named function declaration candidates; overloads retained',
  clauses: 'literal https://tc39.es/ URLs with fragments; references are not normative coverage',
  intrinsics: 'quoted literal percent-delimited names; dynamic names are not expanded',
});
const shaPattern = /^[a-f0-9]{40}$/;
const categories = new Set(['abstract-ops', 'runtime-semantics', 'static-semantics',
  'intrinsics', 'execution-context', 'host-defined', 'parser', 'utils', 'ecma402']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hashBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const fail = message => { throw new Error(`Engine inventory: ${message}`); };
const unknownCoverage = () => ({ ownership: 'unclassified', execution: 'untested' });

function sourcePath(path) {
  return typeof path === 'string' && /^src\/[A-Za-z0-9_.\/-]+$/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}

function category(path) {
  const directory = path.split('/')[1];
  return categories.has(directory) ? directory : 'core';
}

/**
 * Build the complete result of the declared textual scans of the supplied tree.
 * No claim is made that declaration candidates are all abstract operations.
 * New candidates are deliberately unclassified and cannot pass verification.
 */
export function discoverEngineInventory({ commit, tree, files }) {
  if (!shaPattern.test(commit) || !shaPattern.test(tree)) fail('invalid revision pin');
  if (!Array.isArray(files) || files.length === 0) fail('no source files');
  const sources = [], declarations = [], clauses = new Map(), intrinsics = new Map();
  const paths = new Set();
  const occurrence = (map, id, location) => {
    if (!map.has(id)) map.set(id, { id, locations: [], coverage: unknownCoverage() });
    const locations = map.get(id).locations;
    if (locations.at(-1) !== location) locations.push(location);
  };
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    if (!sourcePath(file.path) || paths.has(file.path)) fail(`invalid/duplicate source path: ${file.path}`);
    paths.add(file.path);
    if (!['100644', '100755'].includes(file.mode)) fail(`unsupported source mode: ${file.path}`);
    const bytes = Buffer.from(file.bytes);
    if (!shaPattern.test(file.gitBlobSha) || hashBlob(bytes) !== file.gitBlobSha) fail(`source blob mismatch: ${file.path}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    sources.push({ path: file.path, mode: file.mode, gitBlobSha: file.gitBlobSha,
      bytes: bytes.length, category: category(file.path), coverage: unknownCoverage() });
    if (!/\.(?:mts|ts)$/.test(file.path)) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index], location = `${file.path}:${index + 1}`;
      for (const match of line.matchAll(/https:\/\/tc39\.es\/[A-Za-z0-9_./-]+#[A-Za-z0-9_%.:-]+/g)) {
        occurrence(clauses, match[0], location);
      }
      // This intentionally does not pretend to be a TypeScript parser. Its
      // textual rule is versioned above and the entire source file is pinned.
      const declaration = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*(\*)?\s*([A-Za-z_$][\w$]*)\s*[(<]/.exec(line);
      if (declaration) declarations.push({ id: `${location}:${declaration[2]}`,
        path: file.path, line: index + 1, name: declaration[2],
        generator: !!declaration[1], coverage: unknownCoverage() });
      for (const match of line.matchAll(/(['"])(%[A-Za-z][A-Za-z0-9_.]*%)\1/g)) {
        occurrence(intrinsics, match[2], location);
      }
    }
  }
  return { schema: INVENTORY_SCHEMA,
    source: { repository: 'https://github.com/engine262/engine262', commit, tree },
    extraction: { ...INVENTORY_EXTRACTION },
    mappings: [], sources, declarations,
    clauses: [...clauses.values()].sort((a, b) => compare(a.id, b.id)),
    intrinsics: [...intrinsics.values()].sort((a, b) => compare(a.id, b.id)),
  };
}

/** Read exact Git objects, ignoring working-tree edits and replace refs. */
export function readPinnedEngine(repository, expectedCommit) {
  if (!shaPattern.test(expectedCommit)) fail('invalid expected commit');
  const git = (args, options = {}) => execFileSync('git', ['--no-replace-objects', '-C', repository, ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  const head = git(['rev-parse', '--verify', 'HEAD']).trim();
  if (head !== expectedCommit) fail(`checkout is ${head}, expected ${expectedCommit}`);
  const tree = git(['rev-parse', '--verify', `${expectedCommit}^{tree}`]).trim();
  const listing = git(['ls-tree', '-rz', '--full-tree', expectedCommit, '--', 'src/']);
  const entries = listing.split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match || match[2] !== 'blob') fail('unexpected source tree entry');
    return { mode: match[1], gitBlobSha: match[3], path: match[4] };
  });
  if (!entries.length) fail('pinned tree contains no source files');
  const data = git(['cat-file', '--batch'], { encoding: null,
    input: entries.map(entry => entry.gitBlobSha).join('\n') + '\n' });
  let offset = 0;
  const files = entries.map(entry => {
    const end = data.indexOf(10, offset);
    if (end < 0) fail('truncated Git blob header');
    const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(data.subarray(offset, end).toString('ascii'));
    if (!header || header[1] !== entry.gitBlobSha) fail('unexpected Git blob response');
    const size = Number(header[2]), start = end + 1;
    if (!Number.isSafeInteger(size) || start + size >= data.length || data[start + size] !== 10) fail('truncated Git blob');
    const bytes = data.subarray(start, start + size);
    offset = start + size + 1;
    return { ...entry, bytes };
  });
  if (offset !== data.length) fail('trailing Git blob response');
  return { commit: expectedCommit, tree, files };
}

const groups = ['sources', 'declarations', 'clauses', 'intrinsics'];
const idOf = (group, record) => group === 'sources' ? record.path : record.id;

/** Validate every explicit classification, even without an upstream checkout. */
export function validateInventoryStructure(inventory, { expectedCommit } = {}) {
  if (inventory?.schema !== INVENTORY_SCHEMA) fail('unknown schema');
  if (!isDeepStrictEqual(inventory.extraction, INVENTORY_EXTRACTION)) fail('unknown extraction rules');
  if (!shaPattern.test(inventory.source?.commit) || !shaPattern.test(inventory.source?.tree) ||
      inventory.source.repository !== 'https://github.com/engine262/engine262') fail('invalid source identity');
  if (expectedCommit && inventory.source.commit !== expectedCommit) fail('profile commit mismatch');
  if (!Array.isArray(inventory.mappings)) fail('missing ownership mappings');
  const mappings = new Map();
  for (const mapping of inventory.mappings) {
    if (!mapping || typeof mapping.id !== 'string' || !mapping.id || mappings.has(mapping.id)) fail('invalid/duplicate ownership mapping');
    if (mapping.ownership !== 'partial-owned' || typeof mapping.domain !== 'string' || !mapping.domain ||
        !Array.isArray(mapping.limitations) || !mapping.limitations.length ||
        mapping.limitations.some(item => typeof item !== 'string' || !item) ||
        !Array.isArray(mapping.implementation) || !mapping.implementation.length ||
        mapping.implementation.some(path => typeof path !== 'string' || !/^src\/[A-Za-z0-9_./-]+\.js$/.test(path))) {
      fail(`invalid partial-ownership boundary: ${mapping.id}`);
    }
    mappings.set(mapping.id, mapping);
  }
  const ids = new Map();
  for (const group of groups) {
    if (!Array.isArray(inventory[group])) fail(`missing ${group}`);
    const seen = new Set();
    for (const record of inventory[group]) {
      const id = idOf(group, record);
      if (typeof id !== 'string' || !id || seen.has(id)) fail(`invalid/duplicate ${group} entry`);
      seen.add(id);
      const coverage = record.coverage;
      if (!coverage || !['unowned', 'partial-owned'].includes(coverage.ownership)) fail(`unclassified ${group} entry: ${id}`);
      // Execution evidence belongs to Test262/runtime reports; an inventory
      // entry can never manufacture a passing test result by classification.
      if (coverage.execution !== 'untested') fail(`unsupported execution evidence: ${id}`);
      if (coverage.ownership === 'partial-owned') {
        if (!mappings.has(coverage.mapping)) fail(`unknown ownership mapping: ${id}`);
      } else if ('mapping' in coverage) fail(`unowned entry has an ownership mapping: ${id}`);
      if (group === 'sources' && (!sourcePath(record.path) || !shaPattern.test(record.gitBlobSha) ||
          !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !['100644', '100755'].includes(record.mode))) {
        fail(`invalid source record: ${id}`);
      }
    }
    ids.set(group, seen);
  }
  for (const mapping of mappings.values()) {
    if (!Array.isArray(mapping.entries) || !mapping.entries.length) fail(`empty ownership mapping: ${mapping.id}`);
    const seen = new Set();
    for (const entry of mapping.entries) {
      const key = `${entry.group}:${entry.id}`;
      if (!ids.get(entry.group)?.has(entry.id) || seen.has(key)) fail(`unresolved/duplicate mapping target: ${key}`);
      seen.add(key);
      const record = inventory[entry.group].find(item => idOf(entry.group, item) === entry.id);
      if (record.coverage.ownership !== 'partial-owned' || record.coverage.mapping !== mapping.id) fail(`mapping/classification mismatch: ${key}`);
    }
  }
  for (const group of groups) for (const record of inventory[group]) {
    if (record.coverage.ownership === 'partial-owned' && !mappings.get(record.coverage.mapping).entries.some(entry =>
      entry.group === group && entry.id === idOf(group, record))) fail(`unlisted partial-owned entry: ${idOf(group, record)}`);
  }
  return summarizeEngineInventory(inventory);
}

/** Exact equality of all discovered source identities; no wildcard exclusions. */
export function verifyEngineInventory(inventory, upstream, { expectedCommit = upstream.commit } = {}) {
  validateInventoryStructure(inventory, { expectedCommit });
  const discovered = discoverEngineInventory(upstream);
  if (!isDeepStrictEqual(inventory.source, discovered.source)) fail('upstream commit/tree mismatch');
  for (const group of groups) {
    const evidence = rows => rows.map(({ coverage, ...record }) => record);
    if (!isDeepStrictEqual(evidence(inventory[group]), evidence(discovered[group]))) fail(`source discovery mismatch in ${group}; re-audit changed, missing or added entries`);
  }
  return { ...summarizeEngineInventory(inventory), upstreamVerified: true };
}

/** Retain existing classifications while exposing newly discovered unknowns. */
export function reconcileEngineInventory(previous, discovered) {
  const result = structuredClone(discovered);
  result.mappings = structuredClone(previous?.mappings ?? []);
  const oldSources = new Map((previous?.sources ?? []).map(record => [record.path, record]));
  const changedPaths = new Set(result.sources.filter(record => {
    const old = oldSources.get(record.path);
    return !old || old.gitBlobSha !== record.gitBlobSha || old.mode !== record.mode;
  }).map(record => record.path));
  for (const group of groups) {
    const known = new Map((previous?.[group] ?? []).map(record => [idOf(group, record), record]));
    for (const record of result[group]) {
      const old = known.get(idOf(group, record));
      if (!old) continue;
      // A function body can change without moving its declaration or links.
      // Any source-byte change invalidates classifications dependent on it.
      const paths = record.path ? [record.path] : (record.locations ?? []).map(location => location.replace(/:\d+$/, ''));
      if (paths.some(path => changedPaths.has(path))) continue;
      const { coverage: oldCoverage, ...oldEvidence } = old;
      const { coverage, ...newEvidence } = record;
      if (isDeepStrictEqual(oldEvidence, newEvidence)) record.coverage = structuredClone(oldCoverage);
    }
  }
  return result;
}

export function summarizeEngineInventory(inventory) {
  return { schema: 'engine262-source-inventory-report/1', commit: inventory.source.commit,
    tree: inventory.source.tree, upstreamVerified: false, completeEcma262: false,
    denominator: 'pinned source files and textual candidates only; not a conformance percentage',
    counts: Object.fromEntries(groups.map(group => [group, {
      total: inventory[group].length,
      partialOwned: inventory[group].filter(row => row.coverage.ownership === 'partial-owned').length,
      unowned: inventory[group].filter(row => row.coverage.ownership === 'unowned').length,
      unclassified: inventory[group].filter(row => row.coverage.ownership === 'unclassified').length,
      untested: inventory[group].filter(row => row.coverage.execution === 'untested').length,
    }])) };
}

/** Compact, deterministic JSON: one reviewable record per line. */
export function formatEngineInventory(inventory) {
  const header = Object.fromEntries(Object.entries(inventory).filter(([key]) => !groups.includes(key)));
  const prefix = JSON.stringify(header, null, 2).slice(0, -2);
  return `${prefix},\n${groups.map(group => `  "${group}": [\n${inventory[group].map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`).join(',\n')}\n}\n`;
}
