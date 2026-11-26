// Safe AST instrumentation and runtime collector for compact native V8 traces.
// Emits causal per-turn lines in the same readable format as owned traceLines()
// without altering JS evaluation order, this/arguments/super, async/await,
// generators, classes, Proxy traps, getters, or Function.name inference.
import {parse} from 'acorn';

const PRIORITY = Object.freeze({
  branch: 1,
  update: 2,
  write: 3,
  return: 4,
});

const BRANCH_NODES = new Set([
  'IfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ConditionalExpression',
]);

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const ANON_NAME_INFERRED_NODES = new Set([
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassExpression',
]);

function compactSource(source, node) {
  if (!node || !Number.isInteger(node.start) || !Number.isInteger(node.end) || node.end <= node.start) return '';
  return source.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
}

function referenceLabel(source, expr) {
  if (expr && (expr.type === 'Identifier' || expr.type === 'MemberExpression')) {
    const text = compactSource(source, expr);
    if (text && text.length <= 120) return text;
  }
  return 'object';
}

function isAnonymousNameInferred(node) {
  return Boolean(node && ANON_NAME_INFERRED_NODES.has(node.type) && !node.id);
}

function resolveFunctionOwner(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent && (parent.type === 'MethodDefinition' || (parent.type === 'Property' && parent.method)) &&
      !parent.computed && parent.key?.type === 'Identifier') {
    return parent.key.name;
  }
  return null;
}

/** Instrument JS source with __traceBranch/__traceWrite/__traceUpdate/__traceReturn.
 * Only instruments AST nodes within [0, sourceLength] so appended host preambles
 * are excluded. Validates instrumented syntax with acorn and falls back cleanly
 * to the uninstrumented source on any parse failure. */
