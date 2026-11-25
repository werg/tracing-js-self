// Reproducible task construction. Source families are assigned before admission,
// expansion or splitting; refusals remain in the candidate census.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'acorn';
import {SEMANTIC_TASK_TEMPLATES, BENCHMARK_ALGORITHMS, semanticRecipeFamilies, benchmarkFamiliesV1} from './recipe-fixtures.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from './engineering-fixtures.js';
import {trustedRealSourceCases} from '../corpus/trusted-source-candidates.mjs';
import {encodeReadable, normalizedSourceHash} from './tinker-execution.js';

export const BENCHMARK_SCHEMA = 'tinker-generalization-corpus/1';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || ArrayBuffer.isView(value) ? value : JSON.stringify(value)).digest('hex');
export function seededRandom(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw TypeError('seed must be uint32');
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

// Conservative lexical near-clone fingerprint. Renaming identifiers or changing
// literal values never creates an independent family. This is an extra union
// edge, not a claim to decide semantic equivalence of arbitrary JavaScript.
export function nearCloneHash(source) {
  const clean = node => {
    // Admission enforces strict mode for every task. An already-present strict
    // directive must not defeat clone grouping after a rename/constant change.
    if (Array.isArray(node)) return node.filter(item=>!(item?.type==='ExpressionStatement'&&item.directive==='use strict')).map(clean);
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'Identifier') return {type: 'Identifier'};
    if (node.type === 'Literal') return {type: 'Literal', valueType: node.regex ? 'regexp' : node.bigint ? 'bigint' : node.value === null ? 'null' : typeof node.value};
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, value]) => [key, clean(value)]));
  };
  return sha256(clean(parse(source, {ecmaVersion: 'latest', sourceType: 'script'})));
}

const sparse = () => { const xs = new Array(3); xs[1] = undefined; return xs; };
const definition = (name, body, inputs, features = [], tier = 2) => ({name, source: 'function run(a,b){' + body + '}', inputs, features, tier});
export function boundaryTemplates() {
  return [
    definition('bounded-range', 'if(a<0)return 0;if(a>b)return b;return a;', [[-3,5],[0,5],[3,5],[9,5]], ['branch'], 1),
    definition('object-counter-alias', 'a.count+=b;return a;', [[{count:0},1],[{count:3},-2],[{count:-1},1],[{count:8},4]], ['mutation','alias'], 3),
    definition('property-delete-presence', 'const before=("x" in a);delete a.x;return [before,("x" in a),a];', [[{x:undefined},0],[{},0],[{x:4,y:2},0],[{x:null},0]], ['mutation','property-presence','alias'], 3),
    definition('append-shared-object', 'a.push(a[0]);return a;', [[[{x:1}],0],[[],0],[[{x:2},{x:3}],0],[[{x:0}],0]], ['array','mutation','alias'], 3),
    definition('create-self-cycle', 'a.self=a;return a;', [[{n:1},0],[{},0],[{n:-1},0],[{n:9},0]], ['mutation','cycle','alias'], 3),
    definition('sparse-slot-presence', 'return [a.length,0 in a,1 in a,2 in a];', [[sparse(),0],[[undefined],0],[[],0],[[1,undefined,3],0]], ['array','sparse','property-presence'], 2),
    definition('make-sparse-mutation', 'a.length=4;a[2]=b;delete a[0];return a;', [[[1,2],9],[[],0],[[undefined],-1],[[1,2,3,4,5],2]], ['array','sparse','mutation','alias'], 3),
    definition('negative-zero-reciprocal', 'return [a,1/a,Object.is(a,-0)];', [[-0,0],[0,0],[2,0],[-2,0]], ['exceptional-scalar'], 1),
    definition('nonfinite-arithmetic', 'return [a/b,a%b,a===a];', [[0,0],[1,0],[-1,0],[NaN,2]], ['exceptional-scalar'], 1),
    definition('bigint-quotient', 'return [a/b,a%b];', [[9n,2n],[-9n,2n],[0n,3n],[21n,5n]], ['bigint'], 2),
    definition('null-prototype-result', 'const result=Object.create(null);result.value=a;return result;', [[1,0],[null,0],[undefined,0],[{x:2},0]], ['null-prototype','object'], 3),
    definition('user-object-js-key', 'a.$js=b;return a;', [[{},'literal'],[{x:1},'undefined'],[{$js:'old'},'ref'],[{},'array']], ['object','mutation','alias'], 3),
    {...definition('throw-or-return', 'if(a<0)throw b;return a+b;', [[-1,'bad'],[1,2],[0,3],[-2,{reason:'bad'}]], ['branch','exception'], 3),throws:i=>i===0||i===3},
    definition('catch-finally-mutation', 'try{if(b<0)throw b;return b*2;}catch(e){return e-1;}finally{a.count++;}', [[{count:0},2],[{count:1},-2],[{count:2},0],[{count:3},-1]], ['exception','mutation','finally'], 3),
    {...definition('standard-error-profile', 'if(a)throw new TypeError("bad input");return b;', [[true,0],[false,2],[true,3],[false,undefined]], ['exception','standard-error'], 3),throws:i=>i===0||i===2},
    definition('short-circuit-side-effect', 'const result=a.flag&&(a.count+=b);return [result,a];', [[{flag:false,count:1},3],[{flag:true,count:1},3],[{flag:0,count:2},1],[{flag:true,count:0},-2]], ['branch','mutation'], 3),
    definition('nullish-coalescing', 'return a??b;', [[null,4],[undefined,5],[0,7],[false,9]], ['branch','nullish'], 1),
    definition('nested-object-alias', 'a.inner.value+=b;return [a.inner,a];', [[{inner:{value:1}},2],[{inner:{value:0}},0],[{inner:{value:-3}},1],[{inner:{value:5}},-2]], ['mutation','alias','nested-object'], 3),
    definition('array-reverse-in-place', 'let i=0;let j=a.length-1;while(i<j){const x=a[i];a[i]=a[j];a[j]=x;i++;j--;}return a;', [[[],0],[[1],0],[[1,2,3],0],[[4,3,2,1],0]], ['loop','array','mutation','alias'], 3),
    definition('array-splice-observation', 'const removed=a.splice(b,1);return [removed,a];', [[[],0],[[1,2,3],1],[[4],0],[[1,2,3,4],-1]], ['array','mutation','alias'], 3),
    definition('string-codepoint-vs-unit', 'return [a.length,a.charCodeAt(b),a.codePointAt(b)];', [['A😀B',1],['abc',0],['',0],['éZ',1]], ['string','unicode'], 2),
    definition('own-property-order', 'a.z=b;a["2"]=a.x;delete a.x;return Object.keys(a);', [[{x:1,y:2},3],[{},0],[{x:undefined},1],[{x:null,z:4},9]], ['object','mutation','property-order'], 3),
    definition('destructure-defaults', 'const {x=2,y=b}=a;return [x,y];', [[{},3],[{x:undefined},4],[{x:null,y:0},7],[{x:9,y:1},2]], ['object','undefined','destructure'], 2),
    definition('loop-break-continue', 'let sum=0;for(let i=0;i<a.length;i++){if(a[i]<0)continue;if(a[i]>b)break;sum+=a[i];}return sum;', [[[],4],[[1],4],[[-1,2,8,1],4],[[0,1,2,3],3]], ['loop','branch','break','continue'], 2),
    {name:'observed-branch-write',source:'async function run(a){const value=await host.readAsync("value");if(value>a){host.store("chosen",value);return value;}host.store("chosen",0);return 0;}',
      inputs:[[3],[3],[3],[3]],features:['external','branch','mutation'],tier:4,
      fixture:i=>{const n=[-1,3,4,9][i%4];return {calls:[{operation:'demo.readAsync',arguments:['value'],result:n},{operation:'demo.store',arguments:['chosen',n>3?n:0]}]};}},
    {name:'sequential-observation-dependent-call',source:'async function run(){const a=await host.readAsync("first");const b=await host.readAsync(a>0?"positive":"nonpositive");return a-b;}',
      inputs:[[],[],[],[]],features:['external','sequential','branch'],tier:5,
      fixture:i=>{const a=[-2,0,3,5][i%4],b=[4,1,2,-3][i%4];return {calls:[{operation:'demo.readAsync',arguments:['first'],result:a},{operation:'demo.readAsync',arguments:[a>0?'positive':'nonpositive'],result:b}]};}},
    {name:'rejected-read-caught',source:'async function run(a){try{return (await host.readAsync("value"))+a;}catch(e){return ["caught",e,a];}}',
      inputs:[[1],[1],[1],[1]],features:['external','exception'],tier:4,
      fixture:i=>({calls:[{operation:'demo.readAsync',arguments:['value'],result:i%2?'missing':i,status:i%2?'rejected':'fulfilled'}]})},
    {name:'two-observations-finally',source:'async function run(){let a=await host.readAsync("a");try{a+=await host.readAsync("b");return a;}finally{host.store("cleanup",a);}}',
      inputs:[[],[],[],[]],features:['external','sequential','finally','exception'],tier:5,
      throws:i=>i%2===1,
      fixture:i=>({calls:[{operation:'demo.readAsync',arguments:['a'],result:i},{operation:'demo.readAsync',arguments:['b'],result:i%2?'stop':2,status:i%2?'rejected':'fulfilled'},{operation:'demo.store',arguments:['cleanup',i%2?i:i+2]}]})},
  ];
}

