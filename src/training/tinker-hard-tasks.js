// Hard JavaScript execution & multi-turn agentic side-effect suite.
// 25 independent families across three groups:
//   Group A (9 families): Deep multi-step stateful algorithms & interpreters
//   Group B (8 families): Tricky JS semantics, OOP classes, closures & cyclic/aliased graphs
//   Group C (8 families): Complex multi-turn agentic workflows (6-14 tool calls, custom nativeBindings + host APIs)
// Every family is 100% deterministic strict-mode JS (no Math.random()).

const natCall = (name, args, result, extra = {}) => ({
  operation: 'natlang.call',
  arguments: [name, undefined, args],
  result,
  ...extra,
});

function makeCyclicGraph(variant) {
  if (variant === 0) {
    const shared = {tag: 's', n: 3};
    const a = {name: 'a', ref: shared, val: 10};
    const b = {name: 'b', ref: shared, prev: a};
    a.next = b;
    return [a, [['set', 'val', 15], ['set', 'ref.n', 7], ['set', 'next.extra', 1]]];
  }
  if (variant === 1) {
    const root = {id: 'r0', count: 1};
    const child = {id: 'c1', count: 2, parent: root};
    root.left = child;
    root.right = child;
    root.self = root;
    return [root, [['set', 'left.count', 9], ['del', 'right'], ['set', 'count', 4]]];
  }
  if (variant === 2) {
    const n1 = {k: 1}, n2 = {k: 2}, n3 = {k: 3};
    n1.next = n2; n2.next = n3; n3.next = n1;
    n2.alt = n3;
    return [n1, [['set', 'next.k', 20], ['alias', 'shortcut', 'next.next'], ['set', 'shortcut.k', 33]]];
  }
  if (variant === 3) {
    const leaf = {v: 5};
    const arr = [leaf, leaf];
    const root = {items: arr, primary: leaf, meta: {ok: true}};
    leaf.owner = root;
    return [root, [['set', 'primary.v', 12], ['del', 'meta.ok'], ['set', 'meta.done', 1]]];
  }
  const hub = {score: 0};
  const x = {label: 'x', hub};
  const y = {label: 'y', hub, peer: x};
  x.peer = y;
  hub.entry = x;
  return [x, [['set', 'hub.score', 42], ['alias', 'mirror', 'peer'], ['del', 'peer.hub'], ['set', 'label', 'x2']]];
}

function makeAliasedPatchDoc(variant) {
  if (variant === 0) {
    const shared = {limit: 10, active: true};
    const doc = {cfg: shared, backup: shared, users: ['ada', 'bob']};
    return [doc, [
      {op: 'test', path: 'cfg.limit', value: 10},
      {op: 'replace', path: 'cfg.limit', value: 25},
      {op: 'add', path: 'cfg.tier', value: 'pro'},
      {op: 'add', path: 'users.2', value: 'cy'},
    ]];
  }
  if (variant === 1) {
    const shared = {limit: 10, active: true};
    const doc = {cfg: shared, backup: shared, meta: {ver: 1}};
    return [doc, [
      {op: 'replace', path: 'cfg.limit', value: 99},
      {op: 'remove', path: 'cfg.active'},
      {op: 'add', path: 'meta.tag', value: 'v2'},
      {op: 'test', path: 'backup.limit', value: 50},
      {op: 'replace', path: 'meta.ver', value: 2},
    ]];
  }
  if (variant === 2) {
    const node = {x: 1, y: 2};
    const doc = {a: node, b: node, c: {z: 3}};
    return [doc, [
      {op: 'copy', from: 'a.x', path: 'c.x'},
      {op: 'move', from: 'c.z', path: 'b.z'},
      {op: 'test', path: 'a.z', value: 3},
      {op: 'replace', path: 'a.y', value: 8},
    ]];
  }
  if (variant === 3) {
    const nested = {count: 4, flags: {a: 1, b: 2}};
    const doc = {main: nested, ref: nested, status: 'init'};
    return [doc, [
      {op: 'replace', path: 'status', value: 'running'},
      {op: 'remove', path: 'main.flags.a'},
      {op: 'move', from: 'ref.count', path: 'saved'},
      {op: 'test', path: 'main.flags.b', value: 999},
    ]];
  }
  const shared = {score: 7};
  const doc = {p: shared, q: shared, list: [1, 2]};
  return [doc, [
    {op: 'add', path: 'p.bonus', value: 3},
    {op: 'test', path: 'q.bonus', value: 3},
    {op: 'replace', path: 'q.score', value: 11},
    {op: 'copy', from: 'p.score', path: 'list.1'},
    {op: 'remove', path: 'p.bonus'},
  ]];
}

function makeSparseInput(variant) {
  const specs = [
    [[['retOverride', 4, 1], ['labelLoop', 3, 4, 5], ['shortCircuit', 0, 5, 2], ['sparseOp', 1, 9]], 4],
    [[['retOverride', 7, 0], ['labelLoop', 4, 4, 9], ['shortCircuit', 2, 0, 3], ['sparseOp', 2, 11]], 5],
    [[['retOverride', -2, 2], ['labelLoop', 3, 5, 6], ['shortCircuit', 1, 4, 0], ['sparseOp', 0, 6]], 4],
    [[['retOverride', 9, 0], ['retOverride', 3, 1], ['labelLoop', 4, 3, 7], ['shortCircuit', 0, 0, 8], ['sparseOp', 3, 5]], 5],
    [[['retOverride', 5, 2], ['labelLoop', 5, 4, 11], ['shortCircuit', 3, 6, 4], ['sparseOp', 1, 14]], 5],
  ][variant];
  const slots = new Array(specs[1]);
  slots[0] = 10;
  slots[2] = undefined;
  return [specs[0], slots, []];
}