export function instrumentNativeTraceSource(source, {entryName = null, sourceLength = source.length} = {}) {
  const bound = Number.isInteger(sourceLength) && sourceLength >= 0 ? Math.min(sourceLength, source.length) : source.length;
  let ast;
  try {
    ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  } catch {
    return {source, instrumented: false};
  }

  const spans = [];
  let nextId = 0;

  function addSpan(start, end, priority, open, close) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bound) return;
    spans.push({id: nextId++, start, end, priority, open, close});
  }

  function visit(node, parent, owner, inLoopLeft) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, owner, inLoopLeft);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (Number.isInteger(node.start) && node.start >= bound) return;

    const nextOwner = FUNCTION_NODES.has(node.type) ? resolveFunctionOwner(node, parent) : owner;

    if (BRANCH_NODES.has(node.type) && node.test && node.test.end <= bound) {
      const code = compactSource(source, node.test);
      if (code && code.length <= 512) {
        addSpan(
          node.test.start,
          node.test.end,
          PRIORITY.branch,
          'globalThis.__traceBranch(' + JSON.stringify(code) + ',(',
          '))',
        );
      }
    } else if (
      node.type === 'VariableDeclarator' &&
      !inLoopLeft &&
      node.id?.type === 'Identifier' &&
      node.init != null &&
      node.init.end <= bound &&
      !isAnonymousNameInferred(node.init)
    ) {
      const name = node.id.name;
      const rhsLabel = referenceLabel(source, node.init);
      addSpan(
        node.init.start,
        node.init.end,
        PRIORITY.write,
        'globalThis.__traceWrite(' + JSON.stringify(name) + ',(',
        '),' + JSON.stringify(rhsLabel) + ')',
      );
    } else if (
      node.type === 'AssignmentExpression' &&
      node.end <= bound &&
      (node.left.type === 'Identifier' || (node.left.type === 'MemberExpression' && !node.left.optional)) &&
      !(node.operator === '=' && node.left.type === 'Identifier' && isAnonymousNameInferred(node.right))
    ) {
      const leftCode = compactSource(source, node.left);
      if (leftCode && leftCode.length <= 512) {
        const rhsLabel = referenceLabel(source, node.right);
        addSpan(
          node.start,
          node.end,
          PRIORITY.write,
          'globalThis.__traceWrite(' + JSON.stringify(leftCode) + ',(',
          '),' + JSON.stringify(rhsLabel) + ')',
        );
      }
    } else if (node.type === 'UpdateExpression' && node.end <= bound) {
      const argCode = compactSource(source, node.argument);
      if (argCode && argCode.length <= 512) {
        addSpan(
          node.start,
          node.end,
          PRIORITY.update,
          'globalThis.__traceUpdate(' + JSON.stringify(argCode) + ',(',
          '),' + (node.prefix ? 'true' : 'false') + ',' + JSON.stringify(node.operator) + ')',
        );
      }
    } else if (node.type === 'ReturnStatement' && node.argument != null && node.argument.end <= bound) {
      const scope = nextOwner && nextOwner !== entryName && nextOwner !== 'anonymous' ? nextOwner : null;
      const argLabel = referenceLabel(source, node.argument);
      addSpan(
        node.argument.start,
        node.argument.end,
        PRIORITY.return,
        'globalThis.__traceReturn(' + JSON.stringify(scope) + ',(',
        '),' + JSON.stringify(argLabel) + ')',
      );
    }

    const isForInOrOf = node.type === 'ForInStatement' || node.type === 'ForOfStatement';
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'raw') continue;
      if (value && typeof value === 'object') {
        visit(value, node, nextOwner, isForInOrOf && key === 'left');
      }
    }
  }

  visit(ast, null, null, false);
  if (!spans.length) return {source, instrumented: true};

  const opens = new Map();
  const closes = new Map();
  const offsets = new Set();
  for (const span of spans) {
    let openList = opens.get(span.start);
    if (!openList) { openList = []; opens.set(span.start, openList); }
    openList.push(span);
    let closeList = closes.get(span.end);
    if (!closeList) { closeList = []; closes.set(span.end, closeList); }
    closeList.push(span);
    offsets.add(span.start);
    offsets.add(span.end);
  }

  // Deterministic nesting order:
  // Opens (outermost first): larger end, then higher priority (return > write > update > branch), then smaller AST id.
  // Closes (innermost first): larger start, then lower priority, then larger AST id.
  const sortedOffsets = [...offsets].sort((a, b) => a - b);
  let out = '';
  let cursor = 0;
  for (const offset of sortedOffsets) {
    if (offset > cursor) {
      out += source.slice(cursor, offset);
      cursor = offset;
    }
    const closeList = closes.get(offset);
    if (closeList) {
      closeList.sort((a, b) => (b.start - a.start) || (a.priority - b.priority) || (b.id - a.id));
      for (const span of closeList) out += span.close;
    }
    const openList = opens.get(offset);
    if (openList) {
      openList.sort((a, b) => (b.end - a.end) || (b.priority - a.priority) || (a.id - b.id));
      if (out.length > 0 && /[A-Za-z0-9_$]/.test(out[out.length - 1])) out += ' ';
      for (const span of openList) out += span.open;
    }
  }
  if (cursor < source.length) out += source.slice(cursor);

  try {
    parse(out, {ecmaVersion: 'latest', sourceType: 'script'});
  } catch {
    return {source, instrumented: false};
  }
  return {source: out, instrumented: true};
}

function formatScalar(value, maxStringLength = 160) {
  if (value === undefined) return '{"$js":"undefined"}';
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (Number.isNaN(value)) return '{"$js":"NaN"}';
    if (Object.is(value, -0)) return '{"$js":"-0"}';
    if (!Number.isFinite(value)) return value > 0 ? '{"$js":"Infinity"}' : '{"$js":"-Infinity"}';
    return String(value);
  }
  if (kind === 'bigint') return '{"$js":"bigint","value":' + JSON.stringify(String(value)) + '}';
  if (kind === 'string') {
    const clipped = value.length > maxStringLength
      ? value.slice(0, Math.max(0, maxStringLength - 3)) + '...'
      : value;
    return JSON.stringify(clipped);
  }
  // Never inspect objects, Proxies, getters, or call toString()/valueOf().
  return null;
}

function compactArrayHeadTail(lines, maxLines) {
  if (lines.length <= maxLines) return lines;
  if (maxLines <= 1) return lines.slice(0, maxLines);
  if (maxLines === 2) return [lines[0], lines[lines.length - 1]];
  const headCount = Math.floor((maxLines - 1) / 2);
  const tailCount = maxLines - 1 - headCount;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    '... (' + omitted + ' step' + (omitted === 1 ? '' : 's') + ' omitted) ...',
    ...lines.slice(lines.length - tailCount),
  ];
}

/** Streaming per-turn trace collector with O(1) consecutive dedup and O(maxLinesPerTurn)
 * bounded ring-buffer head+tail compaction per turn, plus cross-turn total cap. */