function featureTags(source, extra = []) {
  return [...new Set([...extra,
    ...(/\b(?:for|while)\b/.test(source) ? ['loop'] : []), ...(/\bif\b|\?/.test(source) ? ['branch'] : []),
    ...(/\bthrow\b|\bcatch\b/.test(source) ? ['exception'] : []), ...(/host\.|Date\.now|console\./.test(source) ? ['external'] : []),
    ...(/\.length|\[[^\]]*\]/.test(source) ? ['array'] : [])])].sort();
}

function templateInputs(template) {
  if (template.inputs.length >= 4) return template.inputs;
  const [a,b] = template.inputs[0];
  const edge = [Array.isArray(a) ? [] : 0, Array.isArray(b) ? [] : (typeof b === 'number' ? Math.max(1,b) : b)];
  const novel = [Array.isArray(a) ? [2,0,-1,3] : 7, Array.isArray(b) ? [1,2,3,4] : (typeof b === 'number' ? Math.max(1,b+1) : b)];
  return [...template.inputs, edge, novel];
}

function decorate(raw, {template, index, form, sourceOrigin, seed}) {
  const family = raw.family ?? 'generated:' + template.name;
  return {...raw, id: raw.id ?? family.replaceAll(/[^a-zA-Z0-9_-]/g,'-') + '-' + form + '-' + index,
    family, args: encodeReadable(raw.args ?? []), fixture: {calls: (raw.fixture?.calls ?? []).map(call => ({...call,
      arguments: encodeReadable(call.arguments ?? []), result: encodeReadable(call.result)})),
      ...(raw.fixture?.settlementOrder ? {settlementOrder: raw.fixture.settlementOrder} : {})},
    randomSeed: seed, maxSteps: 100000, timeoutMs: 10000,
    metadata: {features: featureTags(raw.source, template.features), tier: Math.max(template.tier ?? 2, form.startsWith('observed') ? 4 : form === 'packet' ? 3 : 1),
      template: family, lineage: [...new Set([family, ...(raw.ancestorIds ?? []), 'near-clone:' + nearCloneHash(template.source)])],
      sourceOrigin, sourceForm: form, inputVariant: index, evaluationRole: 'generalization',
      branchTargets: ['boundary-inputs','ordinary-inputs', ...(template.fixture ? ['counterfactual-observations','exceptional-observations-when-declared'] : [])],
      agentTaskSuccessVerified: false, ...raw.metadata}};
}

function expandTemplate(template, seed) {
  const inputs = templateInputs(template), rows = [];
  const core = template.source.replace(/\bfunction\s+run\b/, 'function __benchmarkCore');
  if (core === template.source) throw Error('Generator template must declare run');
  for (let i=0;i<inputs.length;i++) {
    const original = template.fixture?.(i) ?? {calls:[]}, args=structuredClone(inputs[i]);
    const forms = [
      ['direct',template.source,args,original],
      ['packet',core+'\nasync function run(packet){packet.answer=await __benchmarkCore(...packet.inputs);return packet;}',[{inputs:args}],original],
      ['observed-branch',core+'\nasync function run(...args){const gate=await host.readAsync("gate");const answer=await __benchmarkCore(...args);host.store("selected",gate>0?gate:0);return answer;}',args,
        {calls:[{operation:'demo.readAsync',arguments:['gate'],result:[-2,0,3,7][i%4]},...original.calls,
          ...(template.throws?.(i)?[]:[{operation:'demo.store',arguments:['selected',Math.max(0,[-2,0,3,7][i%4])]}])]}],
    ];
    for (const [form,source,actualArgs,fixture] of forms) rows.push(decorate({source,entry:'run',args:actualArgs,fixture},{template,index:i,form,sourceOrigin:'authored-generator',seed}));
  }
  return rows;
}