export function hardTaskTemplates() {
  return [
    // =========================================================================
    // GROUP A: Deep multi-step stateful algorithms & interpreters (9 families)
    // =========================================================================

    // A1. Stack/frame bytecode VM with jumps, locals, function calls & recursion
    {
      name: 'bytecode-stack-vm',
      source: `function run(program, initLocals) {
  const stack = [];
  const frames = [{retIp: -1, locals: {}}];
  const initKeys = Object.keys(initLocals);
  for (let i = 0; i < initKeys.length; i++) frames[0].locals[initKeys[i]] = initLocals[initKeys[i]];
  let ip = 0, steps = 0, maxStack = 0, callCount = 0;
  while (ip >= 0 && ip < program.length) {
    const ins = program[ip++];
    const op = ins[0];
    steps++;
    const cur = frames[frames.length - 1];
    switch (op) {
      case 'PUSH': stack.push(ins[1]); break;
      case 'LOAD': stack.push(cur.locals[ins[1]] ?? 0); break;
      case 'STORE': cur.locals[ins[1]] = stack.pop(); break;
      case 'DUP': stack.push(stack[stack.length - 1]); break;
      case 'ADD': { const b = stack.pop(), a = stack.pop(); stack.push(a + b); break; }
      case 'SUB': { const b = stack.pop(), a = stack.pop(); stack.push(a - b); break; }
      case 'MUL': { const b = stack.pop(), a = stack.pop(); stack.push(a * b); break; }
      case 'MOD': { const b = stack.pop(), a = stack.pop(); stack.push(a % b); break; }
      case 'LT': { const b = stack.pop(), a = stack.pop(); stack.push(a < b ? 1 : 0); break; }
      case 'JZ': { const c = stack.pop(); if (c === 0) ip = ins[1]; break; }
      case 'JMP': ip = ins[1]; break;
      case 'CALL': {
        const nextLocals = {};
        nextLocals[ins[2]] = stack.pop();
        frames.push({retIp: ip, locals: nextLocals});
        callCount++;
        ip = ins[1];
        break;
      }
      case 'RET': {
        const frame = frames.pop();
        ip = frame.retIp;
        if (ip === -1) ip = program.length;
        break;
      }
      case 'HALT': ip = program.length; break;
    }
    if (stack.length > maxStack) maxStack = stack.length;
  }
  return {result: stack.length ? stack[stack.length - 1] : null, steps, maxStack, callCount};
}`,
      inputs: [
        // 0: Iterative sum of squares 1^2 + ... + n^2 with n=4
        [[
          ['PUSH', 0], ['STORE', 'acc'],
          ['LOAD', 'n'], ['JZ', 15],
          ['LOAD', 'n'], ['DUP'], ['MUL'], ['LOAD', 'acc'], ['ADD'], ['STORE', 'acc'],
          ['LOAD', 'n'], ['PUSH', 1], ['SUB'], ['STORE', 'n'],
          ['JMP', 2],
          ['LOAD', 'acc'], ['HALT'],
        ], {n: 4}],
        // 1: Recursive factorial(5) using CALL/RET frames
        [[
          ['LOAD', 'n'], ['CALL', 3, 'x'], ['HALT'],
          ['LOAD', 'x'], ['PUSH', 2], ['LT'], ['JZ', 9],
          ['PUSH', 1], ['RET'],
          ['LOAD', 'x'], ['LOAD', 'x'], ['PUSH', 1], ['SUB'], ['CALL', 3, 'x'], ['MUL'], ['RET'],
        ], {n: 5}],
        // 2: Euclidean GCD(48, 18) loop using MOD
        [[
          ['LOAD', 'b'], ['JZ', 11],
          ['LOAD', 'a'], ['LOAD', 'b'], ['MOD'], ['STORE', 't'],
          ['LOAD', 'b'], ['STORE', 'a'],
          ['LOAD', 't'], ['STORE', 'b'],
          ['JMP', 0],
          ['LOAD', 'a'], ['HALT'],
        ], {a: 48, b: 18}],
        // 3: Recursive fib(4)
        [[
          ['LOAD', 'n'], ['CALL', 3, 'k'], ['HALT'],
          ['LOAD', 'k'], ['PUSH', 2], ['LT'], ['JZ', 9],
          ['LOAD', 'k'], ['RET'],
          ['LOAD', 'k'], ['PUSH', 1], ['SUB'], ['CALL', 3, 'k'],
          ['LOAD', 'k'], ['PUSH', 2], ['SUB'], ['CALL', 3, 'k'],
          ['ADD'], ['RET'],
        ], {n: 4}],
        // 4: Loop calling helper f(k)=k*2+1 for k=1..4 and summing
        [[
          ['PUSH', 0], ['STORE', 'sum'],
          ['LOAD', 'i'], ['LOAD', 'limit'], ['LT'], ['JZ', 16],
          ['LOAD', 'i'], ['CALL', 18, 'v'],
          ['LOAD', 'sum'], ['ADD'], ['STORE', 'sum'],
          ['LOAD', 'i'], ['PUSH', 1], ['ADD'], ['STORE', 'i'],
          ['JMP', 2],
          ['LOAD', 'sum'], ['HALT'],
          ['LOAD', 'v'], ['PUSH', 2], ['MUL'], ['PUSH', 1], ['ADD'], ['RET'],
        ], {i: 1, limit: 5}],
      ],
      features: ['loop', 'branch', 'array', 'object', 'nullish', 'vm', 'hard-algorithm'],
      tier: 5,
    },

    // A2. Recursive-descent expression parser + short-circuiting AST evaluator
    {
      name: 'recursive-descent-expr-eval',
      source: `function run(toks, env) {
  let pos = 0, lookups = 0, nodes = 0;
  function parseTernary() {
    let node = parseLogic();
    if (toks[pos] === '?') {
      pos++;
      const t = parseTernary();
      pos++; // ':'
      const f = parseTernary();
      node = ['?:', node, t, f];
    }
    return node;
  }
  function parseLogic() {
    let left = parseCmp();
    while (toks[pos] === '||' || toks[pos] === '&&') {
      const op = toks[pos++];
      left = [op, left, parseCmp()];
    }
    return left;
  }
  function parseCmp() {
    let left = parseAdd();
    while (toks[pos] === '<' || toks[pos] === '>' || toks[pos] === '==') {
      const op = toks[pos++];
      left = [op, left, parseAdd()];
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (toks[pos] === '+' || toks[pos] === '-') {
      const op = toks[pos++];
      left = [op, left, parseMul()];
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (toks[pos] === '*' || toks[pos] === '/' || toks[pos] === '%') {
      const op = toks[pos++];
      left = [op, left, parseUnary()];
    }
    return left;
  }
  function parseUnary() {
    const t = toks[pos];
    if (t === '-' || t === '!') { pos++; return ['u' + t, parseUnary()]; }
    if (t === '(') {
      pos++;
      const inner = parseTernary();
      pos++; // ')'
      return inner;
    }
    pos++;
    return typeof t === 'number' ? ['num', t] : ['id', t];
  }
  function evalNode(n) {
    nodes++;
    const tag = n[0];
    if (tag === 'num') return n[1];
    if (tag === 'id') { lookups++; return env[n[1]]; }
    if (tag === 'u-') return -evalNode(n[1]);
    if (tag === 'u!') return evalNode(n[1]) ? 0 : 1;
    if (tag === '?:') return evalNode(n[1]) ? evalNode(n[2]) : evalNode(n[3]);
    if (tag === '&&') { const l = evalNode(n[1]); return l ? evalNode(n[2]) : 0; }
    if (tag === '||') { const l = evalNode(n[1]); return l ? l : evalNode(n[2]); }
    const l = evalNode(n[1]), r = evalNode(n[2]);
    if (tag === '+') return l + r;
    if (tag === '-') return l - r;
    if (tag === '*') return l * r;
    if (tag === '/') return Math.trunc(l / r);
    if (tag === '%') return l % r;
    if (tag === '<') return l < r ? 1 : 0;
    if (tag === '>') return l > r ? 1 : 0;
    return l === r ? 1 : 0;
  }
  const ast = parseTernary();
  const value = evalNode(ast);
  return {value, lookups, nodes};
}`,
      inputs: [
        [['(', 'a', '+', 'b', '*', 3, ')', '>', 10, '?', '-', 'a', '+', 'c', ':', 'b', '%', 3], {a: 2, b: 4, c: 9}],
        [['!', 'flag', '&&', '(', 'x', '/', 2, '+', 'y', ')', '||', '(', 'z', '-', 'x', '*', 2, ')'], {flag: 1, x: 6, y: 5, z: 20}],
        [['a', '<', 'b', '?', 'b', '<', 'c', '?', 'c', '-', 'a', ':', 'b', '+', 'c', ':', 'a', '*', 2], {a: 3, b: 7, c: 5}],
        [['-', '(', 'x', '-', 'y', '*', 2, ')', '+', '(', 'z', '%', 4, '==', 1, '?', 'a', '+', 'b', ':', 'a', '-', 'b', ')'], {x: 3, y: 4, z: 9, a: 10, b: 3}],
        [['(', 'k', '>', 0, '&&', 'm', '-', 2, '>', 0, ')', '?', '(', 'k', '*', 'm', '-', '!', 0, ')', ':', '(', 'n', '+', 'k', ')'], {k: 4, m: 5, n: 100}],
      ],
      features: ['recursion', 'loop', 'branch', 'string', 'closure', 'parser', 'hard-algorithm'],
      tier: 5,
    },

    // A3. Glob / wildcard pattern matcher (*, ?, [a-z], [!a-z], escaping) with memoized backtracking
    {
      name: 'glob-wildcard-matcher',
      source: `function parsePattern(pat) {
  const ops = [];
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '\\\\' && i + 1 < pat.length) { ops.push(['lit', pat[i + 1]]); i += 2; }
    else if (ch === '*') { if (!ops.length || ops[ops.length - 1][0] !== 'star') ops.push(['star']); i++; }
    else if (ch === '?') { ops.push(['any']); i++; }
    else if (ch === '[') {
      i++;
      let neg = false;
      if (i < pat.length && pat[i] === '!') { neg = true; i++; }
      const chars = [], ranges = [];
      while (i < pat.length && pat[i] !== ']') {
        if (i + 2 < pat.length && pat[i + 1] === '-' && pat[i + 2] !== ']') {
          ranges.push([pat[i], pat[i + 2]]);
          i += 3;
        } else {
          chars.push(pat[i]);
          i++;
        }
      }
      i++; // skip ']'
      ops.push(['cls', neg, chars, ranges]);
    } else { ops.push(['lit', ch]); i++; }
  }
  return ops;
}
function matchClass(op, ch) {
  const neg = op[1], chars = op[2], ranges = op[3];
  let hit = false;
  for (let i = 0; i < chars.length; i++) if (chars[i] === ch) { hit = true; break; }
  if (!hit) {
    for (let i = 0; i < ranges.length; i++) if (ch >= ranges[i][0] && ch <= ranges[i][1]) { hit = true; break; }
  }
  return neg ? !hit : hit;
}
function matchOne(pat, text) {
  const ops = parsePattern(pat);
  const memo = Object.create(null);
  let calls = 0;
  function dfs(pi, ti) {
    const key = pi + ':' + ti;
    if (key in memo) return memo[key];
    calls++;
    let ok = false;
    if (pi === ops.length) ok = ti === text.length;
    else {
      const op = ops[pi];
      if (op[0] === 'star') {
        ok = dfs(pi + 1, ti) || (ti < text.length && dfs(pi, ti + 1));
      } else if (ti < text.length) {
        const hit = op[0] === 'any' || (op[0] === 'lit' && text[ti] === op[1]) || (op[0] === 'cls' && matchClass(op, text[ti]));
        if (hit) ok = dfs(pi + 1, ti + 1);
      }
    }
    memo[key] = ok;
    return ok;
  }
  return {matched: dfs(0, 0), calls};
}
function run(pairs) {
  const results = [];
  let matchedCount = 0, totalCalls = 0;
  for (let i = 0; i < pairs.length; i++) {
    const r = matchOne(pairs[i][0], pairs[i][1]);
    results.push(r.matched);
    if (r.matched) matchedCount++;
    totalCalls += r.calls;
  }
  return {results, matchedCount, totalCalls};
}`,
      inputs: [
        [[['a*c?e', 'abbcde'], ['a*c?e', 'abce'], ['[!0-9]*', 'x99'], ['[!0-9]*', '5ab']]],
        [[['f[a-c]*.js', 'fb_test.js'], ['f[a-c]*.js', 'fd_test.js'], ['a\\*b', 'a*b'], ['a\\*b', 'axxb']]],
        [[['*ab*cd*', 'xxabyycdzz'], ['*ab*cd*', 'xxabzzc'], ['[a-z][0-9]?', 'k7x'], ['[a-z][0-9]?', 'k7']]],
        [[['?*[!a-e][0-9]', 'p_z4'], ['?*[!a-e][0-9]', 'p_b4'], ['*\\?[a-c]', 'hi?b'], ['*\\?[a-c]', 'hixb']]],
        [[['[a-c]*[x-z]*[0-2]', 'b_y_1'], ['[a-c]*[x-z]*[0-2]', 'b_m_1'], ['a?*b', 'ab'], ['a?*b', 'axb']]],
      ],
      features: ['recursion', 'loop', 'branch', 'string', 'null-prototype', 'backtracking', 'hard-algorithm'],
      tier: 5,
    },

    // A4. Weighted-graph Dijkstra shortest path + deterministic settlement order + relaxation count
    {
      name: 'dijkstra-weighted-shortest-path',
      source: `function run(nodes, edges, start, goal) {
  const adj = Object.create(null);
  const dist = Object.create(null);
  const prev = Object.create(null);
  const done = Object.create(null);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    adj[n] = [];
    dist[n] = Infinity;
    prev[n] = null;
    done[n] = false;
  }
  for (let i = 0; i < edges.length; i++) adj[edges[i][0]].push([edges[i][1], edges[i][2]]);
  dist[start] = 0;
  const order = [];
  let relaxed = 0;
  while (true) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!done[n] && (dist[n] < bestD || (dist[n] === bestD && best !== null && n < best))) {
        best = n;
        bestD = dist[n];
      }
    }
    if (best === null || bestD === Infinity) break;
    done[best] = true;
    order.push(best);
    if (best === goal) break;
    const list = adj[best];
    for (let i = 0; i < list.length; i++) {
      const to = list[i][0], w = list[i][1];
      const cand = bestD + w;
      if (!done[to] && (cand < dist[to] || (cand === dist[to] && (prev[to] === null || best < prev[to])))) {
        dist[to] = cand;
        prev[to] = best;
        relaxed++;
      }
    }
  }
  if (dist[goal] === Infinity) return {found: false, distance: -1, path: [], relaxed, order};
  const path = [];
  let cur = goal;
  while (cur !== null) { path.push(cur); cur = prev[cur]; }
  path.reverse();
  return {found: true, distance: dist[goal], path, relaxed, order};
}`,
      inputs: [
        [['s', 'a', 'b', 'c', 't'], [['s', 'a', 4], ['s', 'b', 2], ['b', 'a', 1], ['a', 'c', 3], ['b', 'c', 6], ['c', 't', 2], ['a', 't', 7]], 's', 't'],
        [['a', 'b', 'c', 'd', 'e', 'f'], [['a', 'b', 5], ['a', 'c', 1], ['c', 'b', 2], ['c', 'd', 4], ['b', 'd', 1], ['b', 'e', 6], ['d', 'e', 2], ['d', 'f', 5], ['e', 'f', 1]], 'a', 'f'],
        [['n0', 'n1', 'n2', 'n3', 'n4', 'n5'], [['n0', 'n1', 3], ['n0', 'n2', 3], ['n1', 'n3', 4], ['n2', 'n3', 2], ['n2', 'n4', 7], ['n3', 'n4', 1], ['n3', 'n5', 6], ['n4', 'n5', 2]], 'n0', 'n5'],
        [['p', 'q', 'r', 's', 'u'], [['p', 'q', 2], ['q', 'r', 3], ['s', 'u', 1]], 'p', 'u'],
        [['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'], [['v0', 'v1', 2], ['v0', 'v2', 5], ['v1', 'v2', 2], ['v1', 'v3', 6], ['v2', 'v3', 1], ['v2', 'v4', 4], ['v3', 'v5', 2], ['v4', 'v5', 1], ['v4', 'v6', 5], ['v5', 'v6', 2]], 'v0', 'v6'],
      ],
      features: ['loop', 'branch', 'array', 'object', 'null-prototype', 'graph', 'hard-algorithm'],
      tier: 5,
    },

    // A5. Disjoint-Set Union (Union-Find) with path compression, union-by-rank & component queries
    {
      name: 'union-find-component-tracker',
      source: `function run(n, ops) {
  const parent = [], rank = [], size = [];
  for (let i = 0; i < n; i++) { parent.push(i); rank.push(0); size.push(1); }
  let components = n, compressions = 0;
  function find(x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      compressions++;
      cur = next;
    }
    return root;
  }
  const answers = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === 'union') {
      const ra = find(op[1]), rb = find(op[2]);
      if (ra !== rb) {
        if (rank[ra] < rank[rb]) { parent[ra] = rb; size[rb] += size[ra]; }
        else if (rank[ra] > rank[rb]) { parent[rb] = ra; size[ra] += size[rb]; }
        else { parent[rb] = ra; size[ra] += size[rb]; rank[ra]++; }
        components--;
        answers.push(true);
      } else answers.push(false);
    } else if (op[0] === 'connected') {
      answers.push(find(op[1]) === find(op[2]));
    } else if (op[0] === 'size') {
      answers.push(size[find(op[1])]);
    } else if (op[0] === 'components') {
      answers.push(components);
    }
  }
  return {answers, components, compressions, parent, rank};
}`,
      inputs: [
        [6, [['union', 0, 1], ['union', 2, 3], ['union', 1, 3], ['size', 3], ['connected', 0, 3], ['union', 4, 5], ['union', 3, 5], ['components'], ['connected', 2, 5]]],
        [7, [['union', 0, 1], ['union', 1, 2], ['union', 3, 4], ['union', 4, 5], ['union', 2, 5], ['union', 5, 6], ['size', 6], ['union', 0, 6], ['components']]],
        [5, [['union', 0, 1], ['union', 2, 3], ['union', 3, 4], ['connected', 0, 4], ['union', 1, 4], ['connected', 0, 4], ['size', 2], ['size', 0]]],
        [8, [['union', 0, 1], ['union', 2, 3], ['union', 4, 5], ['union', 6, 7], ['union', 1, 3], ['union', 5, 7], ['union', 3, 7], ['size', 7], ['connected', 0, 7], ['connected', 2, 6]]],
        [6, [['union', 5, 4], ['union', 3, 2], ['union', 1, 0], ['union', 4, 2], ['union', 2, 0], ['size', 0], ['union', 5, 1], ['components'], ['connected', 3, 1]]],
      ],
      features: ['loop', 'branch', 'array', 'mutation', 'closure', 'hard-algorithm'],
      tier: 5,
    },

    // A6. Conway's Game of Life multi-generation 2D cellular automaton
    {
      name: 'game-of-life-multigen',
      source: `function stepGrid(grid) {
  const rows = grid.length, cols = grid[0].length;
  const zeroRow = [];
  for (let i = 0; i < cols + 2; i++) zeroRow.push(0);
  const pad = [zeroRow];
  for (let r = 0; r < rows; r++) pad.push([0, ...grid[r], 0]);
  pad.push(zeroRow);
  const next = [];
  let births = 0, deaths = 0, alive = 0;
  for (let r = 1; r <= rows; r++) {
    const up = pad[r - 1], mid = pad[r], dn = pad[r + 1];
    const row = [];
    for (let c = 1; c <= cols; c++) {
      const n = up[c - 1] + up[c] + up[c + 1] + mid[c - 1] + mid[c + 1] + dn[c - 1] + dn[c] + dn[c + 1];
      const cur = mid[c];
      const cell = cur === 1 ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
      if (cur === 0 && cell === 1) births++;
      else if (cur === 1 && cell === 0) deaths++;
      alive += cell;
      row.push(cell);
    }
    next.push(row);
  }
  return {grid: next, births, deaths, alive};
}
function run(initial, generations) {
  let grid = initial;
  const liveCounts = [];
  let totalBirths = 0, totalDeaths = 0;
  for (let g = 0; g < generations; g++) {
    const res = stepGrid(grid);
    grid = res.grid;
    liveCounts.push(res.alive);
    totalBirths += res.births;
    totalDeaths += res.deaths;
  }
  return {grid, liveCounts, totalBirths, totalDeaths};
}`,
      inputs: [
        // 0: 5x5 glider for 3 generations
        [[[0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [1, 1, 1, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], 3],
        // 1: 5x5 R-pentomino-like seed for 3 generations
        [[[0, 0, 0, 0, 0], [0, 0, 1, 1, 0], [0, 1, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 0, 0]], 3],
        // 2: 5x5 toad + block for 3 generations
        [[[1, 1, 0, 0, 0], [1, 1, 0, 0, 0], [0, 0, 1, 1, 1], [0, 1, 1, 1, 0], [0, 0, 0, 0, 0]], 3],
        // 3: 4x5 colliding blinkers for 3 generations
        [[[0, 1, 0, 0, 0], [0, 1, 0, 1, 0], [0, 1, 0, 1, 0], [0, 0, 0, 1, 0]], 3],
        // 4: 5x5 beacon + corner seed for 3 generations
        [[[1, 1, 0, 0, 1], [1, 0, 0, 1, 1], [0, 0, 0, 1, 0], [0, 0, 1, 1, 0], [0, 0, 0, 0, 0]], 3],
      ],
      features: ['loop', 'branch', 'array', 'multi-function', 'cellular-automaton', 'hard-algorithm'],
      tier: 5,
    },

    // A7. Backtracking 4x4 Sudoku constraint solver
    {
      name: 'sudoku4-constraint-solver',
      source: `function canPlace(grid, r, c, val) {
  for (let i = 0; i < 4; i++) {
    if (grid[r][i] === val || grid[i][c] === val) return false;
  }
  const br = r < 2 ? 0 : 2, bc = c < 2 ? 0 : 2;
  for (let dr = 0; dr < 2; dr++) {
    for (let dc = 0; dc < 2; dc++) {
      if (grid[br + dr][bc + dc] === val) return false;
    }
  }
  return true;
}
function run(puzzle) {
  const grid = [];
  const empties = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      row.push(puzzle[r][c]);
      if (puzzle[r][c] === 0) empties.push([r, c]);
    }
    grid.push(row);
  }
  let placements = 0, backtracks = 0;
  function solve(idx) {
    if (idx === empties.length) return true;
    const r = empties[idx][0], c = empties[idx][1];
    for (let val = 1; val <= 4; val++) {
      if (canPlace(grid, r, c, val)) {
        grid[r][c] = val;
        placements++;
        if (solve(idx + 1)) return true;
        grid[r][c] = 0;
        backtracks++;
      }
    }
    return false;
  }
  const solved = solve(0);
  return {solved, grid, placements, backtracks};
}`,
      inputs: [
        [[[1, 0, 0, 4], [0, 0, 1, 0], [0, 1, 0, 0], [4, 0, 0, 2]]],
        [[[0, 2, 0, 0], [0, 0, 3, 0], [0, 4, 0, 0], [0, 0, 1, 2]]],
        [[[0, 0, 3, 0], [2, 0, 0, 4], [4, 0, 0, 1], [0, 3, 0, 0]]],
        [[[1, 2, 0, 0], [0, 0, 1, 2], [2, 1, 0, 0], [0, 0, 4, 3]]], // triggers backtracking
        [[[1, 0, 2, 0], [0, 3, 0, 4], [3, 0, 1, 0], [0, 2, 0, 3]]], // unsolvable -> full backtrack
      ],
      features: ['recursion', 'loop', 'branch', 'array', 'backtracking', 'hard-algorithm'],
      tier: 5,
    },

    // A8. Levenshtein edit-distance DP with deterministic edit-script backtrace
    {
      name: 'levenshtein-edit-script',
      source: `function run(src, dst) {
  const m = src.length, n = dst.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    const row = [];
    for (let j = 0; j <= n; j++) row.push(i === 0 ? j : j === 0 ? i : 0);
    dp.push(row);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const diag = dp[i - 1][j - 1] + (src[i - 1] === dst[j - 1] ? 0 : 1);
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      let best = diag;
      if (del < best) best = del;
      if (ins < best) best = ins;
      dp[i][j] = best;
    }
  }
  const ops = [];
  const counts = {keep: 0, sub: 0, ins: 0, del: 0};
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && src[i - 1] === dst[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push('keep:' + src[i - 1]);
      counts.keep++;
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push('sub:' + src[i - 1] + '->' + dst[j - 1]);
      counts.sub++;
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push('del:' + src[i - 1]);
      counts.del++;
      i--;
    } else {
      ops.push('ins:' + dst[j - 1]);
      counts.ins++;
      j--;
    }
  }
  ops.reverse();
  return {distance: dp[m][n], ops, counts};
}`,
      inputs: [
        ['kitten', 'sitting'],
        ['sunday', 'saturday'],
        ['flaw', 'lawn'],
        ['abacaba', 'abcbba'],
        ['trace', 'crater'],
      ],
      features: ['loop', 'branch', 'array', 'string', 'dp', 'hard-algorithm'],
      tier: 5,
    },

    // A9. Huffman prefix-code builder + bitstream encoder/decoder roundtrip
    {
      name: 'huffman-prefix-coder',
      source: `function cmpNode(a, b) {
  if (a.w !== b.w) return a.w - b.w;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
function insertSorted(list, node) {
  list.push(node);
  let i = list.length - 1;
  while (i > 0 && cmpNode(list[i - 1], list[i]) > 0) {
    const tmp = list[i - 1]; list[i - 1] = list[i]; list[i] = tmp;
    i--;
  }
}
function assignCodes(node, prefix, codes) {
  if (node.leaf) { codes[node.ch] = prefix.length ? prefix : '0'; return; }
  assignCodes(node.left, prefix + '0', codes);
  assignCodes(node.right, prefix + '1', codes);
}
function run(text) {
  const freq = Object.create(null);
  for (let i = 0; i < text.length; i++) freq[text[i]] = (freq[text[i]] ?? 0) + 1;
  const keys = Object.keys(freq);
  const queue = [];
  for (let i = 0; i < keys.length; i++) {
    const ch = keys[i];
    insertSorted(queue, {leaf: true, ch, key: ch, w: freq[ch]});
  }
  while (queue.length > 1) {
    const a = queue.shift(), b = queue.shift();
    const mergedKey = a.key < b.key ? a.key : b.key;
    insertSorted(queue, {leaf: false, key: mergedKey, w: a.w + b.w, left: a, right: b});
  }
  const root = queue[0];
  const codes = {};
  assignCodes(root, '', codes);
  let bits = '';
  for (let i = 0; i < text.length; i++) bits += codes[text[i]];
  let decoded = '', cur = root;
  for (let i = 0; i < bits.length; i++) {
    if (!cur.leaf) cur = bits[i] === '0' ? cur.left : cur.right;
    if (cur.leaf) { decoded += cur.ch; cur = root; }
  }
  return {codes, bits, bitLength: bits.length, decodedOk: decoded === text};
}`,
      inputs: [
        ['abracadabra'],
        ['beep boop beer!'],
        ['mississippi'],
        ['aaabbbccde'],
        ['banana_bandana'],
      ],
      features: ['recursion', 'loop', 'branch', 'string', 'object', 'null-prototype', 'multi-function', 'hard-algorithm'],
      tier: 5,
    },

    // =========================================================================
    // GROUP B: Tricky JS semantics, OOP classes, closures & cyclic/aliased graphs (8 families)
    // =========================================================================

    // B1. ES6 class hierarchy with extends, super, getters, and polymorphic state
    {
      name: 'class-hierarchy-bank-accounts',
      source: `function makeAccountClasses() {
  class Account {
    constructor(id, balance) {
      this.id = id;
      this.balance = balance;
      this.ops = 0;
    }
    get available() { return this.balance; }
    deposit(amount) {
      if (amount <= 0) return false;
      this.balance += amount;
      this.ops++;
      return true;
    }
    withdraw(amount) {
      if (amount <= 0 || amount > this.available) return false;
      this.balance -= amount;
      this.ops++;
      return true;
    }
    snapshot() { return {id: this.id, balance: this.balance, available: this.available, ops: this.ops}; }
  }
  class CheckingAccount extends Account {
    constructor(id, balance, overdraft, fee) {
      super(id, balance);
      this.overdraft = overdraft;
      this.fee = fee;
      this.feesPaid = 0;
    }
    get available() { return this.balance + this.overdraft; }
    withdraw(amount) {
      const ok = super.withdraw(amount);
      if (ok && this.balance < 0) {
        this.balance -= this.fee;
        this.feesPaid += this.fee;
      }
      return ok;
    }
    snapshot() { return {...super.snapshot(), kind: 'checking', feesPaid: this.feesPaid}; }
  }
  class SavingsAccount extends Account {
    constructor(id, balance, ratePct, maxWithdrawals) {
      super(id, balance);
      this.ratePct = ratePct;
      this.maxWithdrawals = maxWithdrawals;
      this.withdrawals = 0;
    }
    withdraw(amount) {
      if (this.withdrawals >= this.maxWithdrawals) return false;
      const ok = super.withdraw(amount);
      if (ok) this.withdrawals++;
      return ok;
    }
    accrue() {
      const interest = Math.floor(this.balance * this.ratePct / 100);
      if (interest > 0) this.deposit(interest);
      return interest;
    }
    snapshot() { return {...super.snapshot(), kind: 'savings', withdrawals: this.withdrawals}; }
  }
  return {CheckingAccount, SavingsAccount};
}
function run(specs, commands) {
  const {CheckingAccount, SavingsAccount} = makeAccountClasses();
  const accounts = Object.create(null);
  const ids = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    ids.push(s.id);
    accounts[s.id] = s.kind === 'checking'
      ? new CheckingAccount(s.id, s.balance, s.overdraft, s.fee)
      : new SavingsAccount(s.id, s.balance, s.ratePct, s.maxWithdrawals);
  }
  const outcomes = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    const acct = accounts[c[1]];
    if (c[0] === 'dep') outcomes.push(acct.deposit(c[2]));
    else if (c[0] === 'wdr') outcomes.push(acct.withdraw(c[2]));
    else if (c[0] === 'accrue') outcomes.push(acct.accrue());
    else if (c[0] === 'xfer') {
      const dst = accounts[c[2]];
      const ok = acct.withdraw(c[3]);
      if (ok) dst.deposit(c[3]);
      outcomes.push(ok);
    }
  }
  const summary = [];
  let totalBalance = 0;
  for (let i = 0; i < ids.length; i++) {
    const snap = accounts[ids[i]].snapshot();
    summary.push(snap);
    totalBalance += snap.balance;
  }
  return {outcomes, summary, totalBalance};
}`,
      inputs: [
        [
          [{id: 'c1', kind: 'checking', balance: 50, overdraft: 40, fee: 5}, {id: 's1', kind: 'savings', balance: 100, ratePct: 10, maxWithdrawals: 2}],
          [['wdr', 'c1', 70], ['accrue', 's1'], ['xfer', 's1', 'c1', 30], ['wdr', 's1', 20], ['wdr', 's1', 10]],
        ],
        [
          [{id: 'c1', kind: 'checking', balance: 20, overdraft: 50, fee: 8}, {id: 'c2', kind: 'checking', balance: 10, overdraft: 10, fee: 3}],
          [['wdr', 'c1', 60], ['wdr', 'c1', 20], ['dep', 'c1', 50], ['xfer', 'c2', 'c1', 15], ['wdr', 'c2', 10]],
        ],
        [
          [{id: 's1', kind: 'savings', balance: 200, ratePct: 5, maxWithdrawals: 1}, {id: 'c1', kind: 'checking', balance: 0, overdraft: 30, fee: 4}],
          [['accrue', 's1'], ['xfer', 's1', 'c1', 50], ['wdr', 's1', 10], ['wdr', 'c1', 60], ['accrue', 's1']],
        ],
        [
          [{id: 'a', kind: 'checking', balance: 30, overdraft: 20, fee: 6}, {id: 'b', kind: 'savings', balance: 80, ratePct: 15, maxWithdrawals: 2}],
          [['xfer', 'a', 'b', 45], ['accrue', 'b'], ['xfer', 'b', 'a', 40], ['wdr', 'a', 35], ['wdr', 'b', 20], ['wdr', 'b', 5]],
        ],
        [
          [{id: 'x', kind: 'savings', balance: 55, ratePct: 20, maxWithdrawals: 3}, {id: 'y', kind: 'checking', balance: 15, overdraft: 25, fee: 5}],
          [['accrue', 'x'], ['wdr', 'y', 25], ['wdr', 'y', 20], ['xfer', 'x', 'y', 30], ['accrue', 'x'], ['wdr', 'y', 15]],
        ],
      ],
      features: ['class', 'inheritance', 'getter', 'loop', 'branch', 'object', 'hard-semantics'],
      tier: 5,
    },

    // B2. Closure-encapsulated interacting ledger accounts sharing a mutable fee pool
    {
      name: 'closure-ledger-factory',
      source: `function createLedgerSystem(feeRatePct) {
  let feePool = 0;
  const events = [];
  function makeAccount(name, initBal, initLimit) {
    let bal = initBal, limit = initLimit, frozen = false;
    function chargeFee(amt) {
      const fee = Math.floor(amt * feeRatePct / 100);
      feePool += fee;
      return fee;
    }
    return {
      name,
      deposit(amt) {
        if (frozen || amt <= 0) { events.push(name + ':dep:fail'); return false; }
        bal += amt;
        events.push(name + ':dep:' + amt);
        return true;
      },
      withdraw(amt) {
        if (frozen || amt <= 0 || amt > limit) { events.push(name + ':wdr:fail'); return false; }
        const fee = chargeFee(amt);
        if (bal < amt + fee) { feePool -= fee; events.push(name + ':wdr:nsf'); return false; }
        bal -= amt + fee;
        events.push(name + ':wdr:' + amt + '+' + fee);
        return true;
      },
      setLimit(next) { if (!frozen && next >= 0) limit = next; },
      freeze() { frozen = true; events.push(name + ':frozen'); },
      creditRaw(amt) { bal += amt; },
      snapshot() { return {name, bal, limit, frozen}; },
    };
  }
  function transfer(src, dst, amt) {
    if (!src.withdraw(amt)) return false;
    dst.creditRaw(amt);
    events.push('xfer:' + src.name + '->' + dst.name + ':' + amt);
    return true;
  }
  return {makeAccount, transfer, getFeePool: () => feePool, getEvents: () => events.slice()};
}
function run(feeRatePct, initA, initB, ops) {
  const sys = createLedgerSystem(feeRatePct);
  const a = sys.makeAccount('A', initA[0], initA[1]);
  const b = sys.makeAccount('B', initB[0], initB[1]);
  const map = {A: a, B: b};
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === 'dep') map[op[1]].deposit(op[2]);
    else if (op[0] === 'wdr') map[op[1]].withdraw(op[2]);
    else if (op[0] === 'limit') map[op[1]].setLimit(op[2]);
    else if (op[0] === 'freeze') map[op[1]].freeze();
    else if (op[0] === 'xfer') sys.transfer(map[op[1]], map[op[2]], op[3]);
  }
  return {a: a.snapshot(), b: b.snapshot(), feePool: sys.getFeePool(), events: sys.getEvents()};
}`,
      inputs: [
        [10, [100, 60], [40, 30], [['xfer', 'A', 'B', 50], ['wdr', 'B', 40], ['limit', 'B', 60], ['wdr', 'B', 40], ['freeze', 'A'], ['dep', 'A', 20]]],
        [5, [80, 100], [50, 50], [['wdr', 'A', 80], ['wdr', 'A', 60], ['xfer', 'B', 'A', 40], ['xfer', 'A', 'B', 50], ['wdr', 'B', 20]]],
        [15, [120, 80], [20, 40], [['xfer', 'A', 'B', 60], ['dep', 'B', 30], ['xfer', 'B', 'A', 40], ['freeze', 'B'], ['xfer', 'A', 'B', 20], ['wdr', 'B', 10]]],
        [20, [150, 100], [60, 50], [['wdr', 'A', 50], ['xfer', 'A', 'B', 80], ['xfer', 'A', 'B', 60], ['limit', 'B', 100], ['xfer', 'B', 'A', 90]]],
        [10, [50, 50], [50, 50], [['xfer', 'A', 'B', 45], ['xfer', 'B', 'A', 50], ['wdr', 'A', 50], ['dep', 'A', 10], ['wdr', 'A', 50]]],
      ],
      features: ['closure', 'loop', 'branch', 'object', 'mutation', 'hard-semantics'],
      tier: 5,
    },

    // B3. Deep clone + in-place mutation on cyclic & aliased object graphs ($js:ref preservation)
    {
      name: 'cyclic-graph-clone-and-diff',
      source: `function deepCloneGraph(root) {
  const origs = [];
  const clones = [];
  let aliasHits = 0, cycleHits = 0;
  const active = [];
  function visit(val) {
    if (val === null || typeof val !== 'object') return val;
    for (let i = 0; i < origs.length; i++) {
      if (origs[i] === val) {
        if (active[i]) cycleHits++;
        else aliasHits++;
        return clones[i];
      }
    }
    const copy = Array.isArray(val) ? [] : {};
    const idx = origs.length;
    origs.push(val);
    clones.push(copy);
    active.push(true);
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) copy.push(visit(val[i]));
    } else {
      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i++) copy[keys[i]] = visit(val[keys[i]]);
    }
    active[idx] = false;
    return copy;
  }
  return {clone: visit(root), aliasHits, cycleHits};
}
function splitDots(path) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '.') { parts.push(cur); cur = ''; }
    else cur += path[i];
  }
  parts.push(cur);
  return parts;
}
function resolveTarget(root, path) {
  const parts = splitDots(path);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  return {parent: cur, key: parts[parts.length - 1]};
}
function readPath(root, path) {
  const parts = splitDots(path);
  let cur = root;
  for (let i = 0; i < parts.length; i++) cur = cur[parts[i]];
  return cur;
}
function run(root, mutations) {
  const info = deepCloneGraph(root);
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    const t = resolveTarget(root, m[1]);
    if (m[0] === 'set') t.parent[t.key] = m[2];
    else if (m[0] === 'del') delete t.parent[t.key];
    else if (m[0] === 'alias') t.parent[t.key] = readPath(root, m[2]);
  }
  return {clone: info.clone, aliasHits: info.aliasHits, cycleHits: info.cycleHits, mutatedRoot: root};
}`,
      inputs: [
        () => makeCyclicGraph(0),
        () => makeCyclicGraph(1),
        () => makeCyclicGraph(2),
        () => makeCyclicGraph(3),
        () => makeCyclicGraph(4),
      ],
      features: ['recursion', 'loop', 'branch', 'mutation', 'alias', 'cycle', 'hard-semantics'],
      tier: 5,
    },

    // B4. Mini mark-and-sweep + compaction GC simulator over cyclic heap references
    {
      name: 'mark-sweep-gc-simulator',
      source: `function run(heapCap, initObjs, roots, ops) {
  const heap = Object.create(null);
  const order = [];
  let used = 0, collections = 0, freedTotal = 0;
  for (let i = 0; i < initObjs.length; i++) {
    const o = initObjs[i];
    heap[o.id] = {id: o.id, size: o.size, refs: o.refs.slice(), offset: used};
    order.push(o.id);
    used += o.size;
  }
  const activeRoots = roots.slice();
  function collect() {
    collections++;
    const marked = Object.create(null);
    const stack = activeRoots.slice();
    while (stack.length) {
      const id = stack.pop();
      if (!(id in heap) || marked[id]) continue;
      marked[id] = true;
      const refs = heap[id].refs;
      for (let i = 0; i < refs.length; i++) if (!marked[refs[i]]) stack.push(refs[i]);
    }
    const nextOrder = [];
    let nextOffset = 0, freed = 0;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      if (marked[id]) {
        heap[id].offset = nextOffset;
        nextOffset += heap[id].size;
        nextOrder.push(id);
      } else {
        freed += heap[id].size;
        delete heap[id];
      }
    }
    order.length = 0;
    for (let i = 0; i < nextOrder.length; i++) order.push(nextOrder[i]);
    used = nextOffset;
    freedTotal += freed;
  }
  const failedAllocs = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === 'unroot') {
      const idx = activeRoots.indexOf(op[1]);
      if (idx !== -1) activeRoots.splice(idx, 1);
    } else if (op[0] === 'unlink') {
      if (op[1] in heap) {
        const idx = heap[op[1]].refs.indexOf(op[2]);
        if (idx !== -1) heap[op[1]].refs.splice(idx, 1);
      }
    } else if (op[0] === 'alloc') {
      const id = op[1], size = op[2], refs = op[3];
      if (used + size > heapCap) collect();
      if (used + size > heapCap) { failedAllocs.push(id); continue; }
      heap[id] = {id, size, refs: refs.slice(), offset: used};
      order.push(id);
      activeRoots.push(id);
      used += size;
    } else if (op[0] === 'gc') collect();
  }
  const offsets = {};
  for (let i = 0; i < order.length; i++) offsets[order[i]] = heap[order[i]].offset;
  return {liveIds: order, freedTotal, offsets, used, collections, failedAllocs};
}`,
      inputs: [
        [20, [{id: 'a', size: 6, refs: ['b']}, {id: 'b', size: 5, refs: ['a']}, {id: 'c', size: 4, refs: ['d']}, {id: 'd', size: 4, refs: []}], ['a', 'c'], [['unroot', 'a'], ['alloc', 'e', 7, ['c']], ['unlink', 'c', 'd'], ['alloc', 'f', 6, []]]],
        [16, [{id: 'r1', size: 5, refs: ['n1']}, {id: 'n1', size: 4, refs: ['n2']}, {id: 'n2', size: 4, refs: ['n1']}], ['r1'], [['unlink', 'r1', 'n1'], ['alloc', 'r2', 8, ['r1']], ['alloc', 'r3', 5, []]]],
        [18, [{id: 'x', size: 4, refs: ['y']}, {id: 'y', size: 4, refs: ['z']}, {id: 'z', size: 4, refs: ['x']}, {id: 'w', size: 5, refs: []}], ['x', 'w'], [['unroot', 'w'], ['alloc', 'p', 6, ['y']], ['unroot', 'x'], ['gc']]],
        [15, [{id: 'a', size: 5, refs: ['b']}, {id: 'b', size: 5, refs: []}], ['a'], [['alloc', 'c', 6, []], ['unlink', 'a', 'b'], ['alloc', 'c', 6, ['a']], ['alloc', 'd', 5, []]]],
        [22, [{id: 'k1', size: 6, refs: ['k2', 'k3']}, {id: 'k2', size: 5, refs: ['k4']}, {id: 'k3', size: 4, refs: ['k4']}, {id: 'k4', size: 4, refs: ['k2']}], ['k1'], [['unlink', 'k1', 'k2'], ['alloc', 'k5', 5, []], ['unlink', 'k1', 'k3'], ['alloc', 'k6', 10, ['k1']]]],
      ],
      features: ['loop', 'branch', 'array', 'object', 'null-prototype', 'mutation', 'gc', 'hard-semantics'],
      tier: 5,
    },

    // B5. Tricky control flow: finally return-override, labeled break/continue, short-circuit, sparse arrays
    {
      name: 'tricky-control-flow-exceptions',
      source: `function evalFinally(seed, mode, audit) {
  let x = seed;
  try {
    if (mode === 2) throw new RangeError('boom:' + x);
    return x;
  } catch (e) {
    audit.push('caught:' + e.message);
    x += 10;
    return x;
  } finally {
    x += 100;
    audit.push('fin:' + x);
    if (mode === 1) return x;
  }
}
function evalLabeled(rows, cols, stopSum, audit) {
  let sum = 0, skips = 0;
  outer: for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 3 === 1) { skips++; continue outer; }
      sum += r * 2 + c;
      if (sum >= stopSum) { audit.push('break:' + r + ':' + c); break outer; }
    }
  }
  return [sum, skips];
}
function run(commands, slots, audit) {
  const results = [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (cmd[0] === 'retOverride') {
      results.push(evalFinally(cmd[1], cmd[2], audit));
    } else if (cmd[0] === 'labelLoop') {
      results.push(evalLabeled(cmd[1], cmd[2], cmd[3], audit));
    } else if (cmd[0] === 'shortCircuit') {
      let side = 0;
      const bump = v => { side += v; return v; };
      const v1 = (cmd[1] && bump(cmd[2])) || bump(cmd[3]);
      const v2 = (cmd[1] ?? bump(9)) + (cmd[2] ? 1 : bump(4));
      results.push([v1, v2, side]);
    } else if (cmd[0] === 'sparseOp') {
      const idx = cmd[1], val = cmd[2];
      const beforeIn = idx in slots;
      slots[idx] = val;
      delete slots[0];
      const present = [];
      for (let k = 0; k < slots.length; k++) present.push(k in slots);
      results.push([beforeIn, present]);
    }
  }
  return {results, sparse: slots, log: audit};
}`,
      inputs: [
        () => makeSparseInput(0),
        () => makeSparseInput(1),
        () => makeSparseInput(2),
        () => makeSparseInput(3),
        () => makeSparseInput(4),
      ],
      features: ['loop', 'branch', 'exception', 'finally', 'break', 'continue', 'sparse', 'mutation', 'alias', 'nullish', 'hard-semantics'],
      tier: 5,
    },

    // B6. Transactional JSON-patch applicator with alias-preserving rollback on failure
    {
      name: 'transactional-json-patch-rollback',
      source: `function splitPath(path) {
  const out = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '.') { out.push(cur); cur = ''; }
    else cur += path[i];
  }
  out.push(cur);
  return out;
}
function resolveParent(doc, path) {
  const parts = splitPath(path);
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object' || !(parts[i] in cur)) return null;
    cur = cur[parts[i]];
  }
  return {parent: cur, key: parts[parts.length - 1]};
}
function run(doc, ops) {
  const undo = [];
  let appliedOps = 0, failedAt = -1;
  function setField(parent, key, val) {
    const had = Object.hasOwn(parent, key);
    const prev = had ? parent[key] : undefined;
    const prevLen = Array.isArray(parent) ? parent.length : -1;
    parent[key] = val;
    undo.push({parent, key, had, prev, prevLen});
  }
  function delField(parent, key) {
    const had = Object.hasOwn(parent, key);
    const prev = had ? parent[key] : undefined;
    const prevLen = Array.isArray(parent) ? parent.length : -1;
    delete parent[key];
    undo.push({parent, key, had, prev, prevLen});
  }
  for (let i = 0; i < ops.length; i++) {
    const item = ops[i];
    const target = resolveParent(doc, item.path);
    if (!target || target.parent === null || typeof target.parent !== 'object') { failedAt = i; break; }
    if (item.op === 'test') {
      if (!Object.hasOwn(target.parent, target.key) || target.parent[target.key] !== item.value) { failedAt = i; break; }
      appliedOps++;
    } else if (item.op === 'add') {
      setField(target.parent, target.key, item.value);
      appliedOps++;
    } else if (item.op === 'replace') {
      if (!Object.hasOwn(target.parent, target.key)) { failedAt = i; break; }
      setField(target.parent, target.key, item.value);
      appliedOps++;
    } else if (item.op === 'remove') {
      if (!Object.hasOwn(target.parent, target.key)) { failedAt = i; break; }
      delField(target.parent, target.key);
      appliedOps++;
    } else if (item.op === 'copy' || item.op === 'move') {
      const src = resolveParent(doc, item.from);
      if (!src || !Object.hasOwn(src.parent, src.key)) { failedAt = i; break; }
      const val = src.parent[src.key];
      if (item.op === 'move') delField(src.parent, src.key);
      setField(target.parent, target.key, val);
      appliedOps++;
    }
  }
  let rolledBackOps = 0;
  if (failedAt !== -1) {
    for (let i = undo.length - 1; i >= 0; i--) {
      const u = undo[i];
      if (u.had) u.parent[u.key] = u.prev;
      else delete u.parent[u.key];
      if (u.prevLen !== -1) u.parent.length = u.prevLen;
      rolledBackOps++;
    }
  }
  return {committed: failedAt === -1, appliedOps, rolledBackOps, failedAt, doc};
}`,
      inputs: [
        () => makeAliasedPatchDoc(0),
        () => makeAliasedPatchDoc(1),
        () => makeAliasedPatchDoc(2),
        () => makeAliasedPatchDoc(3),
        () => makeAliasedPatchDoc(4),
      ],
      features: ['loop', 'branch', 'object', 'array', 'mutation', 'alias', 'rollback', 'hard-semantics'],
      tier: 5,
    },

    // B7. Priority EventEmitter with once, off, self-removal & re-entrant emit
    {
      name: 'event-emitter-priority-reentrant',
      source: `function run(specs, eventsToEmit, payload) {
  const registry = Object.create(null);
  const firedOrder = [];
  function sortListeners(list) {
    for (let i = 1; i < list.length; i++) {
      const cur = list[i];
      let j = i - 1;
      while (j >= 0 && (list[j].prio < cur.prio || (list[j].prio === cur.prio && list[j].seq > cur.seq))) {
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = cur;
    }
  }
  let seq = 0;
  function on(evt, spec) {
    if (!(evt in registry)) registry[evt] = [];
    const entry = {id: spec.id, prio: spec.prio, once: !!spec.once, action: spec.action, active: true, seq: seq++};
    registry[evt].push(entry);
    sortListeners(registry[evt]);
  }
  function off(evt, id) {
    const list = registry[evt];
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id === id) { list[i].active = false; list.splice(i, 1); }
    }
  }
  function emit(evt, delta) {
    const list = registry[evt];
    if (!list) return;
    const snap = list.slice();
    for (let i = 0; i < snap.length; i++) {
      const entry = snap[i];
      if (!entry.active) continue;
      if (entry.once) off(evt, entry.id);
      firedOrder.push(evt + ':' + entry.id);
      const act = entry.action;
      if (act[0] === 'add') payload.sum += act[1] + delta;
      else if (act[0] === 'mul') payload.sum *= act[1];
      else if (act[0] === 'off') off(act[1], act[2]);
      else if (act[0] === 'addAndOff') { payload.sum += act[1]; off(act[2], act[3]); }
      else if (act[0] === 'emit') { payload.sum += act[1]; emit(act[2], act[3]); }
      else if (act[0] === 'reg') on(act[1], act[2]);
    }
  }
  for (let i = 0; i < specs.length; i++) on(specs[i].evt, specs[i]);
  for (let i = 0; i < eventsToEmit.length; i++) emit(eventsToEmit[i][0], eventsToEmit[i][1]);
  const remainingCounts = {};
  const keys = Object.keys(registry);
  for (let i = 0; i < keys.length; i++) remainingCounts[keys[i]] = registry[keys[i]].length;
  return {firedOrder, remainingCounts, payload};
}`,
      inputs: [
        [
          [{evt: 'tick', id: 'lo', prio: 1, action: ['add', 2]}, {evt: 'tick', id: 'hi', prio: 5, once: true, action: ['addAndOff', 10, 'tick', 'mid']}, {evt: 'tick', id: 'mid', prio: 3, action: ['mul', 2]}],
          [['tick', 1], ['tick', 2]], {sum: 0},
        ],
        [
          [{evt: 'a', id: 'a1', prio: 5, action: ['emit', 3, 'b', 2]}, {evt: 'a', id: 'a2', prio: 2, action: ['mul', 2]}, {evt: 'b', id: 'b1', prio: 4, once: true, action: ['add', 5]}, {evt: 'b', id: 'b2', prio: 1, action: ['off', 'a', 'a2']}],
          [['a', 1], ['a', 1]], {sum: 1},
        ],
        [
          [{evt: 'go', id: 'spawn', prio: 10, once: true, action: ['reg', 'go', {id: 'late', prio: 20, action: ['add', 7]}]}, {evt: 'go', id: 'base', prio: 5, action: ['add', 2]}],
          [['go', 0], ['go', 1]], {sum: 0},
        ],
        [
          [{evt: 'x', id: 'k1', prio: 3, action: ['add', 4]}, {evt: 'x', id: 'k2', prio: 3, once: true, action: ['mul', 3]}, {evt: 'x', id: 'k3', prio: 3, action: ['off', 'x', 'k1']}],
          [['x', 1], ['x', 2]], {sum: 2},
        ],
        [
          [{evt: 'p', id: 'p1', prio: 5, action: ['emit', 2, 'q', 1]}, {evt: 'q', id: 'q1', prio: 5, once: true, action: ['addAndOff', 6, 'q', 'q2']}, {evt: 'q', id: 'q2', prio: 1, action: ['mul', 5]}, {evt: 'p', id: 'p2', prio: 2, action: ['add', 3]}],
          [['p', 0], ['p', 1]], {sum: 0},
        ],
      ],
      features: ['recursion', 'loop', 'branch', 'object', 'array', 'mutation', 'alias', 'null-prototype', 'closure', 'hard-semantics'],
      tier: 5,
    },

    // B8. Prototype-chain & property-descriptor semantics (shadowing, non-writable, getter/setter, delete)
    {
      name: 'prototype-descriptor-resolver',
      source: `function run(ops) {
  let backing = 10;
  const base = Object.create(null);
  Object.defineProperty(base, 'constVal', {value: 42, writable: false, enumerable: true, configurable: false});
  Object.defineProperty(base, 'hidden', {value: 'secret', writable: true, enumerable: false, configurable: true});
  Object.defineProperty(base, 'shared', {value: 5, writable: true, enumerable: true, configurable: true});
  const mid = Object.create(base);
  Object.defineProperty(mid, 'computed', {
    get() { return backing * 2; },
    set(v) { backing = v + 1; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(mid, 'readOnlyAcc', {
    get() { return backing + 100; },
    enumerable: true,
    configurable: true,
  });
  mid.shared = 20;
  const leaf = Object.create(mid);
  leaf.own = 1;
  const reads = [], errors = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const kind = op[0], key = op[1];
    if (kind === 'get') reads.push([key, leaf[key], Object.hasOwn(leaf, key), key in leaf]);
    else if (kind === 'set') {
      try {
        leaf[key] = op[2];
        reads.push(['set-ok', key, leaf[key], Object.hasOwn(leaf, key)]);
      } catch (e) {
        errors.push([key, e.name]);
      }
    } else if (kind === 'del') {
      const ok = delete leaf[key];
      reads.push(['del', key, ok, leaf[key], Object.hasOwn(leaf, key)]);
    } else if (kind === 'keys') {
      reads.push(['keys', Object.keys(leaf), Object.getOwnPropertyNames(leaf)]);
    }
  }
  return {reads, errors, backing, leafKeys: Object.keys(leaf)};
}`,
      inputs: [
        [['get', 'shared'], ['set', 'shared', 99], ['del', 'shared'], ['get', 'shared'], ['set', 'constVal', 7], ['keys']],
        [['get', 'computed'], ['set', 'computed', 15], ['get', 'computed'], ['set', 'readOnlyAcc', 5], ['get', 'hidden']],
        [['set', 'hidden', 'over'], ['get', 'hidden'], ['del', 'hidden'], ['get', 'hidden'], ['keys']],
        [['set', 'constVal', 1], ['set', 'readOnlyAcc', 2], ['set', 'own', 8], ['del', 'own'], ['get', 'own'], ['keys']],
        [['get', 'shared'], ['set', 'computed', 20], ['get', 'readOnlyAcc'], ['set', 'shared', 77], ['del', 'shared'], ['get', 'shared'], ['keys']],
      ],
      features: ['prototype', 'descriptor', 'getter', 'exception', 'branch', 'loop', 'null-prototype', 'hard-semantics'],
      tier: 5,
    },

    // =========================================================================
    // GROUP C: Complex multi-turn agentic side-effect workflows (8 families, 6-14 tool calls)
    // =========================================================================

    // C1. Distributed Saga / 2PC orchestrator with lock acquisition, DB writes, and reverse rollback
    {
      name: 'saga-2pc-orchestrator',
      nativeBindings: [
        {name: 'lock_acquire', kind: 'promise', description: 'Acquire a distributed lock for resource id; returns a lock token or rejects.'},
        {name: 'db_get', kind: 'promise', description: 'Read a JSON record for resource id from the database.'},
        {name: 'db_put', kind: 'promise', description: 'Write a JSON record for resource id to the database; returns true or rejects.'},
        {name: 'lock_release', kind: 'promise', description: 'Release a previously acquired lock token.'},
      ],
      source: `async function run(transfers) {
  const participants = [];
  for (let i = 0; i < transfers.length; i++) {
    const a = transfers[i].from, b = transfers[i].to;
    if (participants.indexOf(a) === -1) participants.push(a);
    if (participants.indexOf(b) === -1) participants.push(b);
  }
  for (let i = 1; i < participants.length; i++) {
    const cur = participants[i];
    let j = i - 1;
    while (j >= 0 && participants[j] > cur) { participants[j + 1] = participants[j]; j--; }
    participants[j + 1] = cur;
  }
  const locks = [];
  const snapshots = Object.create(null);
  const applied = [];
  let status = 'committed', error = null;
  try {
    for (let i = 0; i < participants.length; i++) {
      const tok = await lock_acquire(participants[i]);
      locks.push([participants[i], tok]);
    }
    const working = Object.create(null);
    for (let i = 0; i < participants.length; i++) {
      const id = participants[i];
      const rec = await db_get(id);
      snapshots[id] = {bal: rec.bal, ver: rec.ver};
      working[id] = {bal: rec.bal, ver: rec.ver};
    }
    for (let i = 0; i < transfers.length; i++) {
      const t = transfers[i];
      if (working[t.from].bal < t.amt) throw new Error('insufficient:' + t.from);
      working[t.from].bal -= t.amt;
      working[t.from].ver++;
      working[t.to].bal += t.amt;
      working[t.to].ver++;
    }
    for (let i = 0; i < participants.length; i++) {
      const id = participants[i];
      if (working[id].ver !== snapshots[id].ver) {
        await db_put(id, working[id]);
        applied.push(id);
      }
    }
  } catch (err) {
    status = 'rolled_back';
    error = typeof err === 'string' ? err : err.message;
    for (let i = applied.length - 1; i >= 0; i--) {
      const id = applied[i];
      await db_put(id, snapshots[id]);
    }
  } finally {
    for (let i = locks.length - 1; i >= 0; i--) {
      await lock_release(locks[i][0], locks[i][1]);
    }
  }
  return {status, error, written: applied.length, participants};
}`,
      inputs: [
        [[{from: 'b', to: 'a', amt: 25}]],
        [[{from: 'a', to: 'b', amt: 30}, {from: 'b', to: 'c', amt: 20}]],
        [[{from: 'x', to: 'y', amt: 15}, {from: 'y', to: 'z', amt: 10}]],
        [[{from: 'a', to: 'b', amt: 80}]],
        [[{from: 'p', to: 'q', amt: 10}, {from: 'q', to: 'r', amt: 5}]],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'exception', 'finally', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // 2 participants (a, b): 2 locks + 2 gets + 2 puts + 2 releases = 8 calls, commits
          return {calls: [
            natCall('lock_acquire', ['a'], 'L-a'),
            natCall('lock_acquire', ['b'], 'L-b'),
            natCall('db_get', ['a'], {bal: 10, ver: 1}),
            natCall('db_get', ['b'], {bal: 60, ver: 2}),
            natCall('db_put', ['a', {bal: 35, ver: 2}], true),
            natCall('db_put', ['b', {bal: 35, ver: 3}], true),
            natCall('lock_release', ['b', 'L-b'], true),
            natCall('lock_release', ['a', 'L-a'], true),
          ]};
        }
        if (i === 1) {
          // 3 participants (a,b,c), db_put('c') rejects -> rollback b, a -> release c,b,a = 14 calls!
          return {calls: [
            natCall('lock_acquire', ['a'], 'L1'),
            natCall('lock_acquire', ['b'], 'L2'),
            natCall('lock_acquire', ['c'], 'L3'),
            natCall('db_get', ['a'], {bal: 50, ver: 1}),
            natCall('db_get', ['b'], {bal: 40, ver: 1}),
            natCall('db_get', ['c'], {bal: 10, ver: 1}),
            natCall('db_put', ['a', {bal: 20, ver: 2}], true),
            natCall('db_put', ['b', {bal: 50, ver: 3}], true),
            natCall('db_put', ['c', {bal: 30, ver: 2}], 'write-timeout', {status: 'rejected'}),
            natCall('db_put', ['b', {bal: 40, ver: 1}], true),
            natCall('db_put', ['a', {bal: 50, ver: 1}], true),
            natCall('lock_release', ['c', 'L3'], true),
            natCall('lock_release', ['b', 'L2'], true),
            natCall('lock_release', ['a', 'L1'], true),
          ]};
        }
        if (i === 2) {
          // 3 participants (x,y,z), all commit = 12 calls
          return {calls: [
            natCall('lock_acquire', ['x'], 'Lx'),
            natCall('lock_acquire', ['y'], 'Ly'),
            natCall('lock_acquire', ['z'], 'Lz'),
            natCall('db_get', ['x'], {bal: 40, ver: 3}),
            natCall('db_get', ['y'], {bal: 20, ver: 1}),
            natCall('db_get', ['z'], {bal: 5, ver: 0}),
            natCall('db_put', ['x', {bal: 25, ver: 4}], true),
            natCall('db_put', ['y', {bal: 25, ver: 3}], true),
            natCall('db_put', ['z', {bal: 15, ver: 1}], true),
            natCall('lock_release', ['z', 'Lz'], true),
            natCall('lock_release', ['y', 'Ly'], true),
            natCall('lock_release', ['x', 'Lx'], true),
          ]};
        }
        if (i === 3) {
          // insufficient balance after db_get -> 2 locks + 2 gets + 2 releases = 6 calls
          return {calls: [
            natCall('lock_acquire', ['a'], 'La'),
            natCall('lock_acquire', ['b'], 'Lb'),
            natCall('db_get', ['a'], {bal: 30, ver: 1}),
            natCall('db_get', ['b'], {bal: 10, ver: 1}),
            natCall('lock_release', ['b', 'Lb'], true),
            natCall('lock_release', ['a', 'La'], true),
          ]};
        }
        // i === 4: lock_acquire('q') succeeds, lock_acquire('r') fails -> release q, p (no db_get) — wait, let's make db_put('q') reject after db_put('p') so 12 calls!
        return {calls: [
          natCall('lock_acquire', ['p'], 'Lp'),
          natCall('lock_acquire', ['q'], 'Lq'),
          natCall('lock_acquire', ['r'], 'Lr'),
          natCall('db_get', ['p'], {bal: 30, ver: 2}),
          natCall('db_get', ['q'], {bal: 15, ver: 1}),
          natCall('db_get', ['r'], {bal: 0, ver: 0}),
          natCall('db_put', ['p', {bal: 20, ver: 3}], true),
          natCall('db_put', ['q', {bal: 20, ver: 3}], 'disk-err', {status: 'rejected'}),
          natCall('db_put', ['p', {bal: 30, ver: 2}], true),
          natCall('lock_release', ['r', 'Lr'], true),
          natCall('lock_release', ['q', 'Lq'], true),
          natCall('lock_release', ['p', 'Lp'], true),
        ]};
      },
    },

    // C2. Job-queue lease worker with Date.now() expiry, optimistic locking, DLQ routing & ack/nack
    {
      name: 'job-queue-lease-worker',
      nativeBindings: [
        {name: 'queue_pop', kind: 'promise', description: 'Pop the next job object from the queue, or null if empty.'},
        {name: 'db_get', kind: 'promise', description: 'Fetch record {val, version} for key.'},
        {name: 'db_put', kind: 'promise', description: 'Save record for key.'},
        {name: 'queue_ack', kind: 'promise', description: 'Acknowledge completion of job id.'},
        {name: 'queue_nack', kind: 'promise', description: 'Negative-acknowledge job id with reason.'},
      ],
      source: `async function run(queueName, maxJobs) {
  let processed = 0, dlq = 0, nacked = 0;
  const log = [];
  for (let i = 0; i < maxJobs; i++) {
    const job = await queue_pop(queueName);
    if (job === null) break;
    const now = Date.now();
    if (now > job.leaseUntil) {
      console.warn('expired:' + job.id);
      await queue_nack(job.id, 'lease-expired');
      nacked++;
      log.push(job.id + ':expired');
      continue;
    }
    if (job.attempts >= 3) {
      await db_put('dlq:' + job.id, {key: job.key, attempts: job.attempts, delta: job.delta});
      await queue_ack(job.id);
      dlq++;
      log.push(job.id + ':dlq');
      continue;
    }
    const rec = await db_get(job.key);
    if (rec.version !== job.expectedVersion) {
      await queue_nack(job.id, 'version-conflict');
      nacked++;
      log.push(job.id + ':conflict');
      continue;
    }
    await db_put(job.key, {val: rec.val + job.delta, version: rec.version + 1});
    await queue_ack(job.id);
    processed++;
    log.push(job.id + ':ok');
  }
  return {processed, dlq, nacked, log};
}`,
      inputs: [
        ['jobs', 3],
        ['jobs', 3],
        ['billing', 3],
        ['sync', 2],
        ['ops', 3],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'platform', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // j1 ok (5 calls) + j2 expired (4 calls) + null (1 call) = 10 calls
          return {calls: [
            natCall('queue_pop', ['jobs'], {id: 'j1', key: 'k1', delta: 5, expectedVersion: 1, attempts: 1, leaseUntil: 200}),
            {operation: 'platform.dateNow', arguments: [], result: 150},
            natCall('db_get', ['k1'], {val: 10, version: 1}),
            natCall('db_put', ['k1', {val: 15, version: 2}], true),
            natCall('queue_ack', ['j1'], true),
            natCall('queue_pop', ['jobs'], {id: 'j2', key: 'k2', delta: 3, expectedVersion: 1, attempts: 1, leaseUntil: 180}),
            {operation: 'platform.dateNow', arguments: [], result: 190},
            {operation: 'platform.console.warn', arguments: ['expired:j2']},
            natCall('queue_nack', ['j2', 'lease-expired'], true),
            natCall('queue_pop', ['jobs'], null),
          ]};
        }
        if (i === 1) {
          // j1 conflict (4 calls) + j2 dlq (4 calls) + j3 ok (5 calls) = 13 calls
          return {calls: [
            natCall('queue_pop', ['jobs'], {id: 'j1', key: 'a', delta: 2, expectedVersion: 1, attempts: 1, leaseUntil: 500}),
            {operation: 'platform.dateNow', arguments: [], result: 100},
            natCall('db_get', ['a'], {val: 20, version: 2}),
            natCall('queue_nack', ['j1', 'version-conflict'], true),
            natCall('queue_pop', ['jobs'], {id: 'j2', key: 'b', delta: 9, expectedVersion: 1, attempts: 3, leaseUntil: 500}),
            {operation: 'platform.dateNow', arguments: [], result: 120},
            natCall('db_put', ['dlq:j2', {key: 'b', attempts: 3, delta: 9}], true),
            natCall('queue_ack', ['j2'], true),
            natCall('queue_pop', ['jobs'], {id: 'j3', key: 'c', delta: -4, expectedVersion: 4, attempts: 2, leaseUntil: 500}),
            {operation: 'platform.dateNow', arguments: [], result: 130},
            natCall('db_get', ['c'], {val: 12, version: 4}),
            natCall('db_put', ['c', {val: 8, version: 5}], true),
            natCall('queue_ack', ['j3'], true),
          ]};
        }
        if (i === 2) {
          // b1 ok (5) + b2 ok (5) + null (1) = 11 calls
          return {calls: [
            natCall('queue_pop', ['billing'], {id: 'b1', key: 'u1', delta: 100, expectedVersion: 0, attempts: 1, leaseUntil: 1000}),
            {operation: 'platform.dateNow', arguments: [], result: 900},
            natCall('db_get', ['u1'], {val: 0, version: 0}),
            natCall('db_put', ['u1', {val: 100, version: 1}], true),
            natCall('queue_ack', ['b1'], true),
            natCall('queue_pop', ['billing'], {id: 'b2', key: 'u1', delta: -35, expectedVersion: 1, attempts: 1, leaseUntil: 1000}),
            {operation: 'platform.dateNow', arguments: [], result: 950},
            natCall('db_get', ['u1'], {val: 100, version: 1}),
            natCall('db_put', ['u1', {val: 65, version: 2}], true),
            natCall('queue_ack', ['b2'], true),
            natCall('queue_pop', ['billing'], null),
          ]};
        }
        if (i === 3) {
          // s1 expired (4) + s2 dlq (4) = 8 calls
          return {calls: [
            natCall('queue_pop', ['sync'], {id: 's1', key: 'x', delta: 1, expectedVersion: 1, attempts: 4, leaseUntil: 50}),
            {operation: 'platform.dateNow', arguments: [], result: 51},
            {operation: 'platform.console.warn', arguments: ['expired:s1']},
            natCall('queue_nack', ['s1', 'lease-expired'], true),
            natCall('queue_pop', ['sync'], {id: 's2', key: 'y', delta: 7, expectedVersion: 2, attempts: 3, leaseUntil: 100}),
            {operation: 'platform.dateNow', arguments: [], result: 100},
            natCall('db_put', ['dlq:s2', {key: 'y', attempts: 3, delta: 7}], true),
            natCall('queue_ack', ['s2'], true),
          ]};
        }
        // i === 4: o1 ok (5) + o2 conflict (4) + o3 expired (4) = 13 calls
        return {calls: [
          natCall('queue_pop', ['ops'], {id: 'o1', key: 'm', delta: 6, expectedVersion: 3, attempts: 2, leaseUntil: 300}),
          {operation: 'platform.dateNow', arguments: [], result: 250},
          natCall('db_get', ['m'], {val: 4, version: 3}),
          natCall('db_put', ['m', {val: 10, version: 4}], true),
          natCall('queue_ack', ['o1'], true),
          natCall('queue_pop', ['ops'], {id: 'o2', key: 'm', delta: 2, expectedVersion: 3, attempts: 1, leaseUntil: 300}),
          {operation: 'platform.dateNow', arguments: [], result: 260},
          natCall('db_get', ['m'], {val: 10, version: 4}),
          natCall('queue_nack', ['o2', 'version-conflict'], true),
          natCall('queue_pop', ['ops'], {id: 'o3', key: 'n', delta: 1, expectedVersion: 0, attempts: 1, leaseUntil: 265}),
          {operation: 'platform.dateNow', arguments: [], result: 270},
          {operation: 'platform.console.warn', arguments: ['expired:o3']},
          natCall('queue_nack', ['o3', 'lease-expired'], true),
        ]};
      },
    },

    // C3. Multi-page HTTP API crawler with ETag KV cache, 429 retry, cursor pagination & deduplication
    {
      name: 'http-etag-cursor-crawler',
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Read cached page entry {etag, items, next} or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Store page entry {etag, items, next} in KV cache.'},
      ],
      source: `function parseBody(raw) {
  const sep = raw.indexOf('|');
  const list = sep === -1 ? raw : raw.slice(0, sep);
  const next = sep === -1 ? '' : raw.slice(sep + 1);
  const items = [];
  let cur = '';
  for (let i = 0; i < list.length; i++) {
    if (list[i] === ',') { if (cur.length) items.push(cur); cur = ''; }
    else cur += list[i];
  }
  if (cur.length) items.push(cur);
  return {items, next};
}
async function run(baseUrl, startCursor) {
  let cursor = startCursor, cacheHits = 0, retries = 0;
  const seen = Object.create(null);
  const items = [];
  while (cursor.length > 0) {
    const cached = await kv_get('page:' + cursor);
    const hdr = cached ? '{"if-none-match":"' + cached.etag + '"}' : '{}';
    let pageItems = null, nextCursor = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = baseUrl + '?c=' + cursor + (attempt ? '&retry=1' : '');
      const res = await host.httpRequest(url, 'GET', hdr, '');
      let status = 0;
      try {
        status = await host.httpStatus(res);
        if (status === 304 && cached) {
          cacheHits++;
          pageItems = cached.items;
          nextCursor = cached.next;
        } else if (status === 200) {
          const etag = await host.httpHeaders(res);
          const body = await host.httpRead(res);
          const parsed = parseBody(body);
          pageItems = parsed.items;
          nextCursor = parsed.next;
          await kv_set('page:' + cursor, {etag, items: pageItems, next: nextCursor});
        } else if (status === 429) {
          retries++;
          console.warn('rate-limit:' + cursor);
        }
      } finally {
        await host.httpClose(res);
      }
      if (pageItems !== null || status !== 429) break;
    }
    if (pageItems === null) break;
    for (let i = 0; i < pageItems.length; i++) {
      const id = pageItems[i];
      if (!(id in seen)) { seen[id] = true; items.push(id); }
    }
    cursor = nextCursor;
  }
  return {items, cacheHits, retries};
}`,
      inputs: [
        ['https://api.test/feed', 'p0'],
        ['https://api.test/items', 'c1'],
        ['https://api.test/logs', 'k0'],
        ['https://api.test/docs', 'd1'],
        ['https://api.test/ev', 'e0'],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'finally', 'http', 'platform', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // p0 cached 304 (4 calls) -> p1 miss 200 (6 calls) = 10 calls
          return {calls: [
            natCall('kv_get', ['page:p0'], {etag: 'e0', items: ['a', 'b'], next: 'p1'}),
            {operation: 'http.request', arguments: ['https://api.test/feed?c=p0', 'GET', '{"if-none-match":"e0"}', ''], result: 'h0'},
            {operation: 'http.responseStatus', arguments: ['h0'], result: 304},
            {operation: 'http.responseClose', arguments: ['h0']},
            natCall('kv_get', ['page:p1'], null),
            {operation: 'http.request', arguments: ['https://api.test/feed?c=p1', 'GET', '{}', ''], result: 'h1'},
            {operation: 'http.responseStatus', arguments: ['h1'], result: 200},
            {operation: 'http.responseHeaders', arguments: ['h1'], result: 'e1'},
            {operation: 'http.responseRead', arguments: ['h1'], result: 'b,c|'},
            natCall('kv_set', ['page:p1', {etag: 'e1', items: ['b', 'c'], next: ''}], true),
            {operation: 'http.responseClose', arguments: ['h1']},
          ]};
        }
        if (i === 1) {
          // c1 miss -> 429 retry -> 200 (11 calls)
          return {calls: [
            natCall('kv_get', ['page:c1'], null),
            {operation: 'http.request', arguments: ['https://api.test/items?c=c1', 'GET', '{}', ''], result: 'r0'},
            {operation: 'http.responseStatus', arguments: ['r0'], result: 429},
            {operation: 'platform.console.warn', arguments: ['rate-limit:c1']},
            {operation: 'http.responseClose', arguments: ['r0']},
            {operation: 'http.request', arguments: ['https://api.test/items?c=c1&retry=1', 'GET', '{}', ''], result: 'r1'},
            {operation: 'http.responseStatus', arguments: ['r1'], result: 200},
            {operation: 'http.responseHeaders', arguments: ['r1'], result: 'et-c1'},
            {operation: 'http.responseRead', arguments: ['r1'], result: 'x,y,x|'},
            natCall('kv_set', ['page:c1', {etag: 'et-c1', items: ['x', 'y', 'x'], next: ''}], true),
            {operation: 'http.responseClose', arguments: ['r1']},
          ]};
        }
        if (i === 2) {
          // k0 miss 200 -> k1 cached 304 -> k2 cached 304 = 15 -> keep to 2 pages: k0 200 (7) + k1 304 (4) = 11 calls
          return {calls: [
            natCall('kv_get', ['page:k0'], null),
            {operation: 'http.request', arguments: ['https://api.test/logs?c=k0', 'GET', '{}', ''], result: 'l0'},
            {operation: 'http.responseStatus', arguments: ['l0'], result: 200},
            {operation: 'http.responseHeaders', arguments: ['l0'], result: 'v1'},
            {operation: 'http.responseRead', arguments: ['l0'], result: 'm1,m2|k1'},
            natCall('kv_set', ['page:k0', {etag: 'v1', items: ['m1', 'm2'], next: 'k1'}], true),
            {operation: 'http.responseClose', arguments: ['l0']},
            natCall('kv_get', ['page:k1'], {etag: 'v2', items: ['m2', 'm3'], next: ''}),
            {operation: 'http.request', arguments: ['https://api.test/logs?c=k1', 'GET', '{"if-none-match":"v2"}', ''], result: 'l1'},
            {operation: 'http.responseStatus', arguments: ['l1'], result: 304},
            {operation: 'http.responseClose', arguments: ['l1']},
          ]};
        }
        if (i === 3) {
          // d1 cached 304 -> d2 cached but changed 200 = 11 calls
          return {calls: [
            natCall('kv_get', ['page:d1'], {etag: 't1', items: ['p'], next: 'd2'}),
            {operation: 'http.request', arguments: ['https://api.test/docs?c=d1', 'GET', '{"if-none-match":"t1"}', ''], result: 'd0'},
            {operation: 'http.responseStatus', arguments: ['d0'], result: 304},
            {operation: 'http.responseClose', arguments: ['d0']},
            natCall('kv_get', ['page:d2'], {etag: 't2old', items: ['old'], next: ''}),
            {operation: 'http.request', arguments: ['https://api.test/docs?c=d2', 'GET', '{"if-none-match":"t2old"}', ''], result: 'd1'},
            {operation: 'http.responseStatus', arguments: ['d1'], result: 200},
            {operation: 'http.responseHeaders', arguments: ['d1'], result: 't2new'},
            {operation: 'http.responseRead', arguments: ['d1'], result: 'p,q,r|'},
            natCall('kv_set', ['page:d2', {etag: 't2new', items: ['p', 'q', 'r'], next: ''}], true),
            {operation: 'http.responseClose', arguments: ['d1']},
          ]};
        }
        // i === 4: e0 429 then 304 (cached) = 8 calls
        return {calls: [
          natCall('kv_get', ['page:e0'], {etag: 'ee', items: ['u1', 'u2'], next: ''}),
          {operation: 'http.request', arguments: ['https://api.test/ev?c=e0', 'GET', '{"if-none-match":"ee"}', ''], result: 'e0'},
          {operation: 'http.responseStatus', arguments: ['e0'], result: 429},
          {operation: 'platform.console.warn', arguments: ['rate-limit:e0']},
          {operation: 'http.responseClose', arguments: ['e0']},
          {operation: 'http.request', arguments: ['https://api.test/ev?c=e0&retry=1', 'GET', '{"if-none-match":"ee"}', ''], result: 'e1'},
          {operation: 'http.responseStatus', arguments: ['e1'], result: 304},
          {operation: 'http.responseClose', arguments: ['e1']},
        ]};
      },
    },

    // C4. Virtual-DOM live reconciler computing minimal patches, respecting locks & mutating report arg
    {
      name: 'vdom-live-reconciler',
      source: `async function run(patches, report) {
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    const node = await host.domQuery(p.sel);
    try {
      if (p.remove) {
        const locked = await host.domGetAttribute(node, 'data-lock');
        if (locked === 'true') {
          report.skipped.push(p.sel);
        } else {
          await host.domRemove(node);
          report.removed.push(p.sel);
        }
      } else {
        const curText = await host.domGetText(node);
        const curCls = await host.domGetAttribute(node, 'class');
        let changed = false;
        if (p.text !== null && curText !== p.text) {
          await host.domSetText(node, p.text);
          changed = true;
        }
        if (p.cls !== null && curCls !== p.cls) {
          await host.domSetAttribute(node, 'class', p.cls);
          changed = true;
        }
        if (changed) report.updated.push(p.sel);
        else report.skipped.push(p.sel);
      }
    } finally {
      await host.domRelease(node);
    }
  }
  console.info('patch:' + report.updated.length + ':' + report.removed.length + ':' + report.skipped.length);
  return report;
}`,
      inputs: [
        [[{sel: '#h1', text: 'Title', cls: 'bold', remove: false}, {sel: '#old', text: null, cls: null, remove: true}], {updated: [], removed: [], skipped: []}],
        [[{sel: '#a', text: 'Same', cls: 'on', remove: false}, {sel: '#b', text: 'New', cls: 'off', remove: false}], {updated: [], removed: [], skipped: []}],
        [[{sel: '#x', text: null, cls: null, remove: true}, {sel: '#y', text: 'Hi', cls: 'active', remove: false}], {updated: [], removed: [], skipped: []}],
        [[{sel: '#p1', text: 'One', cls: null, remove: false}, {sel: '#p2', text: null, cls: 'hi', remove: false}, {sel: '#p3', text: null, cls: null, remove: true}], {updated: [], removed: [], skipped: []}],
        [[{sel: '#n1', text: 'Go', cls: 'btn', remove: false}, {sel: '#n2', text: null, cls: null, remove: true}], {updated: [], removed: [], skipped: []}],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'finally', 'mutation', 'alias', 'dom', 'platform', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // #h1 text+cls changed (6 calls), #old unlocked removed (4 calls), console.info (1) = 11 calls
          return {calls: [
            {operation: 'dom.query', arguments: ['#h1'], result: 'n0'},
            {operation: 'dom.getText', arguments: ['n0'], result: 'Draft'},
            {operation: 'dom.getAttribute', arguments: ['n0', 'class'], result: 'plain'},
            {operation: 'dom.setText', arguments: ['n0', 'Title']},
            {operation: 'dom.setAttribute', arguments: ['n0', 'class', 'bold']},
            {operation: 'dom.release', arguments: ['n0']},
            {operation: 'dom.query', arguments: ['#old'], result: 'n1'},
            {operation: 'dom.getAttribute', arguments: ['n1', 'data-lock'], result: 'false'},
            {operation: 'dom.remove', arguments: ['n1']},
            {operation: 'dom.release', arguments: ['n1']},
            {operation: 'platform.console.info', arguments: ['patch:1:1:0']},
          ]};
        }
        if (i === 1) {
          // #a unchanged (4 calls), #b text changed cls same (5 calls), console.info (1) = 10 calls
          return {calls: [
            {operation: 'dom.query', arguments: ['#a'], result: 'a0'},
            {operation: 'dom.getText', arguments: ['a0'], result: 'Same'},
            {operation: 'dom.getAttribute', arguments: ['a0', 'class'], result: 'on'},
            {operation: 'dom.release', arguments: ['a0']},
            {operation: 'dom.query', arguments: ['#b'], result: 'b0'},
            {operation: 'dom.getText', arguments: ['b0'], result: 'Old'},
            {operation: 'dom.getAttribute', arguments: ['b0', 'class'], result: 'off'},
            {operation: 'dom.setText', arguments: ['b0', 'New']},
            {operation: 'dom.release', arguments: ['b0']},
            {operation: 'platform.console.info', arguments: ['patch:1:0:1']},
          ]};
        }
        if (i === 2) {
          // #x locked skip (3 calls), #y cls changed only (5 calls), console.info (1) = 9 calls
          return {calls: [
            {operation: 'dom.query', arguments: ['#x'], result: 'x0'},
            {operation: 'dom.getAttribute', arguments: ['x0', 'data-lock'], result: 'true'},
            {operation: 'dom.release', arguments: ['x0']},
            {operation: 'dom.query', arguments: ['#y'], result: 'y0'},
            {operation: 'dom.getText', arguments: ['y0'], result: 'Hi'},
            {operation: 'dom.getAttribute', arguments: ['y0', 'class'], result: 'idle'},
            {operation: 'dom.setAttribute', arguments: ['y0', 'class', 'active']},
            {operation: 'dom.release', arguments: ['y0']},
            {operation: 'platform.console.info', arguments: ['patch:1:0:1']},
          ]};
        }
        if (i === 3) {
          // #p1 text changed (5), #p2 cls unchanged (4), #p3 removed (4), console.info (1) = 14 calls
          return {calls: [
            {operation: 'dom.query', arguments: ['#p1'], result: 'p1'},
            {operation: 'dom.getText', arguments: ['p1'], result: 'Zero'},
            {operation: 'dom.getAttribute', arguments: ['p1', 'class'], result: 'x'},
            {operation: 'dom.setText', arguments: ['p1', 'One']},
            {operation: 'dom.release', arguments: ['p1']},
            {operation: 'dom.query', arguments: ['#p2'], result: 'p2'},
            {operation: 'dom.getText', arguments: ['p2'], result: 'Keep'},
            {operation: 'dom.getAttribute', arguments: ['p2', 'class'], result: 'hi'},
            {operation: 'dom.release', arguments: ['p2']},
            {operation: 'dom.query', arguments: ['#p3'], result: 'p3'},
            {operation: 'dom.getAttribute', arguments: ['p3', 'data-lock'], result: ''},
            {operation: 'dom.remove', arguments: ['p3']},
            {operation: 'dom.release', arguments: ['p3']},
            {operation: 'platform.console.info', arguments: ['patch:1:1:1']},
          ]};
        }
        // i === 4: #n1 unchanged (4) + #n2 locked (3) + info (1) = 8 calls
        return {calls: [
          {operation: 'dom.query', arguments: ['#n1'], result: 'k1'},
          {operation: 'dom.getText', arguments: ['k1'], result: 'Go'},
          {operation: 'dom.getAttribute', arguments: ['k1', 'class'], result: 'btn'},
          {operation: 'dom.release', arguments: ['k1']},
          {operation: 'dom.query', arguments: ['#n2'], result: 'k2'},
          {operation: 'dom.getAttribute', arguments: ['k2', 'data-lock'], result: 'true'},
          {operation: 'dom.release', arguments: ['k2']},
          {operation: 'platform.console.info', arguments: ['patch:0:0:2']},
        ]};
      },
    },

    // C5. Streaming ETL pipeline with chunk-boundary line buffering, native enrichment & bad-row logging
    {
      name: 'streaming-etl-enricher',
      nativeBindings: [
        {name: 'enrich_record', kind: 'promise', description: 'Enrich {id, score} returning {tier, bonus} or rejecting on invalid record.'},
      ],
      source: `async function run(srcPath, dstPath) {
  const reader = await host.openRead(srcPath);
  const writer = await host.openWrite(dstPath);
  let buf = '', good = 0, bad = 0, totalBonus = 0;
  async function processLine(line) {
    if (!line.length) return;
    const comma = line.indexOf(',');
    if (comma <= 0) { bad++; console.error('malformed:' + line); return; }
    const id = line.slice(0, comma), score = Number(line.slice(comma + 1));
    try {
      const info = await enrich_record({id, score});
      const outLine = id + ':' + info.tier + ':' + (score + info.bonus) + '\\n';
      await host.writeChunk(writer, outLine);
      good++;
      totalBonus += info.bonus;
    } catch (err) {
      bad++;
      console.error('enrich:' + id + ':' + err);
    }
  }
  try {
    while (true) {
      const chunk = await host.readChunk(reader);
      if (chunk === '') break;
      buf += chunk;
      let nl = buf.indexOf('\\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        await processLine(line);
        nl = buf.indexOf('\\n');
      }
    }
    if (buf.length) await processLine(buf);
  } finally {
    await host.closeWrite(writer);
    await host.closeStream(reader);
  }
  return {good, bad, totalBonus};
}`,
      inputs: [
        ['raw0.csv', 'out0.txt'],
        ['raw1.csv', 'out1.txt'],
        ['raw2.csv', 'out2.txt'],
        ['raw3.csv', 'out3.txt'],
        ['raw4.csv', 'out4.txt'],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'exception', 'finally', 'fs', 'platform', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // 2 chunks split mid-line: "u1,80\nu" + "2,40\n" -> 2 enrich + 2 write -> 11 calls
          return {calls: [
            {operation: 'fs.openRead', arguments: ['raw0.csv'], result: 'r0'},
            {operation: 'fs.openWrite', arguments: ['out0.txt'], result: 'w0'},
            {operation: 'fs.readChunk', arguments: ['r0'], result: 'u1,80\nu'},
            natCall('enrich_record', [{id: 'u1', score: 80}], {tier: 'gold', bonus: 10}),
            {operation: 'fs.writeChunk', arguments: ['w0', 'u1:gold:90\n'], result: 11},
            {operation: 'fs.readChunk', arguments: ['r0'], result: '2,40\n'},
            natCall('enrich_record', [{id: 'u2', score: 40}], {tier: 'silver', bonus: 5}),
            {operation: 'fs.writeChunk', arguments: ['w0', 'u2:silver:45\n'], result: 13},
            {operation: 'fs.readChunk', arguments: ['r0'], result: ''},
            {operation: 'fs.closeWrite', arguments: ['w0']},
            {operation: 'fs.close', arguments: ['r0']},
          ]};
        }
        if (i === 1) {
          // 1 good + 1 rejected enrich + 1 malformed (no trailing newline) = 12 calls
          return {calls: [
            {operation: 'fs.openRead', arguments: ['raw1.csv'], result: 'r1'},
            {operation: 'fs.openWrite', arguments: ['out1.txt'], result: 'w1'},
            {operation: 'fs.readChunk', arguments: ['r1'], result: 'a,10\nbadrow\n'},
            natCall('enrich_record', [{id: 'a', score: 10}], {tier: 'std', bonus: 2}),
            {operation: 'fs.writeChunk', arguments: ['w1', 'a:std:12\n'], result: 9},
            {operation: 'platform.console.error', arguments: ['malformed:badrow']},
            {operation: 'fs.readChunk', arguments: ['r1'], result: 'b,-5'},
            {operation: 'fs.readChunk', arguments: ['r1'], result: ''},
            natCall('enrich_record', [{id: 'b', score: -5}], 'neg-score', {status: 'rejected'}),
            {operation: 'platform.console.error', arguments: ['enrich:b:neg-score']},
            {operation: 'fs.closeWrite', arguments: ['w1']},
            {operation: 'fs.close', arguments: ['r1']},
          ]};
        }
        if (i === 2) {
          // 3 small chunks forming 2 lines = 12 calls
          return {calls: [
            {operation: 'fs.openRead', arguments: ['raw2.csv'], result: 'r2'},
            {operation: 'fs.openWrite', arguments: ['out2.txt'], result: 'w2'},
            {operation: 'fs.readChunk', arguments: ['r2'], result: 'k1,'},
            {operation: 'fs.readChunk', arguments: ['r2'], result: '50\nk2,75'},
            natCall('enrich_record', [{id: 'k1', score: 50}], {tier: 'mid', bonus: 4}),
            {operation: 'fs.writeChunk', arguments: ['w2', 'k1:mid:54\n'], result: 10},
            {operation: 'fs.readChunk', arguments: ['r2'], result: ''},
            natCall('enrich_record', [{id: 'k2', score: 75}], {tier: 'top', bonus: 15}),
            {operation: 'fs.writeChunk', arguments: ['w2', 'k2:top:90\n'], result: 10},
            {operation: 'fs.closeWrite', arguments: ['w2']},
            {operation: 'fs.close', arguments: ['r2']},
          ]};
        }
        if (i === 3) {
          // 2 bad rows + 1 good row = 12 calls
          return {calls: [
            {operation: 'fs.openRead', arguments: ['raw3.csv'], result: 'r3'},
            {operation: 'fs.openWrite', arguments: ['out3.txt'], result: 'w3'},
            {operation: 'fs.readChunk', arguments: ['r3'], result: 'x1,9\n,12\nx2,20\n'},
            natCall('enrich_record', [{id: 'x1', score: 9}], 'too-low', {status: 'rejected'}),
            {operation: 'platform.console.error', arguments: ['enrich:x1:too-low']},
            {operation: 'platform.console.error', arguments: ['malformed:,12']},
            natCall('enrich_record', [{id: 'x2', score: 20}], {tier: 'ok', bonus: 3}),
            {operation: 'fs.writeChunk', arguments: ['w3', 'x2:ok:23\n'], result: 9},
            {operation: 'fs.readChunk', arguments: ['r3'], result: ''},
            {operation: 'fs.closeWrite', arguments: ['w3']},
            {operation: 'fs.close', arguments: ['r3']},
          ]};
        }
        // i === 4: 1 chunk with 2 good lines = 10 calls
        return {calls: [
          {operation: 'fs.openRead', arguments: ['raw4.csv'], result: 'r4'},
          {operation: 'fs.openWrite', arguments: ['out4.txt'], result: 'w4'},
          {operation: 'fs.readChunk', arguments: ['r4'], result: 'm,100\nn,200'},
          natCall('enrich_record', [{id: 'm', score: 100}], {tier: 'vip', bonus: 25}),
          {operation: 'fs.writeChunk', arguments: ['w4', 'm:vip:125\n'], result: 10},
          {operation: 'fs.readChunk', arguments: ['r4'], result: ''},
          natCall('enrich_record', [{id: 'n', score: 200}], {tier: 'vip', bonus: 50}),
          {operation: 'fs.writeChunk', arguments: ['w4', 'n:vip:250\n'], result: 10},
          {operation: 'fs.closeWrite', arguments: ['w4']},
          {operation: 'fs.close', arguments: ['r4']},
        ]};
      },
    },

    // C6. Stateful socket + DB order router mutating an audit log arg with guaranteed socket close
    {
      name: 'socket-db-order-router',
      nativeBindings: [
        {name: 'db_get', kind: 'promise', description: 'Load account record {cash, shares}.'},
        {name: 'db_put', kind: 'promise', description: 'Save updated account record {cash, shares}.'},
      ],
      source: `async function run(hostName, port, orders, audit) {
  const sock = await host.socketConnect(hostName, port);
  let filled = 0, rejected = 0;
  try {
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      const acct = await db_get('acct:' + o.acct);
      const maxCost = o.qty * o.limit;
      if (acct.cash < maxCost) {
        rejected++;
        audit.push({id: o.id, status: 'nsf'});
        console.warn('nsf:' + o.id);
        continue;
      }
      await host.socketWrite(sock, 'BUY:' + o.id + ':' + o.qty + '@' + o.limit);
      const reply = await host.socketRead(sock);
      if (reply.startsWith('FILL:')) {
        const px = Number(reply.slice(5));
        const cost = px * o.qty;
        await db_put('acct:' + o.acct, {cash: acct.cash - cost, shares: acct.shares + o.qty});
        filled++;
        audit.push({id: o.id, status: 'filled', cost});
      } else {
        rejected++;
        audit.push({id: o.id, status: 'venue-rej', reason: reply});
        console.warn('rej:' + o.id);
      }
    }
  } finally {
    await host.socketClose(sock);
  }
  return {filled, rejected, audit};
}`,
      inputs: [
        ['match.local', 7000, [{id: 'o1', acct: 'a1', qty: 3, limit: 10}, {id: 'o2', acct: 'a2', qty: 5, limit: 20}], []],
        ['match.local', 7000, [{id: 'o1', acct: 'u1', qty: 4, limit: 15}, {id: 'o2', acct: 'u1', qty: 2, limit: 10}], []],
        ['ex.local', 7100, [{id: 'k1', acct: 'c1', qty: 10, limit: 5}, {id: 'k2', acct: 'c2', qty: 2, limit: 8}], [{id: 'prev', status: 'filled', cost: 12}]],
        ['ex.local', 7200, [{id: 'x1', acct: 'm1', qty: 2, limit: 30}, {id: 'x2', acct: 'm2', qty: 4, limit: 12}], []],
        ['ex.local', 7300, [{id: 'z1', acct: 'p1', qty: 5, limit: 6}, {id: 'z2', acct: 'p1', qty: 3, limit: 6}], []],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'finally', 'mutation', 'alias', 'net', 'platform', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // o1 filled (4 calls), o2 nsf (2 calls) + connect/close = 8 calls
          return {calls: [
            {operation: 'net.connect', arguments: ['match.local', 7000], result: 's0'},
            natCall('db_get', ['acct:a1'], {cash: 50, shares: 0}),
            {operation: 'net.write', arguments: ['s0', 'BUY:o1:3@10'], result: 12},
            {operation: 'net.read', arguments: ['s0'], result: 'FILL:9'},
            natCall('db_put', ['acct:a1', {cash: 23, shares: 3}], true),
            natCall('db_get', ['acct:a2'], {cash: 80, shares: 2}),
            {operation: 'platform.console.warn', arguments: ['nsf:o2']},
            {operation: 'net.close', arguments: ['s0']},
          ]};
        }
        if (i === 1) {
          // o1 filled (4), o2 filled (4) + connect/close = 10 calls
          return {calls: [
            {operation: 'net.connect', arguments: ['match.local', 7000], result: 's1'},
            natCall('db_get', ['acct:u1'], {cash: 100, shares: 1}),
            {operation: 'net.write', arguments: ['s1', 'BUY:o1:4@15'], result: 12},
            {operation: 'net.read', arguments: ['s1'], result: 'FILL:14'},
            natCall('db_put', ['acct:u1', {cash: 44, shares: 5}], true),
            natCall('db_get', ['acct:u1'], {cash: 44, shares: 5}),
            {operation: 'net.write', arguments: ['s1', 'BUY:o2:2@10'], result: 12},
            {operation: 'net.read', arguments: ['s1'], result: 'FILL:10'},
            natCall('db_put', ['acct:u1', {cash: 24, shares: 7}], true),
            {operation: 'net.close', arguments: ['s1']},
          ]};
        }
        if (i === 2) {
          // k1 venue-rej (4), k2 filled (4) + connect/close = 10 calls
          return {calls: [
            {operation: 'net.connect', arguments: ['ex.local', 7100], result: 's2'},
            natCall('db_get', ['acct:c1'], {cash: 60, shares: 0}),
            {operation: 'net.write', arguments: ['s2', 'BUY:k1:10@5'], result: 12},
            {operation: 'net.read', arguments: ['s2'], result: 'REJ:NO_LIQ'},
            {operation: 'platform.console.warn', arguments: ['rej:k1']},
            natCall('db_get', ['acct:c2'], {cash: 25, shares: 4}),
            {operation: 'net.write', arguments: ['s2', 'BUY:k2:2@8'], result: 11},
            {operation: 'net.read', arguments: ['s2'], result: 'FILL:7'},
            natCall('db_put', ['acct:c2', {cash: 11, shares: 6}], true),
            {operation: 'net.close', arguments: ['s2']},
          ]};
        }
        if (i === 3) {
          // x1 nsf (2), x2 venue-rej (4) + connect/close = 8 calls
          return {calls: [
            {operation: 'net.connect', arguments: ['ex.local', 7200], result: 's3'},
            natCall('db_get', ['acct:m1'], {cash: 55, shares: 0}),
            {operation: 'platform.console.warn', arguments: ['nsf:x1']},
            natCall('db_get', ['acct:m2'], {cash: 50, shares: 1}),
            {operation: 'net.write', arguments: ['s3', 'BUY:x2:4@12'], result: 12},
            {operation: 'net.read', arguments: ['s3'], result: 'REJ:HALTED'},
            {operation: 'platform.console.warn', arguments: ['rej:x2']},
            {operation: 'net.close', arguments: ['s3']},
          ]};
        }
        // i === 4: z1 filled (4), z2 nsf after z1 spent cash (2) + connect/close = 8 calls
        return {calls: [
          {operation: 'net.connect', arguments: ['ex.local', 7300], result: 's4'},
          natCall('db_get', ['acct:p1'], {cash: 40, shares: 0}),
          {operation: 'net.write', arguments: ['s4', 'BUY:z1:5@6'], result: 11},
          {operation: 'net.read', arguments: ['s4'], result: 'FILL:5'},
          natCall('db_put', ['acct:p1', {cash: 15, shares: 5}], true),
          natCall('db_get', ['acct:p1'], {cash: 15, shares: 5}),
          {operation: 'platform.console.warn', arguments: ['nsf:z2']},
          {operation: 'net.close', arguments: ['s4']},
        ]};
      },
    },

    // C7. Rate-limited auth + cache gateway with sliding window reset & rejection recovery
    {
      name: 'rate-limited-auth-cache-gateway',
      nativeBindings: [
        {name: 'auth_check', kind: 'promise', description: 'Verify token for resource; returns {user, quota} or rejects.'},
        {name: 'kv_get', kind: 'promise', description: 'Read JSON object from KV store or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Write JSON object to KV store.'},
      ],
      source: `async function run(requests) {
  const responses = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const now = Date.now();
    let auth;
    try {
      auth = await auth_check(req.token, req.resource);
    } catch (err) {
      console.warn('auth-deny:' + req.resource + ':' + err);
      responses.push({ok: false, code: 401, data: null});
      continue;
    }
    const rateKey = 'rate:' + auth.user;
    let bucket = await kv_get(rateKey);
    if (bucket === null || now - bucket.start >= 60) bucket = {start: now, used: 0};
    if (bucket.used + req.cost > auth.quota) {
      console.warn('quota:' + auth.user);
      responses.push({ok: false, code: 429, data: null});
      continue;
    }
    await kv_set(rateKey, {start: bucket.start, used: bucket.used + req.cost});
    const cached = await kv_get('res:' + req.resource);
    if (cached !== null) {
      responses.push({ok: true, code: 200, source: 'cache', data: cached});
    } else {
      const fresh = {resource: req.resource, owner: auth.user, at: now};
      await kv_set('res:' + req.resource, fresh);
      console.info('miss:' + req.resource);
      responses.push({ok: true, code: 200, source: 'origin', data: fresh});
    }
  }
  return responses;
}`,
      inputs: [
        [[{token: 't1', resource: '/a', cost: 2}, {token: 'bad', resource: '/b', cost: 1}]],
        [[{token: 't1', resource: '/x', cost: 4}, {token: 't1', resource: '/y', cost: 3}]],
        [[{token: 't2', resource: '/m', cost: 5}, {token: 't2', resource: '/m', cost: 5}]],
        [[{token: 't3', resource: '/r1', cost: 2}, {token: 't3', resource: '/r2', cost: 4}]],
        [[{token: 'exp', resource: '/p', cost: 1}, {token: 't4', resource: '/q', cost: 3}]],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'exception', 'platform', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // req0: dateNow + auth + kv_get(rate) + kv_set(rate) + kv_get(res miss) + kv_set(res) + info = 7
          // req1: dateNow + auth reject + warn = 3 => 10 calls
          return {calls: [
            {operation: 'platform.dateNow', arguments: [], result: 100},
            natCall('auth_check', ['t1', '/a'], {user: 'alice', quota: 10}),
            natCall('kv_get', ['rate:alice'], null),
            natCall('kv_set', ['rate:alice', {start: 100, used: 2}], true),
            natCall('kv_get', ['res:/a'], null),
            natCall('kv_set', ['res:/a', {resource: '/a', owner: 'alice', at: 100}], true),
            {operation: 'platform.console.info', arguments: ['miss:/a']},
            {operation: 'platform.dateNow', arguments: [], result: 105},
            natCall('auth_check', ['bad', '/b'], 'invalid-sig', {status: 'rejected'}),
            {operation: 'platform.console.warn', arguments: ['auth-deny:/b:invalid-sig']},
          ]};
        }
        if (i === 1) {
          // req0: cache hit (5 calls), req1: quota exceeded (4 calls) => 9 calls
          return {calls: [
            {operation: 'platform.dateNow', arguments: [], result: 200},
            natCall('auth_check', ['t1', '/x'], {user: 'bob', quota: 5}),
            natCall('kv_get', ['rate:bob'], {start: 180, used: 0}),
            natCall('kv_set', ['rate:bob', {start: 180, used: 4}], true),
            natCall('kv_get', ['res:/x'], {v: 99}),
            {operation: 'platform.dateNow', arguments: [], result: 210},
            natCall('auth_check', ['t1', '/y'], {user: 'bob', quota: 5}),
            natCall('kv_get', ['rate:bob'], {start: 180, used: 4}),
            {operation: 'platform.console.warn', arguments: ['quota:bob']},
          ]};
        }
        if (i === 2) {
          // req0: window reset (now-start >= 60), miss (7 calls); req1: same window, hit (5 calls) = 12 calls
          return {calls: [
            {operation: 'platform.dateNow', arguments: [], result: 500},
            natCall('auth_check', ['t2', '/m'], {user: 'cy', quota: 10}),
            natCall('kv_get', ['rate:cy'], {start: 400, used: 9}),
            natCall('kv_set', ['rate:cy', {start: 500, used: 5}], true),
            natCall('kv_get', ['res:/m'], null),
            natCall('kv_set', ['res:/m', {resource: '/m', owner: 'cy', at: 500}], true),
            {operation: 'platform.console.info', arguments: ['miss:/m']},
            {operation: 'platform.dateNow', arguments: [], result: 520},
            natCall('auth_check', ['t2', '/m'], {user: 'cy', quota: 10}),
            natCall('kv_get', ['rate:cy'], {start: 500, used: 5}),
            natCall('kv_set', ['rate:cy', {start: 500, used: 10}], true),
            natCall('kv_get', ['res:/m'], {resource: '/m', owner: 'cy', at: 500}),
          ]};
        }
        if (i === 3) {
          // req0: hit (5), req1: window reset at exact 60s boundary -> hit (5) = 10 calls
          return {calls: [
            {operation: 'platform.dateNow', arguments: [], result: 300},
            natCall('auth_check', ['t3', '/r1'], {user: 'dan', quota: 5}),
            natCall('kv_get', ['rate:dan'], {start: 280, used: 3}),
            natCall('kv_set', ['rate:dan', {start: 280, used: 5}], true),
            natCall('kv_get', ['res:/r1'], {cached: 1}),
            {operation: 'platform.dateNow', arguments: [], result: 340},
            natCall('auth_check', ['t3', '/r2'], {user: 'dan', quota: 5}),
            natCall('kv_get', ['rate:dan'], {start: 280, used: 5}),
            natCall('kv_set', ['rate:dan', {start: 340, used: 4}], true),
            natCall('kv_get', ['res:/r2'], {cached: 2}),
          ]};
        }
        // i === 4: req0 auth fail (3), req1 miss (7) = 10 calls
        return {calls: [
          {operation: 'platform.dateNow', arguments: [], result: 600},
          natCall('auth_check', ['exp', '/p'], 'expired', {status: 'rejected'}),
          {operation: 'platform.console.warn', arguments: ['auth-deny:/p:expired']},
          {operation: 'platform.dateNow', arguments: [], result: 605},
          natCall('auth_check', ['t4', '/q'], {user: 'eva', quota: 6}),
          natCall('kv_get', ['rate:eva'], {start: 590, used: 1}),
          natCall('kv_set', ['rate:eva', {start: 590, used: 4}], true),
          natCall('kv_get', ['res:/q'], null),
          natCall('kv_set', ['res:/q', {resource: '/q', owner: 'eva', at: 605}], true),
          {operation: 'platform.console.info', arguments: ['miss:/q']},
        ]};
      },
    },

    // C8. Topological build/deploy runner reading manifest, computing topo order & content-addressed cache keys
    {
      name: 'topo-build-cache-runner',
      nativeBindings: [
        {name: 'kv_get', kind: 'promise', description: 'Lookup cached build artifact hash by cache key, or null.'},
        {name: 'kv_set', kind: 'promise', description: 'Store build artifact hash by cache key.'},
        {name: 'build_step', kind: 'promise', description: 'Compile target given its dependency artifact map; returns artifact hash or rejects.'},
      ],
      source: `function splitChar(str, sep) {
  if (!str.length) return [];
  const out = [];
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === sep) { out.push(cur); cur = ''; }
    else cur += str[i];
  }
  out.push(cur);
  return out;
}
function sortStrings(xs) {
  for (let i = 1; i < xs.length; i++) {
    const cur = xs[i];
    let j = i - 1;
    while (j >= 0 && xs[j] > cur) { xs[j + 1] = xs[j]; j--; }
    xs[j + 1] = cur;
  }
}
async function run(manifestPath) {
  const raw = await host.readText(manifestPath);
  const lines = splitChar(raw, '\\n');
  const nodes = [], hashes = Object.create(null), deps = Object.create(null), adj = Object.create(null), deg = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    const parts = splitChar(lines[i], ':');
    const name = parts[0], h = parts[1], depList = parts[2] ? splitChar(parts[2], ',') : [];
    nodes.push(name);
    hashes[name] = h;
    deps[name] = depList;
    adj[name] = [];
    deg[name] = depList.length;
  }
  for (let i = 0; i < nodes.length; i++) {
    const u = nodes[i];
    for (let j = 0; j < deps[u].length; j++) adj[deps[u][j]].push(u);
  }
  const ready = [];
  for (let i = 0; i < nodes.length; i++) if (deg[nodes[i]] === 0) ready.push(nodes[i]);
  const order = [];
  while (ready.length) {
    sortStrings(ready);
    const cur = ready.shift();
    order.push(cur);
    for (let i = 0; i < adj[cur].length; i++) {
      const nxt = adj[cur][i];
      deg[nxt]--;
      if (deg[nxt] === 0) ready.push(nxt);
    }
  }
  const outputs = {};
  const built = [], cached = [];
  for (let i = 0; i < order.length; i++) {
    const t = order[i];
    const depObj = {};
    const depParts = [];
    for (let j = 0; j < deps[t].length; j++) {
      const d = deps[t][j];
      depObj[d] = outputs[d];
      depParts.push(d + '=' + outputs[d]);
    }
    const cacheKey = t + '@' + hashes[t] + '(' + depParts.join(',') + ')';
    const hit = await kv_get(cacheKey);
    if (hit !== null) {
      outputs[t] = hit;
      cached.push(t);
    } else {
      try {
        const outHash = await build_step(t, depObj);
        await kv_set(cacheKey, outHash);
        outputs[t] = outHash;
        built.push(t);
      } catch (err) {
        console.error('build-fail:' + t + ':' + err);
        return {ok: false, order, built, cached, failed: t, outputs};
      }
    }
  }
  console.info('build-ok:' + built.length + '/' + order.length);
  return {ok: true, order, built, cached, failed: null, outputs};
}`,
      inputs: [
        ['m0.txt'],
        ['m1.txt'],
        ['m2.txt'],
        ['m3.txt'],
        ['m4.txt'],
      ],
      features: ['external', 'native-bindings', 'sequential', 'loop', 'branch', 'exception', 'fs', 'platform', 'graph', 'hard-workflow'],
      tier: 5,
      fixture: i => {
        if (i === 0) {
          // core -> lib -> app; core cached, lib built, app built = 1 + 1 + 3 + 3 + 1 = 9 calls
          return {calls: [
            {operation: 'fs.readText', arguments: ['m0.txt'], result: 'app:h3:lib\nlib:h2:core\ncore:h1:'},
            natCall('kv_get', ['core@h1()'], 'art-core'),
            natCall('kv_get', ['lib@h2(core=art-core)'], null),
            natCall('build_step', ['lib', {core: 'art-core'}], 'art-lib'),
            natCall('kv_set', ['lib@h2(core=art-core)', 'art-lib'], true),
            natCall('kv_get', ['app@h3(lib=art-lib)'], null),
            natCall('build_step', ['app', {lib: 'art-lib'}], 'art-app'),
            natCall('kv_set', ['app@h3(lib=art-lib)', 'art-app'], true),
            {operation: 'platform.console.info', arguments: ['build-ok:2/3']},
          ]};
        }
        if (i === 1) {
          // diamond: a -> b, a -> c, b+c -> d (topo: a,b,c,d); a cached, b cached, c fails = 1 + 1 + 1 + 2 + 1 = 6 calls
          return {calls: [
            {operation: 'fs.readText', arguments: ['m1.txt'], result: 'd:hd:b,c\nc:hc:a\nb:hb:a\na:ha:'},
            natCall('kv_get', ['a@ha()'], 'oa'),
            natCall('kv_get', ['b@hb(a=oa)'], 'ob'),
            natCall('kv_get', ['c@hc(a=oa)'], null),
            natCall('build_step', ['c', {a: 'oa'}], 'syntax-err', {status: 'rejected'}),
            {operation: 'platform.console.error', arguments: ['build-fail:c:syntax-err']},
          ]};
        }
        if (i === 2) {
          // diamond: a,b,c,d; a cached, b built, c cached, d built = 1 + 1 + 3 + 1 + 3 + 1 = 10 calls
          return {calls: [
            {operation: 'fs.readText', arguments: ['m2.txt'], result: 'd:4:b,c\nb:2:a\nc:3:a\na:1:'},
            natCall('kv_get', ['a@1()'], 'A1'),
            natCall('kv_get', ['b@2(a=A1)'], null),
            natCall('build_step', ['b', {a: 'A1'}], 'B2'),
            natCall('kv_set', ['b@2(a=A1)', 'B2'], true),
            natCall('kv_get', ['c@3(a=A1)'], 'C3'),
            natCall('kv_get', ['d@4(b=B2,c=C3)'], null),
            natCall('build_step', ['d', {b: 'B2', c: 'C3'}], 'D4'),
            natCall('kv_set', ['d@4(b=B2,c=C3)', 'D4'], true),
            {operation: 'platform.console.info', arguments: ['build-ok:2/4']},
          ]};
        }
        if (i === 3) {
          // two roots x,y -> z (topo x,y,z); x built, y cached, z built = 1 + 3 + 1 + 3 + 1 = 9 calls
          return {calls: [
            {operation: 'fs.readText', arguments: ['m3.txt'], result: 'z:hz:x,y\ny:hy:\nx:hx:'},
            natCall('kv_get', ['x@hx()'], null),
            natCall('build_step', ['x', {}], 'ox'),
            natCall('kv_set', ['x@hx()', 'ox'], true),
            natCall('kv_get', ['y@hy()'], 'oy'),
            natCall('kv_get', ['z@hz(x=ox,y=oy)'], null),
            natCall('build_step', ['z', {x: 'ox', y: 'oy'}], 'oz'),
            natCall('kv_set', ['z@hz(x=ox,y=oy)', 'oz'], true),
            {operation: 'platform.console.info', arguments: ['build-ok:2/3']},
          ]};
        }
        // i === 4: 4-node chain p1 -> p2 -> p3 -> p4; p1 built, p2 cached, p3 fails = 1 + 3 + 1 + 2 + 1 = 8 calls
        return {calls: [
          {operation: 'fs.readText', arguments: ['m4.txt'], result: 'p4:4:p3\np3:3:p2\np2:2:p1\np1:1:'},
          natCall('kv_get', ['p1@1()'], null),
          natCall('build_step', ['p1', {}], 'o1'),
          natCall('kv_set', ['p1@1()', 'o1'], true),
          natCall('kv_get', ['p2@2(p1=o1)'], 'o2'),
          natCall('kv_get', ['p3@3(p2=o2)'], null),
          natCall('build_step', ['p3', {p2: 'o2'}], 'oom', {status: 'rejected'}),
          {operation: 'platform.console.error', arguments: ['build-fail:p3:oom']},
        ]};
      },
    },
  ];
}