export function createNativeTraceCollector({
  maxLinesPerTurn = 300,
  maxTotalLines = 1500,
  maxStringLength = 160,
} = {}) {
  const headCap = Math.max(1, Math.floor((maxLinesPerTurn - 1) / 2));
  const tailCap = Math.max(1, maxLinesPerTurn - 1 - headCap);
  const newBucket = () => ({head: [], tail: null, tailPos: 0, omitted: 0, lastLine: null});
  const buckets = [newBucket()];

  function emit(line) {
    const bucket = buckets[buckets.length - 1];
    if (bucket.lastLine === line) return;
    bucket.lastLine = line;
    if (bucket.tail === null) {
      if (bucket.head.length < maxLinesPerTurn) {
        bucket.head.push(line);
        return;
      }
      // Transition to head + ring-buffer tail compaction on line (maxLinesPerTurn + 1).
      const prev = bucket.head;
      bucket.head = prev.slice(0, headCap);
      const retainedTail = prev.slice(prev.length - (tailCap - 1));
      bucket.tail = [...retainedTail, line];
      bucket.tailPos = 0;
      bucket.omitted = prev.length - headCap - retainedTail.length;
      return;
    }
    bucket.tail[bucket.tailPos] = line;
    bucket.tailPos = (bucket.tailPos + 1) % tailCap;
    bucket.omitted++;
  }

  function materialize(bucket) {
    if (bucket.tail === null) return bucket.head.slice();
    const orderedTail = bucket.tailPos === 0
      ? bucket.tail.slice()
      : [...bucket.tail.slice(bucket.tailPos), ...bucket.tail.slice(0, bucket.tailPos)];
    const marker = '... (' + bucket.omitted + ' step' + (bucket.omitted === 1 ? '' : 's') + ' omitted) ...';
    return [...bucket.head, marker, ...orderedTail];
  }

  const hooks = {
    __traceBranch(code, value) {
      try {
        const truthy = Boolean(value);
        const scalar = formatScalar(value, maxStringLength);
        emit('branch ' + code + (scalar === null ? '' : ' => ' + scalar) + (truthy ? ' (then)' : ' (else)'));
      } catch {}
      return value;
    },
    __traceWrite(name, value, rhsLabel) {
      try {
        const scalar = formatScalar(value, maxStringLength);
        if (scalar !== null) emit(name + ' = ' + scalar);
        else if (value !== null && typeof value === 'object') emit(name + ' -> ' + (rhsLabel || 'object'));
      } catch {}
      return value;
    },
    __traceUpdate(argCode, value, prefix, operator) {
      try {
        if (typeof value === 'number' || typeof value === 'bigint') {
          const delta = typeof value === 'bigint'
            ? (operator === '++' ? 1n : -1n)
            : (operator === '++' ? 1 : -1);
          const post = prefix ? value : value + delta;
          const scalar = formatScalar(post, maxStringLength);
          if (scalar !== null) emit(argCode + ' = ' + scalar);
        }
      } catch {}
      return value;
    },
    __traceReturn(owner, value, argLabel) {
      try {
        const scope = owner ? ' (' + owner + ')' : '';
        const scalar = formatScalar(value, maxStringLength);
        if (scalar !== null) emit('return' + scope + ' ' + scalar);
        else if (value !== null && typeof value === 'object') emit('return' + scope + ' -> ' + (argLabel || 'object'));
      } catch {}
      return value;
    },
  };

  return {
    hooks,
    nextTurn() {
      buckets.push(newBucket());
    },
    finalize() {
      let turns = buckets.map(materialize);
      let total = turns.reduce((sum, turn) => sum + turn.length, 0);
      if (total > maxTotalLines) {
        const nonEmpty = turns.filter(turn => turn.length > 0).length || 1;
        const perTurnCap = Math.max(3, Math.floor(maxTotalLines / nonEmpty));
        turns = turns.map(turn => compactArrayHeadTail(turn, perTurnCap));
        total = turns.reduce((sum, turn) => sum + turn.length, 0);
        if (total > maxTotalLines) {
          let remaining = maxTotalLines;
          turns = turns.map(turn => {
            if (remaining <= 0) return [];
            const kept = compactArrayHeadTail(turn, remaining);
            remaining -= kept.length;
            return kept;
          });
        }
      }
      return turns;
    },
  };
}