export function longProgramTemplates() {
  return [
    {
      name: 'merge-sort-pipeline',
      source: `function merge(left, right) {
  const out = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] <= right[j]) { out.push(left[i]); i++; }
    else { out.push(right[j]); j++; }
  }
  while (i < left.length) { out.push(left[i]); i++; }
  while (j < right.length) { out.push(right[j]); j++; }
  return out;
}
function mergeSort(xs) {
  if (xs.length <= 1) return xs.slice();
  const mid = Math.floor(xs.length / 2);
  return merge(mergeSort(xs.slice(0, mid)), mergeSort(xs.slice(mid)));
}
function run(xs) {
  const sorted = mergeSort(xs);
  let checksum = 0;
  for (let i = 0; i < sorted.length; i++) checksum += sorted[i] * (i + 1);
  return {sorted, checksum};
}`,
      inputs: [[[]], [[5]], [[4, 1, 3, 2]], [[9, -2, 7, 1, 5, 0, -2, 8]], [[12, 3, 19, 7, 1, 14, 6, 11, 2, 8, 5, 10]], [[30, 10, 20, 5, 15, 25, 0, -5, 12, 18, 3, 7, 22, 1, 9, 14]]],
      features: ['recursion', 'loop', 'array', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'rle-codec-roundtrip',
      source: `function encodeRle(text) {
  if (!text.length) return [];
  const runs = [];
  let current = text[0], count = 1;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === current) count++;
    else { runs.push([current, count]); current = text[i]; count = 1; }
  }
  runs.push([current, count]);
  return runs;
}
function decodeRle(runs) {
  let out = '';
  for (let i = 0; i < runs.length; i++) {
    const ch = runs[i][0], n = runs[i][1];
    for (let k = 0; k < n; k++) out += ch;
  }
  return out;
}
function run(text) {
  const encoded = encodeRle(text);
  const decoded = decodeRle(encoded);
  return {runs: encoded.length, same: decoded === text, encoded};
}`,
      inputs: [[''], ['a'], ['aaabbc'], ['wwwwaaadexxxxxx'], ['abbcccddddeeeeeffff'], ['xxxyyyyyzzzaaaabbbcccccdddeeeff']],
      features: ['string', 'loop', 'array', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'rpn-stack-vm',
      source: `function applyOp(op, a, b) {
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b === 0 ? 0 : Math.trunc(a / b);
  throw new Error('bad op: ' + op);
}
function run(tokens, env) {
  const stack = [];
  let ops = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (typeof tok === 'number') stack.push(tok);
    else if (tok === 'dup') { stack.push(stack[stack.length - 1]); ops++; }
    else if (tok === 'swap') { const b = stack.pop(), a = stack.pop(); stack.push(b, a); ops++; }
    else if (tok === '+' || tok === '-' || tok === '*' || tok === '/') {
      const b = stack.pop(), a = stack.pop();
      stack.push(applyOp(tok, a, b));
      ops++;
    } else if (tok in env) stack.push(env[tok]);
    else throw new RangeError('unknown symbol: ' + tok);
  }
  return {top: stack.length ? stack[stack.length - 1] : null, depth: stack.length, ops};
}`,
      inputs: [
        [[], {}],
        [[3, 4, '+'], {}],
        [['x', 2, '*', 'y', '+'], {x: 5, y: 3}],
        [[10, 2, '/', 'dup', '*', 3, '-'], {}],
        [['a', 'b', '+', 'c', '*', 'a', 'swap', '-', 2, '/'], {a: 7, b: 5, c: 3}],
        [['x', 'dup', '*', 'y', 'dup', '*', '+', 'z', '-', 3, '*', 4, '+', 2, '/'], {x: 4, y: 3, z: 5}],
      ],
      features: ['loop', 'branch', 'array', 'object', 'exception', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'lru-cache-simulator',
      source: `function touch(order, key) {
  const idx = order.indexOf(key);
  if (idx !== -1) order.splice(idx, 1);
  order.push(key);
}
function run(capacity, ops) {
  const store = Object.create(null);
  const order = [];
  let hits = 0, misses = 0, evictions = 0;
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op[0] === 'get') {
      const k = op[1];
      if (k in store) { hits++; touch(order, k); results.push(store[k]); }
      else { misses++; results.push(null); }
    } else if (op[0] === 'put') {
      const k = op[1], v = op[2];
      if (!(k in store) && order.length >= capacity) {
        const oldest = order.shift();
        delete store[oldest];
        evictions++;
      }
      store[k] = v;
      touch(order, k);
    }
  }
  return {results, hits, misses, evictions, order};
}`,
      inputs: [
        [2, []],
        [2, [['put', 'a', 1], ['get', 'a'], ['get', 'b']]],
        [2, [['put', 'a', 1], ['put', 'b', 2], ['get', 'a'], ['put', 'c', 3], ['get', 'b'], ['get', 'c']]],
        [3, [['put', 'k1', 10], ['put', 'k2', 20], ['put', 'k3', 30], ['get', 'k1'], ['put', 'k4', 40], ['get', 'k2'], ['put', 'k1', 11], ['get', 'k1'], ['put', 'k5', 50], ['get', 'k3']]],
        [2, [['put', 'x', 1], ['put', 'y', 2], ['put', 'x', 9], ['put', 'z', 3], ['get', 'y'], ['get', 'x'], ['put', 'w', 4], ['get', 'z'], ['get', 'x']]],
        [3, [['put', 'a', 1], ['put', 'b', 2], ['put', 'c', 3], ['get', 'a'], ['get', 'b'], ['put', 'd', 4], ['get', 'c'], ['put', 'e', 5], ['get', 'a'], ['put', 'b', 22], ['put', 'f', 6], ['get', 'd'], ['get', 'b']]],
      ],
      features: ['loop', 'branch', 'array', 'object', 'mutation', 'null-prototype', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'interval-sweep-merge',
      source: `function sortIntervals(intervals) {
  const copy = [];
  for (let i = 0; i < intervals.length; i++) copy.push([intervals[i][0], intervals[i][1]]);
  for (let i = 1; i < copy.length; i++) {
    const cur = copy[i];
    let j = i - 1;
    while (j >= 0 && (copy[j][0] > cur[0] || (copy[j][0] === cur[0] && copy[j][1] > cur[1]))) {
      copy[j + 1] = copy[j];
      j--;
    }
    copy[j + 1] = cur;
  }
  return copy;
}
function run(intervals) {
  if (!intervals.length) return {merged: [], covered: 0};
  const sorted = sortIntervals(intervals);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1], cur = sorted[i];
    if (cur[0] <= prev[1]) {
      if (cur[1] > prev[1]) prev[1] = cur[1];
    } else merged.push(cur);
  }
  let covered = 0;
  for (let i = 0; i < merged.length; i++) covered += merged[i][1] - merged[i][0];
  return {merged, covered};
}`,
      inputs: [
        [[]],
        [[[1, 3]]],
        [[[5, 8], [1, 3], [2, 6]]],
        [[[10, 12], [1, 4], [4, 7], [15, 20], [11, 16]]],
        [[[8, 10], [1, 3], [2, 5], [12, 14], [13, 18], [5, 7], [20, 22]]],
        [[[14, 18], [2, 5], [1, 3], [6, 9], [8, 12], [11, 15], [20, 25], [22, 23], [0, 1]]],
      ],
      features: ['loop', 'branch', 'array', 'mutation', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'graph-bfs-shortest-path',
      source: `function reconstruct(parent, target) {
  const path = [];
  let cur = target;
  while (cur !== null) { path.push(cur); cur = parent[cur]; }
  path.reverse();
  return path;
}
function run(graph, start, goal) {
  if (start === goal) return {found: true, distance: 0, path: [start]};
  const queue = [start];
  const parent = Object.create(null);
  parent[start] = null;
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    const neighbors = graph[node] || [];
    for (let i = 0; i < neighbors.length; i++) {
      const next = neighbors[i];
      if (!(next in parent)) {
        parent[next] = node;
        if (next === goal) {
          const path = reconstruct(parent, goal);
          return {found: true, distance: path.length - 1, path};
        }
        queue.push(next);
      }
    }
  }
  return {found: false, distance: -1, path: []};
}`,
      inputs: [
        [{a: ['b'], b: []}, 'a', 'a'],
        [{a: ['b'], b: ['c'], c: []}, 'a', 'c'],
        [{a: ['b'], b: [], c: ['d']}, 'a', 'd'],
        [{a: ['b', 'c'], b: ['d'], c: ['d', 'e'], d: ['f'], e: ['f'], f: []}, 'a', 'f'],
        [{s: ['a', 'b'], a: ['c', 'd'], b: ['d', 'e'], c: ['f'], d: ['f', 'g'], e: ['g'], f: ['t'], g: ['t'], t: []}, 's', 't'],
        [{n0: ['n1', 'n2'], n1: ['n3', 'n4'], n2: ['n4', 'n5'], n3: ['n6'], n4: ['n6', 'n7'], n5: ['n7', 'n8'], n6: ['n9'], n7: ['n9'], n8: ['n9'], n9: []}, 'n0', 'n9'],
      ],
      features: ['loop', 'branch', 'array', 'object', 'null-prototype', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'topo-sort-kahn',
      source: `function sortStrings(xs) {
  for (let i = 1; i < xs.length; i++) {
    const cur = xs[i];
    let j = i - 1;
    while (j >= 0 && xs[j] > cur) { xs[j + 1] = xs[j]; j--; }
    xs[j + 1] = cur;
  }
}
function computeIndegrees(nodes, edges) {
  const deg = Object.create(null);
  const adj = Object.create(null);
  for (let i = 0; i < nodes.length; i++) { deg[nodes[i]] = 0; adj[nodes[i]] = []; }
  for (let i = 0; i < edges.length; i++) {
    const u = edges[i][0], v = edges[i][1];
    adj[u].push(v);
    deg[v]++;
  }
  return {deg, adj};
}
function run(nodes, edges) {
  const {deg, adj} = computeIndegrees(nodes, edges);
  const ready = [];
  for (let i = 0; i < nodes.length; i++) if (deg[nodes[i]] === 0) ready.push(nodes[i]);
  const order = [];
  while (ready.length) {
    sortStrings(ready);
    const cur = ready.shift();
    order.push(cur);
    const nexts = adj[cur];
    for (let i = 0; i < nexts.length; i++) {
      const nxt = nexts[i];
      deg[nxt]--;
      if (deg[nxt] === 0) ready.push(nxt);
    }
  }
  return {acyclic: order.length === nodes.length, order};
}`,
      inputs: [
        [[], []],
        [['a', 'b'], [['a', 'b']]],
        [['a', 'b'], [['a', 'b'], ['b', 'a']]],
        [['a', 'b', 'c', 'd'], [['a', 'c'], ['b', 'c'], ['c', 'd']]],
        [['t1', 't2', 't3', 't4', 't5'], [['t1', 't3'], ['t2', 't3'], ['t3', 't4'], ['t2', 't5'], ['t5', 't4']]],
        [['a', 'b', 'c', 'd', 'e', 'f', 'g'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['c', 'e'], ['d', 'f'], ['e', 'f'], ['f', 'g']]],
      ],
      features: ['loop', 'branch', 'array', 'object', 'null-prototype', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'lexical-scanner',
      source: `function isDigit(c) { return c >= '0' && c <= '9'; }
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function run(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\\t' || ch === '\\n') { i++; continue; }
    if (isDigit(ch)) {
      let start = i;
      while (i < input.length && isDigit(input[i])) i++;
      tokens.push(['num', Number(input.slice(start, i))]);
    } else if (isAlpha(ch)) {
      let start = i;
      while (i < input.length && (isAlpha(input[i]) || isDigit(input[i]))) i++;
      tokens.push(['id', input.slice(start, i)]);
    } else {
      tokens.push(['op', ch]);
      i++;
    }
  }
  return {count: tokens.length, tokens};
}`,
      inputs: [
        [''],
        ['42'],
        ['x = 12 + y'],
        ['sum_1 = (a + 23) * b0 - 7'],
        ['if (count >= 10) total = total + step_2'],
        ['let alpha = 100 + beta_2 * (gamma - 15) / delta_9'],
      ],
      features: ['string', 'loop', 'branch', 'array', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'csv-kv-parser',
      source: `function splitLines(text) {
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\n') { if (cur.trim().length > 0) out.push(cur); cur = ''; }
    else cur += text[i];
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}
function parseLine(line) {
  const fields = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { fields.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}
function run(text) {
  const lines = splitLines(text);
  if (!lines.length) return [];
  const header = parseLine(lines[0]);
  const rows = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = parseLine(lines[r]);
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = c < cols.length ? cols[c] : '';
    rows.push(obj);
  }
  return rows;
}`,
      inputs: [
        [''],
        ['a,b\n1,2'],
        ['name,city\nAda,"London, UK"\nGrace,NYC'],
        ['k,v,tag\nalpha,10,core\nbeta,"20,30",edge\ngamma,40'],
        ['id,label,note\n1,init,"start, ok"\n2,run,fast\n3,done,"end, clean"\n4,check,pass'],
        ['col1,col2,col3,col4\na1,b1,"c1,x",d1\na2,b2,c2,d2\na3,"b3,y",c3,d3\na4,b4,c4,"d4,z"'],
      ],
      features: ['string', 'loop', 'branch', 'array', 'object', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'matrix-multiply-summary',
      source: `function matMul(A, B) {
  const rows = A.length, inner = B.length, cols = inner ? B[0].length : 0;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const row = [];
    for (let j = 0; j < cols; j++) {
      let sum = 0;
      for (let k = 0; k < inner; k++) sum += A[i][k] * B[k][j];
      row.push(sum);
    }
    out.push(row);
  }
  return out;
}
function run(A, B) {
  const product = matMul(A, B);
  let trace = 0;
  const rowSums = [];
  for (let i = 0; i < product.length; i++) {
    let rs = 0;
    for (let j = 0; j < product[i].length; j++) {
      rs += product[i][j];
      if (i === j) trace += product[i][j];
    }
    rowSums.push(rs);
  }
  return {product, trace, rowSums};
}`,
      inputs: [
        [[[1]], [[2]]],
        [[[1, 2], [3, 4]], [[2, 0], [1, 2]]],
        [[[2, -1], [0, 3]], [[4, 1], [-2, 5]]],
        [[[1, 0, 2], [-1, 3, 1]], [[3, 1], [2, 1], [1, 0]]],
        [[[1, 2, 3], [4, 5, 6], [7, 8, 9]], [[1, 0, 1], [0, 1, 0], [1, 0, 1]]],
        [[[2, 1, -1, 3], [0, 4, 2, -1], [3, -2, 1, 0]], [[1, 2, 0], [-1, 0, 3], [2, 1, 1], [0, -1, 2]]],
      ],
      features: ['loop', 'array', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'lcs-dp-table',
      source: `function makeGrid(rows, cols) {
  const grid = [];
  for (let i = 0; i <= rows; i++) {
    const r = [];
    for (let j = 0; j <= cols; j++) r.push(0);
    grid.push(r);
  }
  return grid;
}
function run(a, b) {
  const dp = makeGrid(a.length, b.length);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  let seq = '', i = a.length, j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { seq = a[i - 1] + seq; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return {length: dp[a.length][b.length], seq};
}`,
      inputs: [
        ['', 'abc'],
        ['abc', 'def'],
        ['abcde', 'ace'],
        ['abcbdab', 'bdcaba'],
        ['aggtab', 'gxtxayb'],
        ['abcdefg', 'xabydzfeg'],
      ],
      features: ['string', 'loop', 'branch', 'array', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'knapsack-dp-selector',
      source: `function run(items, capacity) {
  const n = items.length;
  const dp = [];
  for (let i = 0; i <= n; i++) {
    const row = [];
    for (let w = 0; w <= capacity; w++) row.push(0);
    dp.push(row);
  }
  for (let i = 1; i <= n; i++) {
    const wt = items[i - 1].w, val = items[i - 1].v;
    for (let w = 0; w <= capacity; w++) {
      let best = dp[i - 1][w];
      if (wt <= w && dp[i - 1][w - wt] + val > best) best = dp[i - 1][w - wt] + val;
      dp[i][w] = best;
    }
  }
  const chosen = [];
  let rem = capacity;
  for (let i = n; i >= 1; i--) {
    if (dp[i][rem] !== dp[i - 1][rem]) {
      chosen.push(items[i - 1].name);
      rem -= items[i - 1].w;
    }
  }
  chosen.reverse();
  return {maxValue: dp[n][capacity], chosen};
}`,
      inputs: [
        [[], 5],
        [[{name: 'a', w: 2, v: 6}], 1],
        [[{name: 'a', w: 2, v: 6}, {name: 'b', w: 3, v: 8}, {name: 'c', w: 4, v: 10}], 5],
        [[{name: 'x', w: 1, v: 4}, {name: 'y', w: 3, v: 9}, {name: 'z', w: 2, v: 7}, {name: 'w', w: 4, v: 11}], 6],
        [[{name: 'i1', w: 2, v: 5}, {name: 'i2', w: 3, v: 7}, {name: 'i3', w: 1, v: 4}, {name: 'i4', w: 4, v: 12}, {name: 'i5', w: 2, v: 6}], 7],
        [[{name: 'p', w: 3, v: 8}, {name: 'q', w: 2, v: 6}, {name: 'r', w: 4, v: 13}, {name: 's', w: 1, v: 3}, {name: 't', w: 5, v: 15}, {name: 'u', w: 2, v: 7}], 8],
      ],
      features: ['loop', 'branch', 'array', 'object', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'min-heap-scheduler',
      source: `function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = Math.floor((i - 1) / 2);
    if (h[p][0] < h[i][0] || (h[p][0] === h[i][0] && h[p][1] <= h[i][1])) break;
    const tmp = h[p]; h[p] = h[i]; h[i] = tmp;
    i = p;
  }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    while (true) {
      let best = i, l = 2 * i + 1, r = 2 * i + 2;
      if (l < h.length && (h[l][0] < h[best][0] || (h[l][0] === h[best][0] && h[l][1] < h[best][1]))) best = l;
      if (r < h.length && (h[r][0] < h[best][0] || (h[r][0] === h[best][0] && h[r][1] < h[best][1]))) best = r;
      if (best === i) break;
      const tmp = h[i]; h[i] = h[best]; h[best] = tmp;
      i = best;
    }
  }
  return top;
}
function run(jobs) {
  const heap = [];
  for (let i = 0; i < jobs.length; i++) heapPush(heap, jobs[i]);
  const order = [];
  let waitSum = 0, clock = 0;
  while (heap.length) {
    const job = heapPop(heap);
    waitSum += clock;
    clock += job[2];
    order.push(job[1]);
  }
  return {order, totalTime: clock, waitSum};
}`,
      inputs: [
        [[]],
        [[[1, 'a', 3]]],
        [[[3, 'c', 2], [1, 'a', 4], [2, 'b', 1]]],
        [[[2, 'b', 3], [2, 'a', 2], [1, 'c', 5], [4, 'd', 1], [1, 'e', 2]]],
        [[[5, 'j5', 2], [1, 'j1', 4], [3, 'j3', 1], [2, 'j2', 3], [3, 'j0', 2], [0, 'j9', 1]]],
        [[[4, 'd', 2], [2, 'b', 3], [6, 'f', 1], [1, 'a', 5], [3, 'c', 2], [2, 'e', 4], [5, 'g', 1], [0, 'z', 2]]],
      ],
      features: ['loop', 'branch', 'array', 'mutation', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'trie-prefix-index',
      source: `function insertWord(root, word) {
  let node = root;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (!(ch in node.next)) node.next[ch] = {count: 0, end: 0, next: Object.create(null)};
    node = node.next[ch];
    node.count++;
  }
  node.end++;
}
function queryPrefix(root, prefix) {
  let node = root;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (!(ch in node.next)) return {matches: 0, exact: 0};
    node = node.next[ch];
  }
  return {matches: node.count, exact: node.end};
}
function run(words, prefixes) {
  const root = {count: 0, end: 0, next: Object.create(null)};
  for (let i = 0; i < words.length; i++) insertWord(root, words[i]);
  const out = [];
  for (let i = 0; i < prefixes.length; i++) out.push(queryPrefix(root, prefixes[i]));
  return out;
}`,
      inputs: [
        [[], ['a']],
        [['cat', 'car', 'dog'], ['ca', 'cat', 'z']],
        [['app', 'apple', 'ape', 'bat', 'ball'], ['ap', 'app', 'ba', 'bad']],
        [['run', 'runner', 'running', 'rust', 'ruby', 'run'], ['ru', 'run', 'rus', 'x']],
        [['code', 'coder', 'coding', 'core', 'corn', 'cat', 'cap'], ['co', 'cod', 'cor', 'ca', 'code']],
        [['trace', 'track', 'trade', 'train', 'tree', 'trim', 'trip', 'true'], ['tr', 'tra', 'tri', 'tre', 'trace', 'z']],
      ],
      features: ['string', 'loop', 'branch', 'object', 'null-prototype', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'semver-filter-sort',
      source: `function parseVer(s) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '.') { parts.push(Number(cur)); cur = ''; }
    else cur += s[i];
  }
  parts.push(Number(cur));
  return parts;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function run(versions, minVer) {
  const floor = parseVer(minVer);
  const kept = [];
  for (let i = 0; i < versions.length; i++) {
    const parsed = parseVer(versions[i]);
    if (cmpVer(parsed, floor) >= 0) kept.push({raw: versions[i], parsed});
  }
  for (let i = 1; i < kept.length; i++) {
    const cur = kept[i];
    let j = i - 1;
    while (j >= 0 && cmpVer(kept[j].parsed, cur.parsed) > 0) { kept[j + 1] = kept[j]; j--; }
    kept[j + 1] = cur;
  }
  return kept.map(item => item.raw);
}`,
      inputs: [
        [[], '1.0.0'],
        [['0.9.1', '1.0.0', '1.2.0'], '1.0.0'],
        [['2.1.0', '1.10.2', '1.2.9', '0.8.0', '1.2.10'], '1.2.0'],
        [['3.0.0', '2.4.1', '2.4.0', '2.10.0', '1.9.9', '2.0.5'], '2.0.0'],
        [['1.0.2', '1.0.10', '1.0.1', '2.0.0', '1.1.0', '0.5.0', '1.0.2'], '1.0.2'],
        [['4.1.0', '3.12.1', '3.2.9', '3.2.10', '2.9.9', '3.0.0', '3.12.0', '4.0.1'], '3.0.0'],
      ],
      features: ['string', 'loop', 'branch', 'array', 'object', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'ledger-reconciler',
      source: `function applyTransfer(balances, tx) {
  const from = tx.from, to = tx.to, amt = tx.amount;
  if (amt <= 0) return 'invalid';
  const src = balances[from] ?? 0;
  if (from !== 'MINT' && src < amt) return 'overdraft';
  if (from !== 'MINT') balances[from] = src - amt;
  balances[to] = (balances[to] ?? 0) + amt;
  return 'ok';
}
function run(initial, txs) {
  const balances = {};
  const initKeys = Object.keys(initial);
  for (let i = 0; i < initKeys.length; i++) balances[initKeys[i]] = initial[initKeys[i]];
  let applied = 0, rejected = 0;
  const log = [];
  for (let i = 0; i < txs.length; i++) {
    const status = applyTransfer(balances, txs[i]);
    if (status === 'ok') applied++;
    else rejected++;
    log.push(status);
  }
  let total = 0;
  const keys = Object.keys(balances);
  for (let i = 0; i < keys.length; i++) total += balances[keys[i]];
  return {balances, applied, rejected, total, log};
}`,
      inputs: [
        [{a: 10}, []],
        [{a: 10, b: 5}, [{from: 'a', to: 'b', amount: 4}]],
        [{a: 10, b: 0}, [{from: 'a', to: 'b', amount: 15}, {from: 'a', to: 'b', amount: 6}]],
        [{a: 20, b: 5}, [{from: 'MINT', to: 'a', amount: 10}, {from: 'a', to: 'c', amount: 25}, {from: 'c', to: 'b', amount: 10}, {from: 'b', to: 'a', amount: 0}]],
        [{alice: 50, bob: 20, carol: 10}, [{from: 'alice', to: 'bob', amount: 30}, {from: 'bob', to: 'carol', amount: 45}, {from: 'carol', to: 'alice', amount: 60}, {from: 'MINT', to: 'carol', amount: 25}, {from: 'carol', to: 'alice', amount: 60}]],
        [{u1: 100, u2: 40, u3: 10}, [{from: 'u1', to: 'u2', amount: 25}, {from: 'u2', to: 'u3', amount: 50}, {from: 'u3', to: 'u1', amount: 70}, {from: 'u3', to: 'u1', amount: 40}, {from: 'MINT', to: 'u2', amount: 30}, {from: 'u2', to: 'u4', amount: 45}, {from: 'u4', to: 'u1', amount: -5}]],
      ],
      features: ['loop', 'branch', 'object', 'mutation', 'nullish', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'sliding-window-limiter',
      source: `function prune(window, now, span) {
  while (window.length && window[0] <= now - span) window.shift();
}
function run(limit, span, timestamps) {
  const window = [];
  let allowed = 0, blocked = 0;
  const decisions = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    prune(window, t, span);
    if (window.length < limit) {
      window.push(t);
      allowed++;
      decisions.push(1);
    } else {
      blocked++;
      decisions.push(0);
    }
  }
  return {allowed, blocked, remaining: window.length, decisions};
}`,
      inputs: [
        [2, 10, []],
        [2, 10, [1, 2, 3]],
        [2, 10, [1, 5, 8, 11, 12, 15]],
        [3, 5, [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 11, 12]],
        [2, 4, [1, 1, 2, 3, 5, 5, 6, 9, 10, 11, 12, 13]],
        [3, 6, [0, 1, 1, 2, 3, 6, 7, 7, 8, 9, 12, 13, 14, 15, 16]],
      ],
      features: ['loop', 'branch', 'array', 'mutation', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    {
      name: 'histogram-top-k',
      source: `function countItems(items) {
  const counts = Object.create(null);
  for (let i = 0; i < items.length; i++) {
    const key = items[i];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
function run(items, k) {
  const counts = countItems(items);
  const pairs = [];
  const keys = Object.keys(counts);
  for (let i = 0; i < keys.length; i++) pairs.push([keys[i], counts[keys[i]]]);
  for (let i = 1; i < pairs.length; i++) {
    const cur = pairs[i];
    let j = i - 1;
    while (j >= 0 && (pairs[j][1] < cur[1] || (pairs[j][1] === cur[1] && pairs[j][0] > cur[0]))) {
      pairs[j + 1] = pairs[j];
      j--;
    }
    pairs[j + 1] = cur;
  }
  return {unique: pairs.length, top: pairs.slice(0, k)};
}`,
      inputs: [
        [[], 2],
        [['a', 'b', 'a'], 1],
        [['b', 'a', 'c', 'a', 'b', 'd'], 2],
        [['red', 'blue', 'red', 'green', 'blue', 'blue', 'yellow', 'red'], 3],
        [['x', 'y', 'z', 'x', 'y', 'x', 'w', 'z', 'z', 'a', 'b', 'z'], 3],
        [['k2', 'k1', 'k3', 'k2', 'k4', 'k1', 'k2', 'k5', 'k3', 'k1', 'k3', 'k3', 'k4', 'k4'], 4],
      ],
      features: ['loop', 'branch', 'array', 'object', 'null-prototype', 'nullish', 'multi-function', 'longer-execution'],
      tier: 4,
    },
    // --- Multi-turn effectful workflows (Tier 5) ---
    {
      name: 'retry-with-fallback-workflow',
      source: `async function run(key, maxAttempts) {
  const errors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await host.readAsync(key + '#' + attempt);
      host.store('resolved', {attempt, value});
      return {ok: true, attempt, value, errors};
    } catch (err) {
      errors.push(err);
    }
  }
  host.store('failed', {key, attempts: errors.length});
  return {ok: false, attempt: maxAttempts, value: null, errors};
}`,
      inputs: [['job', 2], ['job', 3], ['cfg', 3], ['cfg', 2], ['item', 4], ['item', 3]],
      features: ['external', 'sequential', 'loop', 'exception', 'branch', 'longer-execution'],
      tier: 5,
      fixture: i => {
        const patterns = [
          [{operation: 'demo.readAsync', arguments: ['job#1'], result: 42}, {operation: 'demo.store', arguments: ['resolved', {attempt: 1, value: 42}]}],
          [{operation: 'demo.readAsync', arguments: ['job#1'], status: 'rejected', result: 'timeout'}, {operation: 'demo.readAsync', arguments: ['job#2'], result: 99}, {operation: 'demo.store', arguments: ['resolved', {attempt: 2, value: 99}]}],
          [{operation: 'demo.readAsync', arguments: ['cfg#1'], status: 'rejected', result: 'e1'}, {operation: 'demo.readAsync', arguments: ['cfg#2'], status: 'rejected', result: 'e2'}, {operation: 'demo.readAsync', arguments: ['cfg#3'], result: 'ready'}, {operation: 'demo.store', arguments: ['resolved', {attempt: 3, value: 'ready'}]}],
          [{operation: 'demo.readAsync', arguments: ['cfg#1'], status: 'rejected', result: 'down'}, {operation: 'demo.readAsync', arguments: ['cfg#2'], status: 'rejected', result: 'down'}, {operation: 'demo.store', arguments: ['failed', {key: 'cfg', attempts: 2}]}],
          [{operation: 'demo.readAsync', arguments: ['item#1'], status: 'rejected', result: 'busy'}, {operation: 'demo.readAsync', arguments: ['item#2'], status: 'rejected', result: 'busy'}, {operation: 'demo.readAsync', arguments: ['item#3'], status: 'rejected', result: 'stale'}, {operation: 'demo.readAsync', arguments: ['item#4'], result: 7}, {operation: 'demo.store', arguments: ['resolved', {attempt: 4, value: 7}]}],
          [{operation: 'demo.readAsync', arguments: ['item#1'], status: 'rejected', result: 'errA'}, {operation: 'demo.readAsync', arguments: ['item#2'], status: 'rejected', result: 'errB'}, {operation: 'demo.readAsync', arguments: ['item#3'], status: 'rejected', result: 'errC'}, {operation: 'demo.store', arguments: ['failed', {key: 'item', attempts: 3}]}],
        ];
        return {calls: patterns[i % patterns.length]};
      },
    },
    {
      name: 'paginated-cursor-aggregator',
      source: `function parsePage(raw) {
  let sep = raw.indexOf('|');
  const listStr = sep === -1 ? raw : raw.slice(0, sep);
  const next = sep === -1 ? '' : raw.slice(sep + 1);
  const items = [];
  let cur = '';
  for (let i = 0; i < listStr.length; i++) {
    if (listStr[i] === ',') { if (cur.length) items.push(Number(cur)); cur = ''; }
    else cur += listStr[i];
  }
  if (cur.length) items.push(Number(cur));
  return {items, next};
}
async function run(startCursor, threshold) {
  let cursor = startCursor, pages = 0, total = 0;
  const kept = [];
  while (cursor.length > 0) {
    const raw = await host.readAsync('page:' + cursor);
    const page = parsePage(raw);
    pages++;
    for (let i = 0; i < page.items.length; i++) {
      const val = page.items[i];
      if (val > 0 && val >= threshold) { kept.push(val); total += val; }
    }
    cursor = page.next;
  }
  host.store('summary', {pages, count: kept.length, total});
  return {pages, kept, total};
}`,
      inputs: [['p0', 1], ['p0', 5], ['c1', 2], ['c1', 10], ['s0', 3], ['s0', 0]],
      features: ['external', 'sequential', 'loop', 'branch', 'array', 'string', 'multi-function', 'longer-execution'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'demo.readAsync', arguments: ['page:p0'], result: '2,-1,4|'}, {operation: 'demo.store', arguments: ['summary', {pages: 1, count: 2, total: 6}]}],
          [{operation: 'demo.readAsync', arguments: ['page:p0'], result: '3,6|p1'}, {operation: 'demo.readAsync', arguments: ['page:p1'], result: '5,1,9|'}, {operation: 'demo.store', arguments: ['summary', {pages: 2, count: 3, total: 20}]}],
          [{operation: 'demo.readAsync', arguments: ['page:c1'], result: '-3,2,7|c2'}, {operation: 'demo.readAsync', arguments: ['page:c2'], result: '1,4|c3'}, {operation: 'demo.readAsync', arguments: ['page:c3'], result: '8|'}, {operation: 'demo.store', arguments: ['summary', {pages: 3, count: 4, total: 21}]}],
          [{operation: 'demo.readAsync', arguments: ['page:c1'], result: '2,5|c2'}, {operation: 'demo.readAsync', arguments: ['page:c2'], result: '9,12|'}, {operation: 'demo.store', arguments: ['summary', {pages: 2, count: 1, total: 12}]}],
          [{operation: 'demo.readAsync', arguments: ['page:s0'], result: '4,2|s1'}, {operation: 'demo.readAsync', arguments: ['page:s1'], result: '-5,3,6|s2'}, {operation: 'demo.readAsync', arguments: ['page:s2'], result: '1,8,3|'}, {operation: 'demo.store', arguments: ['summary', {pages: 3, count: 5, total: 24}]}],
          [{operation: 'demo.readAsync', arguments: ['page:s0'], result: '-1,0|s1'}, {operation: 'demo.readAsync', arguments: ['page:s1'], result: '7,-2,3|s2'}, {operation: 'demo.readAsync', arguments: ['page:s2'], result: '5|s3'}, {operation: 'demo.readAsync', arguments: ['page:s3'], result: '2,4|'}, {operation: 'demo.store', arguments: ['summary', {pages: 4, count: 5, total: 21}]}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'transaction-rollback-pipeline',
      source: `async function run(steps) {
  const applied = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      const name = steps[i];
      const delta = await host.readAsync('step:' + name);
      host.store('apply:' + name, delta);
      applied.push({name, delta});
    }
    return {committed: true, count: applied.length, applied};
  } catch (err) {
    for (let i = applied.length - 1; i >= 0; i--) {
      host.store('rollback:' + applied[i].name, -applied[i].delta);
    }
    return {committed: false, error: err, rolledBack: applied.length};
  }
}`,
      inputs: [
        [['a']],
        [['a', 'b']],
        [['a', 'b', 'c']],
        [['s1', 's2', 's3']],
        [['x', 'y', 'z', 'w']],
        [['k1', 'k2', 'k3']],
      ],
      features: ['external', 'sequential', 'loop', 'exception', 'branch', 'longer-execution'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'demo.readAsync', arguments: ['step:a'], result: 5}, {operation: 'demo.store', arguments: ['apply:a', 5]}],
          [{operation: 'demo.readAsync', arguments: ['step:a'], result: 3}, {operation: 'demo.store', arguments: ['apply:a', 3]}, {operation: 'demo.readAsync', arguments: ['step:b'], status: 'rejected', result: 'conflict'}, {operation: 'demo.store', arguments: ['rollback:a', -3]}],
          [{operation: 'demo.readAsync', arguments: ['step:a'], result: 2}, {operation: 'demo.store', arguments: ['apply:a', 2]}, {operation: 'demo.readAsync', arguments: ['step:b'], result: 7}, {operation: 'demo.store', arguments: ['apply:b', 7]}, {operation: 'demo.readAsync', arguments: ['step:c'], status: 'rejected', result: 'denied'}, {operation: 'demo.store', arguments: ['rollback:b', -7]}, {operation: 'demo.store', arguments: ['rollback:a', -2]}],
          [{operation: 'demo.readAsync', arguments: ['step:s1'], result: 1}, {operation: 'demo.store', arguments: ['apply:s1', 1]}, {operation: 'demo.readAsync', arguments: ['step:s2'], result: 4}, {operation: 'demo.store', arguments: ['apply:s2', 4]}, {operation: 'demo.readAsync', arguments: ['step:s3'], result: 9}, {operation: 'demo.store', arguments: ['apply:s3', 9]}],
          [{operation: 'demo.readAsync', arguments: ['step:x'], result: 10}, {operation: 'demo.store', arguments: ['apply:x', 10]}, {operation: 'demo.readAsync', arguments: ['step:y'], result: 20}, {operation: 'demo.store', arguments: ['apply:y', 20]}, {operation: 'demo.readAsync', arguments: ['step:z'], result: 30}, {operation: 'demo.store', arguments: ['apply:z', 30]}, {operation: 'demo.readAsync', arguments: ['step:w'], status: 'rejected', result: 'disk-full'}, {operation: 'demo.store', arguments: ['rollback:z', -30]}, {operation: 'demo.store', arguments: ['rollback:y', -20]}, {operation: 'demo.store', arguments: ['rollback:x', -10]}],
          [{operation: 'demo.readAsync', arguments: ['step:k1'], status: 'rejected', result: 'bad-first'}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'cache-aside-batch-loader',
      source: `function computeValue(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = hash * 31 + key.charCodeAt(i);
  return hash % 997;
}
async function run(keys) {
  const out = {};
  let hits = 0, misses = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const cached = await host.readAsync('cache:' + k);
    if (cached !== null) {
      out[k] = cached;
      hits++;
    } else {
      const val = computeValue(k);
      host.store('cache:' + k, val);
      out[k] = val;
      misses++;
    }
  }
  return {out, hits, misses};
}`,
      inputs: [
        [['a']],
        [['a', 'b']],
        [['ab', 'cd', 'ef']],
        [['x1', 'y2', 'z3']],
        [['foo', 'bar', 'baz', 'qux']],
        [['k1', 'k2', 'k3', 'k4']],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'string', 'object', 'multi-function', 'longer-execution'],
      tier: 5,
      fixture: i => {
        const hashOf = key => { let h = 0; for (let j = 0; j < key.length; j++) h = h * 31 + key.charCodeAt(j); return h % 997; };
        const plans = [
          [['a', 11]],
          [['a', null], ['b', 22]],
          [['ab', 5], ['cd', null], ['ef', null]],
          [['x1', null], ['y2', 77], ['z3', null]],
          [['foo', 1], ['bar', null], ['baz', 2], ['qux', null]],
          [['k1', null], ['k2', null], ['k3', 88], ['k4', 99]],
        ][i % 6];
        const calls = [];
        for (const [k, cached] of plans) {
          calls.push({operation: 'demo.readAsync', arguments: ['cache:' + k], result: cached});
          if (cached === null) calls.push({operation: 'demo.store', arguments: ['cache:' + k, hashOf(k)]});
        }
        return {calls};
      },
    },
    {
      name: 'quorum-vote-collector',
      source: `async function run(replicas, quorum) {
  const tallies = Object.create(null);
  let failures = 0, leader = null, best = 0;
  for (let i = 0; i < replicas.length; i++) {
    try {
      const vote = await host.readAsync('replica:' + replicas[i]);
      const count = (tallies[vote] ?? 0) + 1;
      tallies[vote] = count;
      if (count > best) { best = count; leader = vote; }
      if (best >= quorum) {
        host.store('consensus', {leader, votes: best, checked: i + 1});
        return {reached: true, leader, votes: best, failures};
      }
    } catch (err) {
      failures++;
    }
  }
  host.store('no-quorum', {best, failures});
  return {reached: false, leader, votes: best, failures};
}`,
      inputs: [
        [['r1', 'r2', 'r3'], 2],
        [['r1', 'r2', 'r3'], 2],
        [['n1', 'n2', 'n3', 'n4'], 3],
        [['n1', 'n2', 'n3', 'n4'], 2],
        [['a', 'b', 'c', 'd', 'e'], 3],
        [['a', 'b', 'c', 'd'], 3],
      ],
      features: ['external', 'sequential', 'loop', 'branch', 'exception', 'null-prototype', 'nullish', 'longer-execution'],
      tier: 5,
      fixture: i => {
        const cases = [
          [{operation: 'demo.readAsync', arguments: ['replica:r1'], result: 'v1'}, {operation: 'demo.readAsync', arguments: ['replica:r2'], result: 'v1'}, {operation: 'demo.store', arguments: ['consensus', {leader: 'v1', votes: 2, checked: 2}]}],
          [{operation: 'demo.readAsync', arguments: ['replica:r1'], result: 'v1'}, {operation: 'demo.readAsync', arguments: ['replica:r2'], status: 'rejected', result: 'down'}, {operation: 'demo.readAsync', arguments: ['replica:r3'], result: 'v1'}, {operation: 'demo.store', arguments: ['consensus', {leader: 'v1', votes: 2, checked: 3}]}],
          [{operation: 'demo.readAsync', arguments: ['replica:n1'], result: 'x'}, {operation: 'demo.readAsync', arguments: ['replica:n2'], result: 'y'}, {operation: 'demo.readAsync', arguments: ['replica:n3'], result: 'x'}, {operation: 'demo.readAsync', arguments: ['replica:n4'], result: 'x'}, {operation: 'demo.store', arguments: ['consensus', {leader: 'x', votes: 3, checked: 4}]}],
          [{operation: 'demo.readAsync', arguments: ['replica:n1'], status: 'rejected', result: 'e1'}, {operation: 'demo.readAsync', arguments: ['replica:n2'], result: 'a'}, {operation: 'demo.readAsync', arguments: ['replica:n3'], result: 'b'}, {operation: 'demo.readAsync', arguments: ['replica:n4'], status: 'rejected', result: 'e2'}, {operation: 'demo.store', arguments: ['no-quorum', {best: 1, failures: 2}]}],
          [{operation: 'demo.readAsync', arguments: ['replica:a'], result: 'ok'}, {operation: 'demo.readAsync', arguments: ['replica:b'], status: 'rejected', result: 'net'}, {operation: 'demo.readAsync', arguments: ['replica:c'], result: 'ok'}, {operation: 'demo.readAsync', arguments: ['replica:d'], result: 'no'}, {operation: 'demo.readAsync', arguments: ['replica:e'], result: 'ok'}, {operation: 'demo.store', arguments: ['consensus', {leader: 'ok', votes: 3, checked: 5}]}],
          [{operation: 'demo.readAsync', arguments: ['replica:a'], result: 'v1'}, {operation: 'demo.readAsync', arguments: ['replica:b'], result: 'v2'}, {operation: 'demo.readAsync', arguments: ['replica:c'], result: 'v1'}, {operation: 'demo.readAsync', arguments: ['replica:d'], result: 'v2'}, {operation: 'demo.store', arguments: ['no-quorum', {best: 2, failures: 0}]}],
        ];
        return {calls: cases[i % cases.length]};
      },
    },
    {
      name: 'stream-chunk-checksum',
      source: `function foldChunk(acc, text) {
  for (let i = 0; i < text.length; i++) acc = (acc * 17 + text.charCodeAt(i)) % 65521;
  return acc;
}
async function run(streamName) {
  let seq = 0, checksum = 1, bytes = 0;
  while (true) {
    const chunk = await host.readAsync(streamName + ':' + seq);
    if (chunk === null) break;
    checksum = foldChunk(checksum, chunk);
    bytes += chunk.length;
    seq++;
  }
  host.store('checksum:' + streamName, {chunks: seq, bytes, checksum});
  return {chunks: seq, bytes, checksum};
}`,
      inputs: [['s0'], ['s1'], ['s2'], ['s3'], ['s4'], ['s5']],
      features: ['external', 'sequential', 'loop', 'branch', 'string', 'multi-function', 'longer-execution'],
      tier: 5,
      fixture: i => {
        const fold = (acc, t) => { for (let j = 0; j < t.length; j++) acc = (acc * 17 + t.charCodeAt(j)) % 65521; return acc; };
        const streams = [
          [],
          ['hi'],
          ['ab', 'cd'],
          ['hello', ' ', 'world'],
          ['chunk1', 'chunk2', 'chunk3'],
          ['alpha', 'beta', 'gamma', 'delta'],
        ][i % 6];
        const name = 's' + (i % 6);
        const calls = [];
        let acc = 1, bytes = 0;
        for (let seq = 0; seq < streams.length; seq++) {
          calls.push({operation: 'demo.readAsync', arguments: [name + ':' + seq], result: streams[seq]});
          acc = fold(acc, streams[seq]);
          bytes += streams[seq].length;
        }
        calls.push({operation: 'demo.readAsync', arguments: [name + ':' + streams.length], result: null});
        calls.push({operation: 'demo.store', arguments: ['checksum:' + name, {chunks: streams.length, bytes, checksum: acc}]});
        return {calls};
      },
    },
  ];
}

function expandLongTemplate(template, seed) {
  const rows = [];
  for (let i = 0; i < template.inputs.length; i++) {
    const fixture = template.fixture?.(i) ?? {calls: []};
    const args = structuredClone(template.inputs[i]);
    rows.push(decorate({source: template.source, entry: 'run', args, fixture}, {
      template, index: i, form: 'direct', sourceOrigin: 'authored-long-program', seed,
    }));
  }
  return rows;
}

export function generatedCandidates({seed = 17} = {}) {
  seededRandom(seed);
  const templates = [
    ...SEMANTIC_TASK_TEMPLATES.map(item=>({name:'expression-'+item.name,source:'function run(a,b){return '+item.expression+';}',inputs:[[8,3],[5,2]],features:['arithmetic'],tier:1})),
    ...BENCHMARK_ALGORITHMS.map(item=>({name:'algorithm-'+item.name,source:'function run(a,b){'+item.body+'}',inputs:item.inputs,features:['algorithm'],tier:2})),
    ...boundaryTemplates(),
  ];
  return [
    ...templates.flatMap(template=>expandTemplate(template,seed)),
    ...longProgramTemplates().flatMap(template=>expandLongTemplate(template,seed)),
  ];
}

function portableCandidate(raw, index, seed) {
  let args,preflightFailure=raw.preflightFailure;
  try{args=encodeReadable([...(raw.args??[])]);}catch(error){args=[];preflightFailure={status:'fixture_unsupported',reason:String(error.message)};}
  const metadata = {features: featureTags(raw.source ?? '', [raw.provenance?'real-source':'repository-fixture']), tier: 3, template: raw.family,
    lineage: [raw.family,...(raw.ancestorIds??[])], sourceOrigin: raw.provenance?.sourceStream ?? 'repository-fixture',
    inputVariant: raw.provenance?.inputIndex ?? index, evaluationRole:'generalization', agentTaskSuccessVerified:false,
    provenance: raw.provenance ? {upstream:raw.provenance.upstream,sourceURL:raw.provenance.sourceURL,
      license:raw.provenance.license,noticePath:raw.provenance.noticePath,transform:raw.provenance.transform,
      originalSourceSha256:raw.provenance.originalSourceSha256,transformedSourceSha256:raw.provenance.transformedSourceSha256,
      inputOrigin:raw.provenance.inputOrigin,sourceStream:raw.provenance.sourceStream} : null};
  try { metadata.lineage.push('near-clone:'+nearCloneHash(raw.source)); } catch {}
  return {id:raw.id,family:raw.family,source:raw.source,entry:raw.entry??'run',args,
    fixture:raw.fixture??{calls:[]},randomSeed:raw.seeds?.guestRng??seed,
    maxSteps:raw.maxSteps??100000,timeoutMs:raw.timeoutMs??10000,
    ...(preflightFailure?{preflightFailure}:{}), metadata};
}

export function repositoryCandidates({root=process.cwd(),seed=17,perFamily=4,streams=['utilities','exercism','production']}={}) {
  // Exclude programs calling internal Math.random() from the LLM execution
  // benchmark: expecting a language model to mentally compute 32-bit LCG math
  // tests an artificial PRNG formula rather than JS execution semantics.
  return trustedRealSourceCases({root,streams,perFamily,mutationsPerFamily:0})
    .filter(row=>!/\bMath\.random\b/.test(row.source??''))
    .map((row,i)=>portableCandidate(row,i,seed));
}

export function censusCandidates(options={}) {
  const seed=options.seed??17;
  const existing=[...EFFECTFUL_ENGINEERING_FIXTURES,
    ...semanticRecipeFamilies().flatMap(f=>[f.pure,f.callbacks,...f.repeated.cases]),
    ...benchmarkFamiliesV1().flatMap(f=>[f.pure,f.callbacks,...f.repeated.cases])];
  return [...repositoryCandidates({...options,perFamily:options.perFamily??2}),
    ...existing.map((row,i)=>portableCandidate({...row,id:'existing-'+row.id},i,seed))];
}

export function assignFrozenSplits(rows,{seed=17,validationFraction=0.2,testFraction=0.3}={}) {
  if (!(validationFraction>0&&testFraction>0&&validationFraction+testFraction<1)) throw TypeError('Invalid benchmark split fractions');
  const parent=new Map(),find=x=>{if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,find(parent.get(x)));return parent.get(x);};
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a<b?b:a,a<b?a:b);};
  for(const row of rows){const ids=[row.family,...(row.metadata.lineage??[]),'template:'+row.metadata.template];
    try{ids.push('exact-source:'+normalizedSourceHash(row.source));}catch{}
    ids.forEach(id=>union(ids[0],id));}
  const groups=new Map();for(const row of rows){const component=find(row.family);if(!groups.has(component))groups.set(component,[]);groups.get(component).push(row);}
  // Stratify independent components by primary sourceOrigin so train,
  // validation, and test each receive balanced real-world vs synthetic ratios
  // while keeping every connected family/lineage component 100% isolated.
  const strata=new Map();
  for(const [component,members] of groups){
    const origins=[...new Set(members.map(r=>r.metadata?.sourceOrigin??'default'))].sort();
    const stratum=origins[0];
    if(!strata.has(stratum))strata.set(stratum,[]);
    strata.get(stratum).push(component);
  }
  const splits=new Map(),remainder=[];
  for(const [stratum,components] of [...strata.entries()].sort(([a],[b])=>a.localeCompare(b))){
    if(components.length<3){remainder.push(...components);continue;}
    const ordered=[...components].sort((a,b)=>sha256(seed+':'+stratum+':'+a).localeCompare(sha256(seed+':'+stratum+':'+b)));
    const nt=Math.max(1,Math.round(ordered.length*testFraction)),nv=Math.max(1,Math.round(ordered.length*validationFraction));
    ordered.forEach((component,i)=>splits.set(component,i<nt?'test':i<nt+nv?'validation':'train'));
  }
  if(remainder.length){
    const ordered=[...remainder].sort((a,b)=>sha256(seed+':'+a).localeCompare(sha256(seed+':'+b)));
    const nt=ordered.length>=3?Math.max(1,Math.round(ordered.length*testFraction)):0;
    const nv=ordered.length>=3?Math.max(1,Math.round(ordered.length*validationFraction)):0;
    ordered.forEach((component,i)=>splits.set(component,i<nt?'test':i<nt+nv?'validation':'train'));
  }
  const allSplits=new Set(splits.values());
  if(groups.size<3||allSplits.size<3)throw Error('At least three independent family components required');
  return rows.map(row=>({...row,split:splits.get(find(row.family)),metadata:{...row.metadata,
    component:find(row.family),lineage:[...new Set([...row.metadata.lineage,'component:'+find(row.family)])]}}));
}

export function datasetCounts(rows) {
  const count=list=>({cases:list.length,families:new Set(list.map(r=>r.family)).size,
    independentComponents:new Set(list.map(r=>r.metadata.component??r.family)).size,
    sourcePrograms:new Set(list.map(r=>sha256(r.source))).size});
  return {total:count(rows),bySplit:Object.fromEntries(['train','validation','test'].map(split=>[split,count(rows.filter(r=>r.split===split))])),
    byFeature:Object.fromEntries([...new Set(rows.flatMap(r=>r.metadata.features??[]))].sort().map(feature=>[feature,rows.filter(r=>r.metadata.features?.includes(feature)).length]))};
}

export function executionInputSignature(row) {
  return sha256({source:row.source,entry:row.entry??'run',language:row.language??'js',args:row.args??[],
    randomSeed:row.randomSeed??17,
    nativeBindings:(row.nativeBindings??[]).map(binding=>({name:binding.name,kind:binding.kind??'synchronous'})),
    fixture:{calls:(row.fixture?.calls??[]).map(call=>({operation:call.operation,arguments:call.arguments??[],
      status:call.status??'fulfilled',result:Object.hasOwn(call,'result')?call.result:{$js:'undefined'}})),settlementOrder:row.fixture?.settlementOrder??null}});
}

export function splitDiagnosticInputs(rows) {
  // Keep a fourth variant only for a familiar-input diagnostic when earlier
  // variants of that same exact source exist in training. Never move a test row.
  const seen=new Set(rows.filter(r=>r.split==='train'&&r.metadata.inputVariant!==3).map(r=>sha256(r.source)));
  const candidates=[],main=[];
  for(const row of rows){
    if(row.split==='train'&&row.metadata.inputVariant===3&&seen.has(sha256(row.source))){
      candidates.push(row);
    }else main.push(row);
  }
  const trainingKeys=new Set(main.filter(row=>row.split==='train').map(executionInputSignature)),diagnosticKeys=new Set();
  const familiar=[],duplicateDiagnosticInputs=[];
  for(const row of candidates){
    const signature=executionInputSignature(row),reason=trainingKeys.has(signature)?'duplicates-training-execution':
      diagnosticKeys.has(signature)?'duplicates-familiar-diagnostic':null;
    if(reason){duplicateDiagnosticInputs.push({id:row.id,family:row.family,signature,reason});continue;}
    diagnosticKeys.add(signature);
    familiar.push({...row,id:row.id+'-familiar',split:'test',metadata:{...row.metadata,evaluationRole:'familiar_inputs',diagnosticOnly:true,
      inputNovelty:'execution-input-signature-absent-from-training',executionInputSignature:signature}});
  }
  return {main,familiar,duplicateDiagnosticInputs};
}

export function challengeCandidates(rows,{seed=17,limit=120}={}) {
  const selected=rows.filter(r=>r.split==='test'&&r.metadata.sourceOrigin==='authored-generator'&&
    r.metadata.sourceForm==='direct'&&r.metadata.inputVariant===1&&r.metadata.features.includes('loop'))
    .sort((a,b)=>sha256(seed+':'+a.id).localeCompare(sha256(seed+':'+b.id))).slice(0,limit);
  return selected.map(row=>{
    // Longer inputs retain source ancestry. Additional repeated calls compose
    // the existing algorithm without inventing a new independent family.
    const core=row.source.replace(/\bfunction\s+run\b/,'function __challengeCore');
    const source=core+'\nfunction run(a,b){const first=__challengeCore(a,b);const second=__challengeCore(a,b);return [first,second];}';
    const args=structuredClone(row.args);
    if(Array.isArray(args[0])){const a=args[0];args[0]=[...a,...a,...a,...a];if(Array.isArray(args[1]))args[1]=[...args[1],...args[1],...args[1],...args[1]];}
    return {...row,id:row.id+'-long-composition',source,args,metadata:{...row.metadata,evaluationRole:'challenge',diagnosticOnly:true,
      sourceForm:'longer-repeated-composition',features:[...new Set([...row.metadata.features,'longer-execution','composition'])],tier:5}};
  });
}

export function readCandidateJsonl(path) {
  return readFileSync(resolve(path),'utf8').split(/\r?\n/).filter(Boolean).map((line,i)=>{try{return JSON.parse(line);}catch{throw Error('Invalid JSONL at '+path+':'+(i+1));}});
}
