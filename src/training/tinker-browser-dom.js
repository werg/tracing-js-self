// Self-contained deterministic VM Browser/DOM runtime, public AST tool scanner,
// and tool descriptors for frontend/browser execution tasks.
import {parse} from 'acorn';

export const DEFAULT_BROWSER_URL = 'https://app.example.test/';
export const DEFAULT_BROWSER_HTML = '<!DOCTYPE html><html><head><title>App</title></head><body><div id="app"></div></body></html>';

export const BROWSER_TOOL_DESCRIPTIONS = Object.freeze({
  'browser.storageGet': 'Invoke JS external operation browser.storageGet (synchronous, 2 arguments: [area ("local"|"session"), key]) -> string or null.',
  'browser.storageSet': 'Invoke JS external operation browser.storageSet (synchronous, 3 arguments: [area ("local"|"session"), key, value]) -> null.',
  'browser.storageRemove': 'Invoke JS external operation browser.storageRemove (synchronous, 2 arguments: [area ("local"|"session"), key]) -> null.',
  'browser.storageClear': 'Invoke JS external operation browser.storageClear (synchronous, 1 argument: [area ("local"|"session")]) -> null.',
  'browser.alert': 'Invoke JS external operation browser.alert (synchronous, 1 argument: [message]) -> null.',
  'browser.confirm': 'Invoke JS external operation browser.confirm (synchronous, 1 argument: [message]) -> boolean.',
  'browser.prompt': 'Invoke JS external operation browser.prompt (synchronous, 2 arguments: [message, defaultValue]) -> string or null.',
});

const STORAGE_METHODS = Object.freeze({
  getItem: 'browser.storageGet',
  setItem: 'browser.storageSet',
  removeItem: 'browser.storageRemove',
  clear: 'browser.storageClear',
});

const ALL_STORAGE_TOOLS = Object.freeze([
  'browser.storageGet',
  'browser.storageSet',
  'browser.storageRemove',
  'browser.storageClear',
]);

const GLOBAL_HOSTS = new Set(['window', 'globalThis', 'self']);

/**
 * Scan public JS source AST (NEVER fixture!) and return the sorted list of
 * external tools referenced by browser code:
 * - localStorage / sessionStorage -> browser.storage*
 * - alert / confirm / prompt -> browser.alert / browser.confirm / browser.prompt
 * - fetch -> http.request
 * - console.(log|info|warn|error) -> platform.console.$1
 * - Date.now -> platform.dateNow
 */
export function scanPublicSourceBrowserTools(source) {
  let ast;
  try {
    ast = parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
  } catch {
    try {
      ast = parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
    } catch {
      const fallback = new Set();
      if (/\b(?:localStorage|sessionStorage)\b/.test(source)) {
        for (const t of ALL_STORAGE_TOOLS) fallback.add(t);
      }
      if (/\balert\s*\(/.test(source)) fallback.add('browser.alert');
      if (/\bconfirm\s*\(/.test(source)) fallback.add('browser.confirm');
      if (/\bprompt\s*\(/.test(source)) fallback.add('browser.prompt');
      if (/\bfetch\s*\(/.test(source)) fallback.add('http.request');
      if (/\bDate\.now\b/.test(source)) fallback.add('platform.dateNow');
      for (const m of source.matchAll(/\bconsole\.(log|info|warn|error)\b/g)) {
        fallback.add('platform.console.' + m[1]);
      }
      return [...fallback].sort();
    }
  }

  const tools = new Set();

  function collectPatternNames(pattern, out) {
    if (!pattern || typeof pattern !== 'object') return;
    switch (pattern.type) {
      case 'Identifier':
        out.add(pattern.name);
        break;
      case 'AssignmentPattern':
        collectPatternNames(pattern.left, out);
        break;
      case 'RestElement':
        collectPatternNames(pattern.argument, out);
        break;
      case 'ArrayPattern':
        for (const el of pattern.elements ?? []) collectPatternNames(el, out);
        break;
      case 'ObjectPattern':
        for (const prop of pattern.properties ?? []) {
          collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
        }
        break;
    }
  }

  function collectScopeBindings(node, isFunctionScope) {
    const bound = new Set();
    if (!node || typeof node !== 'object') return bound;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id?.name) bound.add(node.id.name);
      for (const p of node.params ?? []) collectPatternNames(p, bound);
      if (node.body?.type === 'BlockStatement') {
        for (const b of collectScopeBindings(node.body, true)) bound.add(b);
      }
      return bound;
    }
    if (node.type === 'CatchClause' && node.param) {
      collectPatternNames(node.param, bound);
      return bound;
    }
    const stmts = node.type === 'Program' || node.type === 'BlockStatement' ? node.body : null;
    if (Array.isArray(stmts)) {
      for (const st of stmts) {
        if (st.type === 'FunctionDeclaration' && st.id?.name) bound.add(st.id.name);
        else if (st.type === 'ClassDeclaration' && st.id?.name) bound.add(st.id.name);
        else if (st.type === 'ImportDeclaration') {
          for (const spec of st.specifiers ?? []) {
            if (spec.local?.name) bound.add(spec.local.name);
          }
        } else if (st.type === 'VariableDeclaration') {
          if (st.kind !== 'var' || isFunctionScope) {
            for (const d of st.declarations ?? []) collectPatternNames(d.id, bound);
          }
        }
      }
    }
    if (isFunctionScope && (node.type === 'Program' || node.type === 'BlockStatement')) {
      // Collect var declarations hoisted anywhere inside this function/program scope.
      const scanVars = n => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) scanVars(x); return; }
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type)) return;
        if (n.type === 'VariableDeclaration' && n.kind === 'var') {
          for (const d of n.declarations ?? []) collectPatternNames(d.id, bound);
        }
        for (const [k, v] of Object.entries(n)) {
          if (k === 'start' || k === 'end' || k === 'loc' || k === 'raw') continue;
          if (v && typeof v === 'object') scanVars(v);
        }
      };
      for (const st of node.body ?? []) scanVars(st);
    }
    return bound;
  }

  function isNonReferenceIdentifier(node, parent) {
    if (!parent) return false;
    if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) return true;
    if (parent.type === 'Property' && !parent.computed && parent.key === node) return true;
    if (parent.type === 'MethodDefinition' && !parent.computed && parent.key === node) return true;
    if (parent.type === 'PropertyDefinition' && !parent.computed && parent.key === node) return true;
    if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
         parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) return true;
    if (parent.type === 'VariableDeclarator' && parent.id === node) return true;
    if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true;
    if (['ArrayPattern', 'ObjectPattern', 'RestElement'].includes(parent.type)) return true;
    if (parent.type === 'AssignmentPattern' && parent.left === node) return true;
    if (parent.type === 'CatchClause' && parent.param === node) return true;
    return false;
  }

  function isGlobalHost(node, shadowed) {
    return node?.type === 'Identifier' && GLOBAL_HOSTS.has(node.name) && !shadowed.has(node.name);
  }

  function handleStorageReference(storageNode, parent) {
    if (parent?.type === 'MemberExpression' && parent.object === storageNode && !parent.computed &&
        parent.property?.type === 'Identifier' && Object.hasOwn(STORAGE_METHODS, parent.property.name)) {
      tools.add(STORAGE_METHODS[parent.property.name]);
    } else if (parent?.type === 'MemberExpression' && parent.object === storageNode && parent.computed &&
        parent.property?.type === 'Literal' && typeof parent.property.value === 'string' &&
        Object.hasOwn(STORAGE_METHODS, parent.property.value)) {
      tools.add(STORAGE_METHODS[parent.property.value]);
    } else {
      // Escaping / aliased storage object (e.g. `const s = localStorage; s.setItem(...)`):
      // declare all 4 storage operations deterministically from public AST.
      for (const t of ALL_STORAGE_TOOLS) tools.add(t);
    }
  }

  function visit(node, parent, shadowed) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, shadowed);
      return;
    }
    if (typeof node.type !== 'string') return;

    let nextShadowed = shadowed;
    if (node.type === 'Program') {
      const b = collectScopeBindings(node, true);
      if (b.size) nextShadowed = new Set([...shadowed, ...b]);
    } else if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      const b = collectScopeBindings(node, true);
      if (b.size) nextShadowed = new Set([...shadowed, ...b]);
    } else if (node.type === 'BlockStatement' &&
        !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(parent?.type)) {
      const b = collectScopeBindings(node, false);
      if (b.size) nextShadowed = new Set([...shadowed, ...b]);
    } else if (node.type === 'CatchClause') {
      const b = collectScopeBindings(node, false);
      if (b.size) nextShadowed = new Set([...shadowed, ...b]);
    }

    // Handle window.X / globalThis.X / self.X member expressions
    if (node.type === 'MemberExpression' && !node.computed &&
        isGlobalHost(node.object, nextShadowed) && node.property?.type === 'Identifier') {
      const prop = node.property.name;
      if (prop === 'localStorage' || prop === 'sessionStorage') {
        handleStorageReference(node, parent);
        return;
      }
      if (prop === 'alert') { tools.add('browser.alert'); return; }
      if (prop === 'confirm') { tools.add('browser.confirm'); return; }
      if (prop === 'prompt') { tools.add('browser.prompt'); return; }
      if (prop === 'fetch') { tools.add('http.request'); return; }
      if (prop === 'console' && parent?.type === 'MemberExpression' && !parent.computed &&
          parent.object === node && parent.property?.type === 'Identifier' &&
          ['log', 'info', 'warn', 'error'].includes(parent.property.name)) {
        tools.add('platform.console.' + parent.property.name);
        return;
      }
      if (prop === 'Date' && parent?.type === 'MemberExpression' && !parent.computed &&
          parent.object === node && parent.property?.type === 'Identifier' && parent.property.name === 'now') {
        tools.add('platform.dateNow');
        return;
      }
    }

    // Handle bare Date.now / console.<method>
    if (node.type === 'MemberExpression' && !node.computed &&
        node.object?.type === 'Identifier' && !nextShadowed.has(node.object.name) &&
        node.property?.type === 'Identifier') {
      if (node.object.name === 'Date' && node.property.name === 'now') {
        tools.add('platform.dateNow');
      } else if (node.object.name === 'console' && ['log', 'info', 'warn', 'error'].includes(node.property.name)) {
        tools.add('platform.console.' + node.property.name);
      }
    }

    // Handle bare global identifiers (localStorage, sessionStorage, alert, confirm, prompt, fetch)
    if (node.type === 'Identifier' && !nextShadowed.has(node.name) && !isNonReferenceIdentifier(node, parent)) {
      if (node.name === 'localStorage' || node.name === 'sessionStorage') {
        handleStorageReference(node, parent);
      } else if (node.name === 'alert') {
        tools.add('browser.alert');
      } else if (node.name === 'confirm') {
        tools.add('browser.confirm');
      } else if (node.name === 'prompt') {
        tools.add('browser.prompt');
      } else if (node.name === 'fetch') {
        tools.add('http.request');
      }
    }

    for (const [key, val] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'raw') continue;
      if (val && typeof val === 'object') visit(val, node, nextShadowed);
    }
  }

  visit(ast, null, new Set());
  return [...tools].sort();
}

/**
 * Self-contained deterministic VM Browser/DOM runtime injected when task.environment === 'browser'.
 * Expects host-provided globals on context:
 *   - __browserInvoke(operation, args)
 *   - __browserInitialHtml (string)
 *   - __browserInitialUrl (string)
 */
export const VM_BROWSER_DOM_RUNTIME_SCRIPT = `(function() {
  'use strict';

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
  const AUTO_CLOSE_SIBLINGS = {
    p: new Set(['p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'article', 'header', 'footer', 'main', 'nav', 'form', 'hr']),
    li: new Set(['li']),
    dt: new Set(['dt', 'dd']),
    dd: new Set(['dt', 'dd']),
    td: new Set(['td', 'th']),
    th: new Set(['td', 'th']),
    tr: new Set(['tr']),
    option: new Set(['option', 'optgroup']),
  };

  function decodeEntities(str) {
    if (!str || str.indexOf('&') === -1) return str;
    return str.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g, (m, hex, dec, named) => {
      if (hex) {
        const cp = parseInt(hex, 16);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      if (dec) {
        const cp = parseInt(dec, 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      switch (named) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return '\\u00a0';
        default: return m;
      }
    });
  }

  function escapeText(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  function camelToKebab(str) {
    return String(str).replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
  }

  function kebabToCamel(str) {
    return String(str).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  }

  // ==================== Event Model ====================
  class Event {
    constructor(type, init = {}) {
      if (arguments.length < 1) throw new TypeError('Event type is required');
      this.type = String(type);
      const opts = init && typeof init === 'object' ? init : {};
      this.bubbles = Boolean(opts.bubbles);
      this.cancelable = Boolean(opts.cancelable);
      this.composed = Boolean(opts.composed);
      this.defaultPrevented = false;
      this.target = null;
      this.srcElement = null;
      this.currentTarget = null;
      this.eventPhase = 0;
      this.isTrusted = false;
      this.timeStamp = virtualNow;
      this._propagationStopped = false;
      this._immediateStopped = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
    stopPropagation() {
      this._propagationStopped = true;
    }
    stopImmediatePropagation() {
      this._propagationStopped = true;
      this._immediateStopped = true;
    }
    composedPath() {
      return this._path ? this._path.slice() : [];
    }
  }
  Event.NONE = Event.prototype.NONE = 0;
  Event.CAPTURING_PHASE = Event.prototype.CAPTURING_PHASE = 1;
  Event.AT_TARGET = Event.prototype.AT_TARGET = 2;
  Event.BUBBLING_PHASE = Event.prototype.BUBBLING_PHASE = 3;

  class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.detail = opts.detail !== undefined ? opts.detail : null;
    }
  }

  class UIEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.detail = opts.detail ?? 0;
      this.view = opts.view ?? null;
    }
  }

  class MouseEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.button = opts.button ?? 0;
      this.buttons = opts.buttons ?? 0;
      this.clientX = opts.clientX ?? 0;
      this.clientY = opts.clientY ?? 0;
      this.altKey = Boolean(opts.altKey);
      this.ctrlKey = Boolean(opts.ctrlKey);
      this.metaKey = Boolean(opts.metaKey);
      this.shiftKey = Boolean(opts.shiftKey);
      this.relatedTarget = opts.relatedTarget ?? null;
    }
  }

  class InputEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.data = opts.data !== undefined ? opts.data : null;
      this.inputType = opts.inputType ?? '';
      this.isComposing = Boolean(opts.isComposing);
    }
  }

  class KeyboardEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.key = opts.key ?? '';
      this.code = opts.code ?? '';
      this.altKey = Boolean(opts.altKey);
      this.ctrlKey = Boolean(opts.ctrlKey);
      this.metaKey = Boolean(opts.metaKey);
      this.shiftKey = Boolean(opts.shiftKey);
      this.repeat = Boolean(opts.repeat);
    }
  }

  class FocusEvent extends UIEvent {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.relatedTarget = opts.relatedTarget ?? null;
    }
  }

  class SubmitEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.submitter = opts.submitter ?? null;
    }
  }

  class PopStateEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      const opts = init && typeof init === 'object' ? init : {};
      this.state = opts.state !== undefined ? opts.state : null;
    }
  }

  function parseListenerOptions(options) {
    if (typeof options === 'boolean') return {capture: options, once: false, passive: false};
    if (options && typeof options === 'object') {
      return {
        capture: Boolean(options.capture),
        once: Boolean(options.once),
        passive: Boolean(options.passive),
      };
    }
    return {capture: false, once: false, passive: false};
  }

  function invokeListenerEntry(target, event, entry) {
    if (entry.once) {
      const list = target._listeners && target._listeners.get(event.type);
      if (list) {
        const idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
    if (typeof entry.listener === 'function') {
      entry.listener.call(target, event);
    } else if (entry.listener && typeof entry.listener.handleEvent === 'function') {
      entry.listener.handleEvent(event);
    }
  }

  function buildEventPath(target) {
    const path = [target];
    let cur = target;
    while (cur && cur.parentNode) {
      cur = cur.parentNode;
      path.push(cur);
    }
    if (cur && cur.nodeType === 9 && cur.defaultView) {
      path.push(cur.defaultView);
    }
    return path;
  }

  function dispatchEventOn(target, event) {
    if (!(event instanceof Event)) throw new TypeError('dispatchEvent expects an Event');
    const path = buildEventPath(target);
    event._path = path;
    event.target = target;
    event.srcElement = target;
    event._propagationStopped = false;
    event._immediateStopped = false;

    // 1. CAPTURING_PHASE (outermost -> parent of target)
    event.eventPhase = Event.CAPTURING_PHASE;
    for (let i = path.length - 1; i >= 1; i--) {
      if (event._propagationStopped) break;
      const node = path[i];
      const list = node._listeners && node._listeners.get(event.type);
      if (!list || !list.length) continue;
      event.currentTarget = node;
      const snapshot = list.slice();
      for (const entry of snapshot) {
        if (event._immediateStopped) break;
        if (entry.capture) invokeListenerEntry(node, event, entry);
      }
    }

    // 2. AT_TARGET
    if (!event._propagationStopped) {
      event.eventPhase = Event.AT_TARGET;
      const list = target._listeners && target._listeners.get(event.type);
      if (list && list.length) {
        event.currentTarget = target;
        const snapshot = list.slice();
        for (const entry of snapshot) {
          if (event._immediateStopped) break;
          invokeListenerEntry(target, event, entry);
        }
      }
    }

    // 3. BUBBLING_PHASE (parent of target -> outermost)
    if (event.bubbles && !event._propagationStopped) {
      event.eventPhase = Event.BUBBLING_PHASE;
      for (let i = 1; i < path.length; i++) {
        if (event._propagationStopped) break;
        const node = path[i];
        const list = node._listeners && node._listeners.get(event.type);
        if (!list || !list.length) continue;
        event.currentTarget = node;
        const snapshot = list.slice();
        for (const entry of snapshot) {
          if (event._immediateStopped) break;
          if (!entry.capture) invokeListenerEntry(node, event, entry);
        }
      }
    }

    event.eventPhase = Event.NONE;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  class EventTarget {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, listener, options) {
      if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return;
      const t = String(type);
      const opts = parseListenerOptions(options);
      if (!this._listeners) this._listeners = new Map();
      let list = this._listeners.get(t);
      if (!list) {
        list = [];
        this._listeners.set(t, list);
      }
      if (list.some(e => e.listener === listener && e.capture === opts.capture)) return;
      list.push({listener, capture: opts.capture, once: opts.once, passive: opts.passive});
    }
    removeEventListener(type, listener, options) {
      if (!this._listeners) return;
      const t = String(type);
      const opts = parseListenerOptions(options);
      const list = this._listeners.get(t);
      if (!list) return;
      const idx = list.findIndex(e => e.listener === listener && e.capture === opts.capture);
      if (idx >= 0) list.splice(idx, 1);
    }
    dispatchEvent(event) {
      return dispatchEventOn(this, event);
    }
  }

  // ==================== CSS Selector Engine ====================
  function splitTopLevel(str, delimiter) {
    const out = [];
    let cur = '';
    let bracketDepth = 0;
    let parenDepth = 0;
    let quote = null;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (quote) {
        cur += ch;
        if (ch === '\\\\' && i + 1 < str.length) {
          cur += str[++i];
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === '[') {
        bracketDepth++;
        cur += ch;
      } else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
        cur += ch;
      } else if (ch === '(') {
        parenDepth++;
        cur += ch;
      } else if (ch === ')') {
        if (parenDepth > 0) parenDepth--;
        cur += ch;
      } else if (ch === delimiter && bracketDepth === 0 && parenDepth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseCompound(raw) {
    const comp = {tag: null, id: null, classes: [], attrs: [], pseudos: []};
    let i = 0;
    const len = raw.length;
    while (i < len) {
      const ch = raw[i];
      if (ch === '*') {
        comp.tag = '*';
        i++;
      } else if (ch === '#') {
        i++;
        let start = i;
        while (i < len && /[A-Za-z0-9_-]/.test(raw[i])) i++;
        comp.id = raw.slice(start, i);
      } else if (ch === '.') {
        i++;
        let start = i;
        while (i < len && /[A-Za-z0-9_-]/.test(raw[i])) i++;
        comp.classes.push(raw.slice(start, i));
      } else if (ch === '[') {
        i++;
        while (i < len && /\\s/.test(raw[i])) i++;
        let nameStart = i;
        while (i < len && /[^\\s=~|^$*\\]]/.test(raw[i])) i++;
        const name = raw.slice(nameStart, i).toLowerCase();
        while (i < len && /\\s/.test(raw[i])) i++;
        let op = null;
        let value = null;
        if (i < len && raw[i] !== ']') {
          if (raw[i] === '=') {
            op = '=';
            i++;
          } else if (i + 1 < len && raw[i + 1] === '=' && '~|^$*'.includes(raw[i])) {
            op = raw.slice(i, i + 2);
            i += 2;
          }
          while (i < len && /\\s/.test(raw[i])) i++;
          if (raw[i] === '"' || raw[i] === "'") {
            const q = raw[i++];
            let val = '';
            while (i < len && raw[i] !== q) {
              if (raw[i] === '\\\\' && i + 1 < len) val += raw[++i];
              else val += raw[i];
              i++;
            }
            if (raw[i] === q) i++;
            value = val;
          } else {
            let valStart = i;
            while (i < len && !/[\\s\\]]/.test(raw[i])) i++;
            value = raw.slice(valStart, i);
          }
          while (i < len && raw[i] !== ']') i++;
        }
        if (raw[i] === ']') i++;
        comp.attrs.push({name, op, value});
      } else if (ch === ':') {
        i++;
        if (raw[i] === ':') i++;
        let pStart = i;
        while (i < len && /[A-Za-z0-9_-]/.test(raw[i])) i++;
        const name = raw.slice(pStart, i).toLowerCase();
        let arg = null;
        if (raw[i] === '(') {
          i++;
          let depth = 1;
          let aStart = i;
          while (i < len && depth > 0) {
            if (raw[i] === '(') depth++;
            else if (raw[i] === ')') depth--;
            if (depth > 0) i++;
          }
          arg = raw.slice(aStart, i).trim();
          if (raw[i] === ')') i++;
        }
        comp.pseudos.push({name, arg});
      } else if (/[A-Za-z0-9_-]/.test(ch)) {
        let start = i;
        while (i < len && /[A-Za-z0-9_-]/.test(raw[i])) i++;
        comp.tag = raw.slice(start, i).toLowerCase();
      } else {
        i++;
      }
    }
    return comp;
  }

  function parseComplexSelector(raw) {
    // Returns [{compound, combinatorToPrev}] where combinatorToPrev is null | ' ' | '>' | '+' | '~'
    const parts = [];
    let i = 0;
    const len = raw.length;
    let pendingCombinator = null;
    while (i < len) {
      while (i < len && /\\s/.test(raw[i])) i++;
      if (i >= len) break;
      if (raw[i] === '>' || raw[i] === '+' || raw[i] === '~') {
        pendingCombinator = raw[i++];
        continue;
      }
      let start = i;
      let bracketDepth = 0;
      let parenDepth = 0;
      let quote = null;
      while (i < len) {
        const ch = raw[i];
        if (quote) {
          if (ch === '\\\\' && i + 1 < len) { i += 2; continue; }
          if (ch === quote) quote = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
        if (ch === '[') { bracketDepth++; i++; continue; }
        if (ch === ']') { if (bracketDepth > 0) bracketDepth--; i++; continue; }
        if (ch === '(') { parenDepth++; i++; continue; }
        if (ch === ')') { if (parenDepth > 0) parenDepth--; i++; continue; }
        if (bracketDepth === 0 && parenDepth === 0 && (/[\\s>+~]/.test(ch))) break;
        i++;
      }
      const token = raw.slice(start, i);
      if (token) {
        parts.push({
          compound: parseCompound(token),
          combinator: parts.length === 0 ? null : (pendingCombinator || ' '),
        });
        pendingCombinator = null;
      }
    }
    return parts;
  }

  const selectorCache = new Map();
  function compileSelectorList(selector) {
    const key = String(selector).trim();
    if (!key) throw new SyntaxError('Empty selector');
    let parsed = selectorCache.get(key);
    if (!parsed) {
      parsed = splitTopLevel(key, ',').map(parseComplexSelector).filter(p => p.length > 0);
      if (selectorCache.size < 512) selectorCache.set(key, parsed);
    }
    return parsed;
  }

  function matchesNthChild(index1Based, arg) {
    const s = String(arg || '').replace(/\\s+/g, '').toLowerCase();
    if (s === 'odd') return index1Based % 2 === 1;
    if (s === 'even') return index1Based % 2 === 0;
    if (/^[+-]?\\d+$/.test(s)) return index1Based === parseInt(s, 10);
    const m = /^([+-]?\\d*)n([+-]\\d+)?$/.exec(s);
    if (!m) return false;
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : 0;
    if (a === 0) return index1Based === b;
    const diff = index1Based - b;
    return diff % a === 0 && diff / a >= 0;
  }

  function matchesCompound(el, comp) {
    if (!el || el.nodeType !== 1) return false;
    if (comp.tag && comp.tag !== '*' && el.localName !== comp.tag) return false;
    if (comp.id !== null && el.id !== comp.id) return false;
    if (comp.classes.length) {
      const clsAttr = el.getAttribute('class') || '';
      const clsSet = clsAttr ? clsAttr.trim().split(/\\s+/) : [];
      for (const c of comp.classes) {
        if (!clsSet.includes(c)) return false;
      }
    }
    for (const attr of comp.attrs) {
      const has = el.hasAttribute(attr.name);
      if (!has) return false;
      if (attr.op !== null) {
        const val = el.getAttribute(attr.name) ?? '';
        switch (attr.op) {
          case '=': if (val !== attr.value) return false; break;
          case '^=': if (!attr.value || !val.startsWith(attr.value)) return false; break;
          case '$=': if (!attr.value || !val.endsWith(attr.value)) return false; break;
          case '*=': if (!attr.value || !val.includes(attr.value)) return false; break;
          case '~=': if (!attr.value || !val.trim().split(/\\s+/).includes(attr.value)) return false; break;
          case '|=': if (val !== attr.value && !val.startsWith(attr.value + '-')) return false; break;
          default: return false;
        }
      }
    }
    for (const p of comp.pseudos) {
      switch (p.name) {
        case 'first-child':
          if (!el.parentNode || el.previousElementSibling !== null) return false;
          break;
        case 'last-child':
          if (!el.parentNode || el.nextElementSibling !== null) return false;
          break;
        case 'nth-child': {
          if (!el.parentNode) return false;
          const siblings = el.parentNode.children;
          const idx = siblings.indexOf(el);
          if (idx < 0 || !matchesNthChild(idx + 1, p.arg)) return false;
          break;
        }
        case 'empty':
          if (el._childNodes.length > 0) return false;
          break;
        case 'checked':
          if (!el.checked && !el.selected) return false;
          break;
        case 'disabled':
          if (!el.disabled) return false;
          break;
        case 'enabled':
          if (el.disabled) return false;
          break;
        case 'not':
          if (p.arg && matchesSelectorList(el, compileSelectorList(p.arg))) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  function matchesComplex(el, parts, idx) {
    if (!matchesCompound(el, parts[idx].compound)) return false;
    if (idx === 0) return true;
    const comb = parts[idx].combinator;
    if (comb === '>') {
      return Boolean(el.parentElement && matchesComplex(el.parentElement, parts, idx - 1));
    }
    if (comb === ' ') {
      let cur = el.parentElement;
      while (cur) {
        if (matchesComplex(cur, parts, idx - 1)) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    if (comb === '+') {
      return Boolean(el.previousElementSibling && matchesComplex(el.previousElementSibling, parts, idx - 1));
    }
    if (comb === '~') {
      let cur = el.previousElementSibling;
      while (cur) {
        if (matchesComplex(cur, parts, idx - 1)) return true;
        cur = cur.previousElementSibling;
      }
      return false;
    }
    return false;
  }

  function matchesSelectorList(el, list) {
    for (const parts of list) {
      if (matchesComplex(el, parts, parts.length - 1)) return true;
    }
    return false;
  }

  function walkElements(root, cb) {
    for (const child of root._childNodes) {
      if (child.nodeType === 1) {
        if (cb(child) === false) return false;
        if (walkElements(child, cb) === false) return false;
      }
    }
    return true;
  }

  // ==================== Mutation Observer Registry ====================
  const activeMutationObservers = new Set();

  function scheduleMicrotaskDeterministic(fn) {
    if (typeof globalThis.queueMicrotask === 'function') {
      globalThis.queueMicrotask(fn);
    } else {
      Promise.resolve().then(fn);
    }
  }

  function notifyMutation(record) {
    if (activeMutationObservers.size === 0) return;
    for (const observer of activeMutationObservers) {
      observer._enqueueIfMatched(record);
    }
  }

  // ==================== DOM Classes ====================
  class Node extends EventTarget {
    constructor(nodeType, nodeName, ownerDocument = null) {
      super();
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.parentNode = null;
      this._childNodes = [];
      this.ownerDocument = ownerDocument;
    }
    get childNodes() {
      return this._childNodes.slice();
    }
    get firstChild() {
      return this._childNodes.length ? this._childNodes[0] : null;
    }
    get lastChild() {
      return this._childNodes.length ? this._childNodes[this._childNodes.length - 1] : null;
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get previousSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode._childNodes.indexOf(this);
      return idx > 0 ? this.parentNode._childNodes[idx - 1] : null;
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode._childNodes.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode._childNodes.length ? this.parentNode._childNodes[idx + 1] : null;
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur.nodeType === 9) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    hasChildNodes() {
      return this._childNodes.length > 0;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    _checkHierarchy(newNode) {
      if (!(newNode instanceof Node)) throw new TypeError('Parameter is not of type Node');
      if (newNode === this || newNode.contains(this)) {
        throw new Error('HierarchyRequestError: The new child element contains the parent');
      }
    }
    appendChild(child) {
      return this.insertBefore(child, null);
    }
    insertBefore(newNode, refNode) {
      this._checkHierarchy(newNode);
      if (refNode !== null && refNode !== undefined && refNode.parentNode !== this) {
        throw new Error('NotFoundError: Reference node is not a child of this node');
      }
      const doc = this.nodeType === 9 ? this : this.ownerDocument;
      if (newNode.nodeType === 11) {
        const moved = newNode._childNodes.slice();
        newNode._childNodes.length = 0;
        for (const item of moved) {
          item.parentNode = null;
          this.insertBefore(item, refNode ?? null);
        }
        return newNode;
      }
      if (newNode.parentNode) {
        newNode.parentNode.removeChild(newNode);
      }
      newNode.parentNode = this;
      if (doc) setOwnerDoc(newNode, doc);
      let insertIdx;
      if (refNode === null || refNode === undefined) {
        insertIdx = this._childNodes.length;
        this._childNodes.push(newNode);
      } else {
        insertIdx = this._childNodes.indexOf(refNode);
        this._childNodes.splice(insertIdx, 0, newNode);
      }
      notifyMutation({
        type: 'childList',
        target: this,
        addedNodes: [newNode],
        removedNodes: [],
        previousSibling: insertIdx > 0 ? this._childNodes[insertIdx - 1] : null,
        nextSibling: insertIdx + 1 < this._childNodes.length ? this._childNodes[insertIdx + 1] : null,
        attributeName: null,
        attributeNamespace: null,
        oldValue: null,
      });
      return newNode;
    }
    removeChild(child) {
      const idx = this._childNodes.indexOf(child);
      if (idx < 0) throw new Error('NotFoundError: Node is not a child of this node');
      const prevSib = idx > 0 ? this._childNodes[idx - 1] : null;
      const nextSib = idx + 1 < this._childNodes.length ? this._childNodes[idx + 1] : null;
      this._childNodes.splice(idx, 1);
      child.parentNode = null;
      notifyMutation({
        type: 'childList',
        target: this,
        addedNodes: [],
        removedNodes: [child],
        previousSibling: prevSib,
        nextSibling: nextSib,
        attributeName: null,
        attributeNamespace: null,
        oldValue: null,
      });
      return child;
    }
    replaceChild(newChild, oldChild) {
      if (oldChild.parentNode !== this) throw new Error('NotFoundError: Old node is not a child of this node');
      if (newChild === oldChild) return oldChild;
      this.insertBefore(newChild, oldChild);
      this.removeChild(oldChild);
      return oldChild;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 8) return this._data;
      if (this.nodeType === 9) return null;
      let out = '';
      for (const ch of this._childNodes) {
        if (ch.nodeType === 3) out += ch._data;
        else if (ch.nodeType === 1 || ch.nodeType === 11) out += ch.textContent;
      }
      return out;
    }
    set textContent(val) {
      if (this.nodeType === 3 || this.nodeType === 8) {
        const oldValue = this._data;
        this._data = val === null || val === undefined ? '' : String(val);
        notifyMutation({
          type: 'characterData',
          target: this,
          addedNodes: [],
          removedNodes: [],
          previousSibling: null,
          nextSibling: null,
          attributeName: null,
          attributeNamespace: null,
          oldValue,
        });
        return;
      }
      const removed = this._childNodes.slice();
      for (const ch of removed) ch.parentNode = null;
      this._childNodes.length = 0;
      const text = val === null || val === undefined ? '' : String(val);
      const added = [];
      if (text.length > 0) {
        const doc = this.nodeType === 9 ? this : this.ownerDocument;
        const textNode = new Text(text, doc);
        textNode.parentNode = this;
        this._childNodes.push(textNode);
        added.push(textNode);
      }
      if (removed.length || added.length) {
        notifyMutation({
          type: 'childList',
          target: this,
          addedNodes: added,
          removedNodes: removed,
          previousSibling: null,
          nextSibling: null,
          attributeName: null,
          attributeNamespace: null,
          oldValue: null,
        });
      }
    }
    cloneNode(deep = false) {
      throw new Error('cloneNode must be implemented by subclass');
    }
  }
  Node.ELEMENT_NODE = Node.prototype.ELEMENT_NODE = 1;
  Node.TEXT_NODE = Node.prototype.TEXT_NODE = 3;
  Node.COMMENT_NODE = Node.prototype.COMMENT_NODE = 8;
  Node.DOCUMENT_NODE = Node.prototype.DOCUMENT_NODE = 9;
  Node.DOCUMENT_FRAGMENT_NODE = Node.prototype.DOCUMENT_FRAGMENT_NODE = 11;

  function setOwnerDoc(node, doc) {
    node.ownerDocument = doc;
    for (const ch of node._childNodes) setOwnerDoc(ch, doc);
  }

  function coerceToNodes(args, ownerDocument) {
    const out = [];
    for (const item of args) {
      if (item instanceof Node) out.push(item);
      else out.push(new Text(String(item), ownerDocument));
    }
    return out;
  }

  class Text extends Node {
    constructor(data = '', ownerDocument = null) {
      super(3, '#text', ownerDocument);
      this._data = String(data);
    }
    get data() { return this._data; }
    set data(v) {
      const oldValue = this._data;
      this._data = String(v);
      notifyMutation({
        type: 'characterData',
        target: this,
        addedNodes: [],
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
        attributeName: null,
        attributeNamespace: null,
        oldValue,
      });
    }
    get nodeValue() { return this._data; }
    set nodeValue(v) { this.data = v === null || v === undefined ? '' : String(v); }
    get length() { return this._data.length; }
    cloneNode() { return new Text(this._data, this.ownerDocument); }
  }

  class Comment extends Node {
    constructor(data = '', ownerDocument = null) {
      super(8, '#comment', ownerDocument);
      this._data = String(data);
    }
    get data() { return this._data; }
    set data(v) {
      const oldValue = this._data;
      this._data = String(v);
      notifyMutation({
        type: 'characterData',
        target: this,
        addedNodes: [],
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
        attributeName: null,
        attributeNamespace: null,
        oldValue,
      });
    }
    get nodeValue() { return this._data; }
    set nodeValue(v) { this.data = v === null || v === undefined ? '' : String(v); }
    cloneNode() { return new Comment(this._data, this.ownerDocument); }
  }

  class DOMTokenList {
    constructor(el) {
      this._el = el;
    }
    _tokens() {
      const raw = this._el.getAttribute('class') || '';
      return raw.trim() ? raw.trim().split(/\\s+/) : [];
    }
    _write(tokens) {
      this._el.setAttribute('class', tokens.join(' '));
    }
    get length() { return this._tokens().length; }
    get value() { return this._el.getAttribute('class') || ''; }
    set value(v) { this._el.setAttribute('class', String(v)); }
    item(index) {
      const t = this._tokens();
      return index >= 0 && index < t.length ? t[index] : null;
    }
    contains(token) {
      return this._tokens().includes(String(token));
    }
    add(...tokens) {
      const cur = this._tokens();
      for (const raw of tokens) {
        const tok = String(raw);
        if (!tok || /\\s/.test(tok)) throw new Error('InvalidCharacterError: Invalid class token');
        if (!cur.includes(tok)) cur.push(tok);
      }
      this._write(cur);
    }
    remove(...tokens) {
      const drop = new Set(tokens.map(String));
      const next = this._tokens().filter(t => !drop.has(t));
      this._write(next);
    }
    toggle(token, force) {
      const tok = String(token);
      if (!tok || /\\s/.test(tok)) throw new Error('InvalidCharacterError: Invalid class token');
      const cur = this._tokens();
      const has = cur.includes(tok);
      if (force === true) {
        if (!has) { cur.push(tok); this._write(cur); }
        return true;
      }
      if (force === false) {
        if (has) this._write(cur.filter(t => t !== tok));
        return false;
      }
      if (has) {
        this._write(cur.filter(t => t !== tok));
        return false;
      }
      cur.push(tok);
      this._write(cur);
      return true;
    }
    replace(oldTok, newTok) {
      const cur = this._tokens();
      const idx = cur.indexOf(String(oldTok));
      if (idx < 0) return false;
      cur[idx] = String(newTok);
      this._write([...new Set(cur)]);
      return true;
    }
    forEach(cb, thisArg) {
      this._tokens().forEach((v, i) => cb.call(thisArg, v, i, this));
    }
    toString() { return this.value; }
    [Symbol.iterator]() { return this._tokens()[Symbol.iterator](); }
  }

  function normalizeStyleKey(prop) {
    const raw = String(prop).trim();
    if (raw.startsWith('--')) return raw;
    return kebabToCamel(raw.toLowerCase());
  }

  function createStyleObject() {
    const obj = {};
    Object.defineProperties(obj, {
      setProperty: {
        enumerable: false,
        value(prop, val) {
          const key = normalizeStyleKey(prop);
          if (val === null || val === undefined || val === '') delete this[key];
          else this[key] = String(val);
        },
      },
      removeProperty: {
        enumerable: false,
        value(prop) {
          const key = normalizeStyleKey(prop);
          const prev = this[key] ?? '';
          delete this[key];
          return prev;
        },
      },
      getPropertyValue: {
        enumerable: false,
        value(prop) {
          const key = normalizeStyleKey(prop);
          return this[key] ?? '';
        },
      },
      cssText: {
        enumerable: false,
        get() {
          const parts = [];
          for (const [k, v] of Object.entries(this)) {
            if (v !== undefined && v !== null && v !== '') {
              const name = k.startsWith('--') ? k : camelToKebab(k);
              parts.push(name + ': ' + String(v));
            }
          }
          return parts.join('; ');
        },
        set(text) {
          for (const k of Object.keys(this)) delete this[k];
          parseStyleTextInto(this, text);
        },
      },
    });
    return obj;
  }

  function parseStyleTextInto(styleObj, text) {
    if (!text) return;
    for (const part of String(text).split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const rawProp = part.slice(0, colon).trim();
      const val = part.slice(colon + 1).trim();
      if (rawProp && val) styleObj[normalizeStyleKey(rawProp)] = val;
    }
  }

  function createDatasetProxy(el) {
    return new Proxy({}, {
      get(_, prop) {
        if (typeof prop !== 'string') return undefined;
        const val = el.getAttribute('data-' + camelToKebab(prop));
        return val === null ? undefined : val;
      },
      set(_, prop, value) {
        if (typeof prop !== 'string') return false;
        el.setAttribute('data-' + camelToKebab(prop), String(value));
        return true;
      },
      deleteProperty(_, prop) {
        if (typeof prop !== 'string') return false;
        el.removeAttribute('data-' + camelToKebab(prop));
        return true;
      },
      has(_, prop) {
        return typeof prop === 'string' && el.hasAttribute('data-' + camelToKebab(prop));
      },
      ownKeys() {
        const keys = [];
        for (const name of el._attrs.keys()) {
          if (name.startsWith('data-')) keys.push(kebabToCamel(name.slice(5)));
        }
        return keys;
      },
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop !== 'string') return undefined;
        const val = el.getAttribute('data-' + camelToKebab(prop));
        if (val === null) return undefined;
        return {configurable: true, enumerable: true, writable: true, value: val};
      },
    });
  }

  class ParentNodeBase extends Node {
    get children() {
      return this._childNodes.filter(n => n.nodeType === 1);
    }
    get childElementCount() {
      let c = 0;
      for (const n of this._childNodes) if (n.nodeType === 1) c++;
      return c;
    }
    get firstElementChild() {
      for (const n of this._childNodes) if (n.nodeType === 1) return n;
      return null;
    }
    get lastElementChild() {
      for (let i = this._childNodes.length - 1; i >= 0; i--) {
        if (this._childNodes[i].nodeType === 1) return this._childNodes[i];
      }
      return null;
    }
    append(...nodes) {
      const doc = this.nodeType === 9 ? this : this.ownerDocument;
      for (const n of coerceToNodes(nodes, doc)) this.appendChild(n);
    }
    prepend(...nodes) {
      const doc = this.nodeType === 9 ? this : this.ownerDocument;
      const first = this.firstChild;
      for (const n of coerceToNodes(nodes, doc)) this.insertBefore(n, first);
    }
    replaceChildren(...nodes) {
      const removed = this._childNodes.slice();
      for (const ch of removed) ch.parentNode = null;
      this._childNodes.length = 0;
      const doc = this.nodeType === 9 ? this : this.ownerDocument;
      const coerced = coerceToNodes(nodes, doc);
      const added = [];
      for (const n of coerced) {
        if (n.nodeType === 11) {
          for (const fc of n._childNodes.slice()) {
            fc.parentNode = this;
            if (doc) setOwnerDoc(fc, doc);
            this._childNodes.push(fc);
            added.push(fc);
          }
          n._childNodes.length = 0;
        } else {
          if (n.parentNode) n.parentNode.removeChild(n);
          n.parentNode = this;
          if (doc) setOwnerDoc(n, doc);
          this._childNodes.push(n);
          added.push(n);
        }
      }
      if (removed.length || added.length) {
        notifyMutation({
          type: 'childList',
          target: this,
          addedNodes: added,
          removedNodes: removed,
          previousSibling: null,
          nextSibling: null,
          attributeName: null,
          attributeNamespace: null,
          oldValue: null,
        });
      }
    }
    getElementById(id) {
      const target = String(id);
      let found = null;
      walkElements(this, el => {
        if (el.id === target) { found = el; return false; }
      });
      return found;
    }
    getElementsByTagName(tag) {
      const want = String(tag).toLowerCase();
      const out = [];
      walkElements(this, el => {
        if (want === '*' || el.localName === want) out.push(el);
      });
      return out;
    }
    getElementsByClassName(names) {
      const wants = String(names).trim().split(/\\s+/).filter(Boolean);
      if (!wants.length) return [];
      const out = [];
      walkElements(this, el => {
        const cls = (el.getAttribute('class') || '').trim().split(/\\s+/);
        if (wants.every(w => cls.includes(w))) out.push(el);
      });
      return out;
    }
    querySelector(selector) {
      const list = compileSelectorList(selector);
      let found = null;
      walkElements(this, el => {
        if (matchesSelectorList(el, list)) { found = el; return false; }
      });
      return found;
    }
    querySelectorAll(selector) {
      const list = compileSelectorList(selector);
      const out = [];
      walkElements(this, el => {
        if (matchesSelectorList(el, list)) out.push(el);
      });
      return out;
    }
  }

  class DocumentFragment extends ParentNodeBase {
    constructor(ownerDocument = null) {
      super(11, '#document-fragment', ownerDocument);
    }
    cloneNode(deep = false) {
      const frag = new DocumentFragment(this.ownerDocument);
      if (deep) {
        for (const ch of this._childNodes) frag.appendChild(ch.cloneNode(true));
      }
      return frag;
    }
  }

  class Element extends ParentNodeBase {
    constructor(tagName, ownerDocument = null) {
      const lower = String(tagName).toLowerCase();
      super(1, lower.toUpperCase(), ownerDocument);
      this.localName = lower;
      this.tagName = lower.toUpperCase();
      this._attrs = new Map();
      this._style = createStyleObject();
      this._classList = null;
      this._dataset = null;
      this._dirtyValue = false;
      this._value = '';
      this._dirtyChecked = false;
      this._checked = false;
      this._dirtySelected = false;
      this._selected = false;
    }
    get previousElementSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode._childNodes;
      for (let i = siblings.indexOf(this) - 1; i >= 0; i--) {
        if (siblings[i].nodeType === 1) return siblings[i];
      }
      return null;
    }
    get nextElementSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode._childNodes;
      const idx = siblings.indexOf(this);
      if (idx < 0) return null;
      for (let i = idx + 1; i < siblings.length; i++) {
        if (siblings[i].nodeType === 1) return siblings[i];
      }
      return null;
    }
    get style() { return this._style; }
    get classList() {
      if (!this._classList) this._classList = new DOMTokenList(this);
      return this._classList;
    }
    get dataset() {
      if (!this._dataset) this._dataset = createDatasetProxy(this);
      return this._dataset;
    }
    get attributes() {
      const out = [];
      for (const [name, value] of this._serializedAttrEntries()) {
        out.push({name, value});
      }
      return out;
    }
    getAttributeNames() {
      return this._serializedAttrEntries().map(([k]) => k);
    }
    getAttribute(name) {
      const k = String(name).toLowerCase();
      if (k === 'style') {
        const css = this._style.cssText;
        if (css) return css;
        return this._attrs.has('style') ? this._attrs.get('style') : null;
      }
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    setAttribute(name, value) {
      const k = String(name).toLowerCase();
      const v = String(value);
      const oldValue = this.getAttribute(k);
      this._attrs.set(k, v);
      if (k === 'style') {
        this._style.cssText = v;
      } else if (k === 'value' && !this._dirtyValue) {
        this._value = v;
      } else if (k === 'checked' && !this._dirtyChecked) {
        this._checked = true;
      } else if (k === 'selected' && !this._dirtySelected) {
        this._selected = true;
      }
      notifyMutation({
        type: 'attributes',
        target: this,
        addedNodes: [],
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
        attributeName: k,
        attributeNamespace: null,
        oldValue,
      });
    }
    removeAttribute(name) {
      const k = String(name).toLowerCase();
      const had = this.hasAttribute(k);
      const oldValue = had ? this.getAttribute(k) : null;
      this._attrs.delete(k);
      if (k === 'style') {
        for (const prop of Object.keys(this._style)) delete this._style[prop];
      } else if (k === 'checked' && !this._dirtyChecked) {
        this._checked = false;
      } else if (k === 'selected' && !this._dirtySelected) {
        this._selected = false;
      }
      if (had) {
        notifyMutation({
          type: 'attributes',
          target: this,
          addedNodes: [],
          removedNodes: [],
          previousSibling: null,
          nextSibling: null,
          attributeName: k,
          attributeNamespace: null,
          oldValue,
        });
      }
    }
    hasAttribute(name) {
      const k = String(name).toLowerCase();
      if (k === 'style') return this._attrs.has('style') || Boolean(this._style.cssText);
      return this._attrs.has(k);
    }
    toggleAttribute(name, force) {
      const k = String(name).toLowerCase();
      const has = this.hasAttribute(k);
      if (force === true || (force === undefined && !has)) {
        this.setAttribute(k, '');
        return true;
      }
      if (force === false || (force === undefined && has)) {
        this.removeAttribute(k);
        return false;
      }
      return this.hasAttribute(k);
    }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(v) { this.setAttribute('class', v); }
    get name() { return this.getAttribute('name') ?? ''; }
    set name(v) { this.setAttribute('name', v); }
    get type() {
      const attr = this.getAttribute('type');
      if (attr !== null) return attr.toLowerCase();
      if (this.localName === 'input') return 'text';
      if (this.localName === 'button') return 'submit';
      return '';
    }
    set type(v) { this.setAttribute('type', v); }
    get href() { return this.getAttribute('href') ?? ''; }
    set href(v) { this.setAttribute('href', v); }
    get src() { return this.getAttribute('src') ?? ''; }
    set src(v) { this.setAttribute('src', v); }
    get alt() { return this.getAttribute('alt') ?? ''; }
    set alt(v) { this.setAttribute('alt', v); }
    get placeholder() { return this.getAttribute('placeholder') ?? ''; }
    set placeholder(v) { this.setAttribute('placeholder', v); }
    get title() { return this.getAttribute('title') ?? ''; }
    set title(v) { this.setAttribute('title', v); }
    get role() { return this.getAttribute('role') ?? ''; }
    set role(v) { this.setAttribute('role', v); }
    get htmlFor() { return this.getAttribute('for') ?? ''; }
    set htmlFor(v) { this.setAttribute('for', v); }
    get tabIndex() {
      const v = this.getAttribute('tabindex');
      return v === null ? -1 : parseInt(v, 10) || 0;
    }
    set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get readOnly() { return this.hasAttribute('readonly'); }
    set readOnly(v) { if (v) this.setAttribute('readonly', ''); else this.removeAttribute('readonly'); }
    get required() { return this.hasAttribute('required'); }
    set required(v) { if (v) this.setAttribute('required', ''); else this.removeAttribute('required'); }
    get checked() {
      return this._dirtyChecked ? this._checked : this.hasAttribute('checked');
    }
    set checked(v) {
      this._dirtyChecked = true;
      this._checked = Boolean(v);
    }
    get selected() {
      return this._dirtySelected ? this._selected : this.hasAttribute('selected');
    }
    set selected(v) {
      this._dirtySelected = true;
      this._selected = Boolean(v);
    }
    get value() {
      if (this.localName === 'select') {
        const opts = this.querySelectorAll('option');
        const sel = opts.find(o => o.selected) || opts[0];
        return sel ? sel.value : '';
      }
      if (this.localName === 'option') {
        return this._attrs.has('value') ? this._attrs.get('value') : this.textContent;
      }
      if (this.localName === 'textarea') {
        return this._dirtyValue ? this._value : this.textContent;
      }
      return this._dirtyValue ? this._value : (this._attrs.get('value') ?? '');
    }
    set value(v) {
      const str = v === null || v === undefined ? '' : String(v);
      if (this.localName === 'select') {
        const opts = this.querySelectorAll('option');
        for (const o of opts) o.selected = (o.value === str);
        return;
      }
      this._dirtyValue = true;
      this._value = str;
    }
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
    _serializedAttrEntries() {
      const entries = [];
      let sawStyle = false;
      const css = this._style.cssText;
      for (const [k, v] of this._attrs.entries()) {
        if (k === 'style') {
          sawStyle = true;
          if (css) entries.push(['style', css]);
          else if (v) entries.push(['style', v]);
        } else {
          entries.push([k, v]);
        }
      }
      if (!sawStyle && css) entries.push(['style', css]);
      return entries;
    }
    get innerHTML() {
      return serializeChildren(this);
    }
    set innerHTML(html) {
      const removed = this._childNodes.slice();
      for (const ch of removed) ch.parentNode = null;
      this._childNodes.length = 0;
      const frag = parseHtmlFragment(String(html ?? ''), this.ownerDocument);
      const added = frag._childNodes.slice();
      frag._childNodes.length = 0;
      for (const ch of added) {
        ch.parentNode = this;
        if (this.ownerDocument) setOwnerDoc(ch, this.ownerDocument);
        this._childNodes.push(ch);
      }
      if (removed.length || added.length) {
        notifyMutation({
          type: 'childList',
          target: this,
          addedNodes: added,
          removedNodes: removed,
          previousSibling: null,
          nextSibling: null,
          attributeName: null,
          attributeNamespace: null,
          oldValue: null,
        });
      }
    }
    get outerHTML() {
      return serializeNode(this);
    }
    set outerHTML(html) {
      if (!this.parentNode) return;
      const frag = parseHtmlFragment(String(html ?? ''), this.ownerDocument);
      this.parentNode.replaceChild(frag, this);
    }
    insertAdjacentHTML(position, html) {
      const pos = String(position).toLowerCase();
      const frag = parseHtmlFragment(String(html ?? ''), this.ownerDocument);
      if (pos === 'beforebegin') {
        if (this.parentNode) this.parentNode.insertBefore(frag, this);
      } else if (pos === 'afterbegin') {
        this.insertBefore(frag, this.firstChild);
      } else if (pos === 'beforeend') {
        this.appendChild(frag);
      } else if (pos === 'afterend') {
        if (this.parentNode) this.parentNode.insertBefore(frag, this.nextSibling);
      } else {
        throw new SyntaxError('Invalid insertAdjacentHTML position: ' + position);
      }
    }
    before(...nodes) {
      if (!this.parentNode) return;
      for (const n of coerceToNodes(nodes, this.ownerDocument)) this.parentNode.insertBefore(n, this);
    }
    after(...nodes) {
      if (!this.parentNode) return;
      const next = this.nextSibling;
      for (const n of coerceToNodes(nodes, this.ownerDocument)) this.parentNode.insertBefore(n, next);
    }
    replaceWith(...nodes) {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      const next = this.nextSibling;
      parent.removeChild(this);
      for (const n of coerceToNodes(nodes, this.ownerDocument)) parent.insertBefore(n, next);
    }
    matches(selector) {
      return matchesSelectorList(this, compileSelectorList(selector));
    }
    closest(selector) {
      const list = compileSelectorList(selector);
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (matchesSelectorList(cur, list)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    focus() {
      const doc = this.ownerDocument;
      if (doc) {
        const prev = doc.activeElement;
        if (prev && prev !== this) {
          prev.dispatchEvent(new FocusEvent('blur', {bubbles: false, relatedTarget: this}));
          prev.dispatchEvent(new FocusEvent('focusout', {bubbles: true, relatedTarget: this}));
        }
        doc._activeElement = this;
      }
      this.dispatchEvent(new FocusEvent('focus', {bubbles: false}));
      this.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
    }
    blur() {
      const doc = this.ownerDocument;
      if (doc && doc._activeElement === this) {
        doc._activeElement = doc.body;
      }
      this.dispatchEvent(new FocusEvent('blur', {bubbles: false}));
      this.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
    }
    click() {
      if (this.disabled) return;
      let revertCheck = null;
      if (this.localName === 'input' && this.type === 'checkbox') {
        const prev = this.checked;
        this.checked = !prev;
        revertCheck = () => { this.checked = prev; };
      } else if (this.localName === 'input' && this.type === 'radio') {
        const prev = this.checked;
        const form = this.closest('form') || this.ownerDocument;
        if (this.name && form) {
          for (const r of form.querySelectorAll('input[type="radio"]')) {
            if (r.name === this.name) r.checked = false;
          }
        }
        this.checked = true;
        revertCheck = () => { this.checked = prev; };
      }
      const ev = new MouseEvent('click', {bubbles: true, cancelable: true});
      const notPrevented = this.dispatchEvent(ev);
      if (!notPrevented && revertCheck) {
        revertCheck();
        return;
      }
      if (notPrevented && ((this.localName === 'button' && this.type === 'submit') ||
          (this.localName === 'input' && this.type === 'submit'))) {
        const form = this.closest('form');
        if (form) form.requestSubmit(this);
      }
    }
    requestSubmit(submitter = null) {
      if (this.localName !== 'form') return;
      const ev = new SubmitEvent('submit', {bubbles: true, cancelable: true, submitter});
      this.dispatchEvent(ev);
    }
    submit() {
      this.requestSubmit(null);
    }
    getBoundingClientRect() {
      const parsePx = v => {
        if (typeof v !== 'string' || !v) return 0;
        const m = /^(-?\\d+(?:\\.\\d+)?)px$/i.exec(v.trim());
        return m ? Number(m[1]) : 0;
      };
      const x = parsePx(this._style.left);
      const y = parsePx(this._style.top);
      const width = parsePx(this._style.width);
      const height = parsePx(this._style.height);
      const right = x + width;
      const bottom = y + height;
      return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right,
        bottom,
        toJSON() {
          return {x, y, width, height, top: y, left: x, right, bottom};
        },
      };
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
    cloneNode(deep = false) {
      const copy = new HTMLElement(this.localName, this.ownerDocument);
      for (const [k, v] of this._attrs.entries()) copy._attrs.set(k, v);
      for (const [k, v] of Object.entries(this._style)) copy._style[k] = v;
      copy._dirtyValue = this._dirtyValue;
      copy._value = this._value;
      copy._dirtyChecked = this._dirtyChecked;
      copy._checked = this._checked;
      copy._dirtySelected = this._dirtySelected;
      copy._selected = this._selected;
      if (deep) {
        for (const ch of this._childNodes) copy.appendChild(ch.cloneNode(true));
      }
      return copy;
    }
  }

  class HTMLElement extends Element {}

  class Document extends ParentNodeBase {
    constructor() {
      super(9, '#document', null);
      this.readyState = 'complete';
      this.defaultView = globalThis;
      this._activeElement = null;
    }
    get documentElement() {
      return this.firstElementChild;
    }
    get head() {
      const html = this.documentElement;
      if (!html) return null;
      for (const ch of html._childNodes) if (ch.nodeType === 1 && ch.localName === 'head') return ch;
      return null;
    }
    get body() {
      const html = this.documentElement;
      if (!html) return null;
      for (const ch of html._childNodes) if (ch.nodeType === 1 && ch.localName === 'body') return ch;
      return null;
    }
    get title() {
      const head = this.head;
      const t = head ? head.querySelector('title') : this.querySelector('title');
      return t ? t.textContent : '';
    }
    set title(val) {
      const text = val === null || val === undefined ? '' : String(val);
      let t = this.querySelector('title');
      if (!t) {
        t = this.createElement('title');
        const head = this.head || this.documentElement;
        if (head) head.appendChild(t);
      }
      t.textContent = text;
    }
    get activeElement() {
      return this._activeElement || this.body;
    }
    get location() {
      return globalThis.location;
    }
    createElement(tagName) {
      return new HTMLElement(tagName, this);
    }
    createElementNS(_ns, tagName) {
      return new HTMLElement(tagName, this);
    }
    createTextNode(text) {
      return new Text(text, this);
    }
    createComment(text) {
      return new Comment(text, this);
    }
    createDocumentFragment() {
      return new DocumentFragment(this);
    }
    cloneNode(deep = false) {
      const d = new Document();
      if (deep) {
        for (const ch of this._childNodes) d.appendChild(ch.cloneNode(true));
      }
      return d;
    }
  }

  // ==================== HTML Serializer & Parser ====================
  function serializeNode(node) {
    if (node.nodeType === 3) return escapeText(node._data);
    if (node.nodeType === 8) return '<!--' + node._data + '-->';
    if (node.nodeType === 11 || node.nodeType === 9) return serializeChildren(node);
    if (node.nodeType === 1) {
      let out = '<' + node.localName;
      for (const [k, v] of node._serializedAttrEntries()) {
        out += ' ' + k + '="' + escapeAttr(v) + '"';
      }
      out += '>';
      if (VOID_TAGS.has(node.localName)) return out;
      out += serializeChildren(node);
      out += '</' + node.localName + '>';
      return out;
    }
    return '';
  }

  function serializeChildren(node) {
    let out = '';
    for (const ch of node._childNodes) out += serializeNode(ch);
    return out;
  }

  function parseHtmlFragment(html, ownerDoc) {
    const frag = new DocumentFragment(ownerDoc);
    const stack = [frag];
    const len = html.length;
    let i = 0;

    function currentParent() {
      return stack[stack.length - 1];
    }

    function appendText(raw) {
      if (!raw) return;
      const decoded = decodeEntities(raw);
      if (decoded.length > 0) {
        currentParent().appendChild(new Text(decoded, ownerDoc));
      }
    }

    while (i < len) {
      const lt = html.indexOf('<', i);
      if (lt === -1) {
        appendText(html.slice(i));
        break;
      }
      if (lt > i) {
        appendText(html.slice(i, lt));
      }
      // Comment <!-- ... -->
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        if (end === -1) {
          currentParent().appendChild(new Comment(html.slice(lt + 4), ownerDoc));
          break;
        }
        currentParent().appendChild(new Comment(html.slice(lt + 4, end), ownerDoc));
        i = end + 3;
        continue;
      }
      // Doctype or declaration <! ... >
      if (html.startsWith('<!', lt)) {
        const end = html.indexOf('>', lt + 2);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      // Closing tag </tag>
      if (html[lt + 1] === '/') {
        const end = html.indexOf('>', lt + 2);
        if (end === -1) break;
        const closeTag = html.slice(lt + 2, end).trim().toLowerCase();
        for (let s = stack.length - 1; s >= 1; s--) {
          if (stack[s].localName === closeTag) {
            stack.length = s;
            break;
          }
        }
        i = end + 1;
        continue;
      }
      // Opening tag <tag ...>
      let p = lt + 1;
      let tagStart = p;
      while (p < len && /[A-Za-z0-9:_-]/.test(html[p])) p++;
      if (p === tagStart) {
        appendText('<');
        i = lt + 1;
        continue;
      }
      const tag = html.slice(tagStart, p).toLowerCase();
      // Implicitly close sibling tags if needed (e.g. <p>a<p>b, <li>1<li>2)
      if (stack.length > 1) {
        const top = stack[stack.length - 1];
        const closers = AUTO_CLOSE_SIBLINGS[top.localName];
        if (closers && closers.has(tag)) stack.pop();
      }
      const el = new HTMLElement(tag, ownerDoc);
      let selfClosing = false;
      while (p < len) {
        while (p < len && /\\s/.test(html[p])) p++;
        if (p >= len) break;
        if (html[p] === '>') { p++; break; }
        if (html[p] === '/' && html[p + 1] === '>') { selfClosing = true; p += 2; break; }
        let aStart = p;
        while (p < len && !/[\\s=/>]/.test(html[p])) p++;
        if (p === aStart) { p++; continue; }
        const attrName = html.slice(aStart, p).toLowerCase();
        while (p < len && /\\s/.test(html[p])) p++;
        let attrVal = '';
        if (html[p] === '=') {
          p++;
          while (p < len && /\\s/.test(html[p])) p++;
          if (html[p] === '"' || html[p] === "'") {
            const q = html[p++];
            let vStart = p;
            while (p < len && html[p] !== q) p++;
            attrVal = decodeEntities(html.slice(vStart, p));
            if (html[p] === q) p++;
          } else {
            let vStart = p;
            while (p < len && !/[\\s>]/.test(html[p]) && !(html[p] === '/' && html[p + 1] === '>')) p++;
            attrVal = decodeEntities(html.slice(vStart, p));
          }
        }
        el.setAttribute(attrName, attrVal);
      }
      currentParent().appendChild(el);
      i = p;

      if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
        const closeRe = new RegExp('</' + tag + '\\\\s*>', 'i');
        const rest = html.slice(i);
        const m = closeRe.exec(rest);
        if (m) {
          const raw = rest.slice(0, m.index);
          if (raw.length) el.appendChild(new Text(tag === 'title' || tag === 'textarea' ? decodeEntities(raw) : raw, ownerDoc));
          i += m.index + m[0].length;
        } else {
          if (rest.length) el.appendChild(new Text(rest, ownerDoc));
          i = len;
        }
        continue;
      }

      if (!selfClosing && !VOID_TAGS.has(tag)) {
        stack.push(el);
      }
    }
    return frag;
  }

  function parseHtmlDocument(html) {
    const doc = new Document();
    const raw = String(html ?? '');
    const frag = parseHtmlFragment(raw, doc);
    let htmlEl = null;
    for (const ch of frag._childNodes) {
      if (ch.nodeType === 1 && ch.localName === 'html') { htmlEl = ch; break; }
    }
    if (htmlEl) {
      doc.appendChild(htmlEl);
      if (!doc.head) {
        const h = doc.createElement('head');
        htmlEl.insertBefore(h, htmlEl.firstChild);
      }
      if (!doc.body) {
        htmlEl.appendChild(doc.createElement('body'));
      }
    } else {
      htmlEl = doc.createElement('html');
      const head = doc.createElement('head');
      const body = doc.createElement('body');
      for (const ch of frag._childNodes.slice()) {
        if (ch.nodeType === 1 && ch.localName === 'head') {
          for (const hc of ch._childNodes.slice()) head.appendChild(hc);
        } else if (ch.nodeType === 1 && ch.localName === 'body') {
          for (const bc of ch._childNodes.slice()) body.appendChild(bc);
        } else {
          body.appendChild(ch);
        }
      }
      htmlEl.appendChild(head);
      htmlEl.appendChild(body);
      doc.appendChild(htmlEl);
    }
    return doc;
  }

  class DOMParser {
    parseFromString(str, type = 'text/html') {
      const mime = String(type || 'text/html').toLowerCase().trim();
      if (mime === 'text/xml' || mime === 'application/xml' || mime === 'application/xhtml+xml' || mime === 'image/svg+xml') {
        const doc = new Document();
        const frag = parseHtmlFragment(String(str ?? ''), doc);
        for (const ch of frag._childNodes.slice()) {
          if (ch.nodeType === 1) {
            doc.appendChild(ch);
            break;
          }
        }
        return doc;
      }
      return parseHtmlDocument(str);
    }
  }

  // ==================== FormData ====================
  function isInDisabledFieldset(el, stopAt) {
    let cur = el.parentElement;
    while (cur && cur !== stopAt) {
      if (cur.localName === 'fieldset' && cur.disabled) {
        const firstLegend = cur.children.find(c => c.localName === 'legend');
        if (!firstLegend || !firstLegend.contains(el)) return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  class FormData {
    constructor(formElement) {
      this._entries = [];
      if (formElement !== undefined && formElement !== null) {
        if (!(formElement instanceof Element)) {
          throw new TypeError('FormData argument must be an HTMLFormElement');
        }
        walkElements(formElement, el => {
          const tag = el.localName;
          if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return;
          if (el.disabled || !el.name || isInDisabledFieldset(el, formElement)) return;
          if (tag === 'input') {
            const t = el.type;
            if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return;
            if (t === 'checkbox' || t === 'radio') {
              if (!el.checked) return;
              const val = (el._dirtyValue || el.hasAttribute('value')) ? el.value : 'on';
              this._entries.push([el.name, val]);
              return;
            }
            this._entries.push([el.name, el.value]);
          } else if (tag === 'textarea') {
            this._entries.push([el.name, el.value]);
          } else if (tag === 'select') {
            const opts = el.querySelectorAll('option');
            if (el.hasAttribute('multiple')) {
              for (const opt of opts) {
                if (opt.selected && !opt.disabled) {
                  this._entries.push([el.name, opt.value]);
                }
              }
            } else {
              const selected = opts.find(o => o.selected && !o.disabled) || opts.find(o => !o.disabled);
              if (selected) this._entries.push([el.name, selected.value]);
            }
          }
        });
      }
    }
    append(name, value) {
      this._entries.push([String(name), String(value)]);
    }
    set(name, value) {
      const k = String(name);
      const v = String(value);
      let replaced = false;
      const next = [];
      for (const entry of this._entries) {
        if (entry[0] === k) {
          if (!replaced) {
            next.push([k, v]);
            replaced = true;
          }
        } else {
          next.push(entry);
        }
      }
      if (!replaced) next.push([k, v]);
      this._entries = next;
    }
    get(name) {
      const k = String(name);
      for (const entry of this._entries) {
        if (entry[0] === k) return entry[1];
      }
      return null;
    }
    getAll(name) {
      const k = String(name);
      const out = [];
      for (const entry of this._entries) {
        if (entry[0] === k) out.push(entry[1]);
      }
      return out;
    }
    has(name) {
      const k = String(name);
      return this._entries.some(entry => entry[0] === k);
    }
    delete(name) {
      const k = String(name);
      this._entries = this._entries.filter(entry => entry[0] !== k);
    }
    entries() {
      return this._entries.map(e => [e[0], e[1]])[Symbol.iterator]();
    }
    keys() {
      return this._entries.map(e => e[0])[Symbol.iterator]();
    }
    values() {
      return this._entries.map(e => e[1])[Symbol.iterator]();
    }
    forEach(cb, thisArg) {
      for (const [k, v] of this._entries.slice()) {
        cb.call(thisArg, v, k, this);
      }
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }

  // ==================== Observers (MutationObserver, ResizeObserver, IntersectionObserver) ====================
  class MutationObserver {
    constructor(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('MutationObserver callback must be a function');
      }
      this._callback = callback;
      this._registrations = [];
      this._records = [];
      this._scheduled = false;
    }
    observe(target, options = {}) {
      if (!(target instanceof Node)) {
        throw new TypeError('MutationObserver.observe target must be a Node');
      }
      const opts = options && typeof options === 'object' ? options : {};
      const attributes = opts.attributes !== undefined
        ? Boolean(opts.attributes)
        : Boolean(opts.attributeOldValue || opts.attributeFilter);
      const characterData = opts.characterData !== undefined
        ? Boolean(opts.characterData)
        : Boolean(opts.characterDataOldValue);
      const childList = Boolean(opts.childList);
      if (!attributes && !characterData && !childList) {
        throw new TypeError('MutationObserver.observe requires at least one of childList, attributes, or characterData');
      }
      const normalized = {
        childList,
        attributes,
        characterData,
        subtree: Boolean(opts.subtree),
        attributeOldValue: Boolean(opts.attributeOldValue),
        characterDataOldValue: Boolean(opts.characterDataOldValue),
        attributeFilter: Array.isArray(opts.attributeFilter)
          ? opts.attributeFilter.map(a => String(a).toLowerCase())
          : null,
      };
      const existing = this._registrations.find(r => r.target === target);
      if (existing) existing.options = normalized;
      else this._registrations.push({target, options: normalized});
      activeMutationObservers.add(this);
    }
    disconnect() {
      this._registrations.length = 0;
      this._records.length = 0;
      this._scheduled = false;
      activeMutationObservers.delete(this);
    }
    takeRecords() {
      const out = this._records.slice();
      this._records.length = 0;
      return out;
    }
    _enqueueIfMatched(record) {
      let matchedOpts = null;
      for (const reg of this._registrations) {
        const direct = reg.target === record.target;
        const inSubtree = !direct && reg.options.subtree && reg.target.contains(record.target);
        if (!direct && !inSubtree) continue;
        if (record.type === 'childList' && !reg.options.childList) continue;
        if (record.type === 'characterData' && !reg.options.characterData) continue;
        if (record.type === 'attributes') {
          if (!reg.options.attributes) continue;
          if (reg.options.attributeFilter && !reg.options.attributeFilter.includes(record.attributeName)) continue;
        }
        matchedOpts = reg.options;
        break;
      }
      if (!matchedOpts) return;
      const delivered = {
        type: record.type,
        target: record.target,
        addedNodes: record.addedNodes.slice(),
        removedNodes: record.removedNodes.slice(),
        previousSibling: record.previousSibling,
        nextSibling: record.nextSibling,
        attributeName: record.attributeName,
        attributeNamespace: record.attributeNamespace,
        oldValue: (record.type === 'attributes' && matchedOpts.attributeOldValue) ||
          (record.type === 'characterData' && matchedOpts.characterDataOldValue)
          ? record.oldValue
          : null,
      };
      this._records.push(delivered);
      if (!this._scheduled) {
        this._scheduled = true;
        scheduleMicrotaskDeterministic(() => {
          this._scheduled = false;
          if (!this._records.length) return;
          const batch = this.takeRecords();
          this._callback.call(this, batch, this);
        });
      }
    }
  }

  class ResizeObserver {
    constructor(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('ResizeObserver callback must be a function');
      }
      this._callback = callback;
      this._targets = new Set();
    }
    observe(target) {
      if (!(target instanceof Element)) throw new TypeError('ResizeObserver.observe target must be an Element');
      if (this._targets.has(target)) return;
      this._targets.add(target);
      scheduleMicrotaskDeterministic(() => {
        if (!this._targets.has(target)) return;
        const rect = target.getBoundingClientRect();
        const box = [{inlineSize: rect.width, blockSize: rect.height}];
        this._callback.call(this, [{
          target,
          contentRect: rect,
          borderBoxSize: box,
          contentBoxSize: box,
        }], this);
      });
    }
    unobserve(target) {
      this._targets.delete(target);
    }
    disconnect() {
      this._targets.clear();
    }
  }

  class IntersectionObserver {
    constructor(callback, options = {}) {
      if (typeof callback !== 'function') {
        throw new TypeError('IntersectionObserver callback must be a function');
      }
      const opts = options && typeof options === 'object' ? options : {};
      this._callback = callback;
      this.root = opts.root ?? null;
      this.rootMargin = opts.rootMargin ?? '0px 0px 0px 0px';
      this.thresholds = Array.isArray(opts.threshold)
        ? opts.threshold.map(Number)
        : [opts.threshold !== undefined ? Number(opts.threshold) : 0];
      this._targets = new Set();
      this._records = [];
    }
    observe(target) {
      if (!(target instanceof Element)) throw new TypeError('IntersectionObserver.observe target must be an Element');
      if (this._targets.has(target)) return;
      this._targets.add(target);
      scheduleMicrotaskDeterministic(() => {
        if (!this._targets.has(target)) return;
        const rect = target.getBoundingClientRect();
        const visible = target.isConnected && !target.hidden && target._style.display !== 'none';
        const entry = {
          target,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
          boundingClientRect: rect,
          intersectionRect: visible ? rect : {x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0},
          rootBounds: this.root && typeof this.root.getBoundingClientRect === 'function' ? this.root.getBoundingClientRect() : null,
          time: virtualNow,
        };
        this._callback.call(this, [entry], this);
      });
    }
    unobserve(target) {
      this._targets.delete(target);
    }
    disconnect() {
      this._targets.clear();
      this._records.length = 0;
    }
    takeRecords() {
      const out = this._records.slice();
      this._records.length = 0;
      return out;
    }
  }

  // ==================== getComputedStyle ====================
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog',
    'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main',
    'nav', 'ol', 'p', 'pre', 'section', 'summary', 'ul',
  ]);
  const INLINE_BLOCK_TAGS = new Set(['button', 'img', 'input', 'select', 'textarea']);
  const HIDDEN_TAGS = new Set(['head', 'link', 'meta', 'script', 'style', 'template', 'title']);

  function getComputedStyle(el, _pseudoElt) {
    if (!(el instanceof Element)) {
      throw new TypeError('getComputedStyle expects an Element');
    }
    const computed = createStyleObject();
    let defaultDisplay = 'inline';
    if (el.hidden || HIDDEN_TAGS.has(el.localName)) defaultDisplay = 'none';
    else if (BLOCK_TAGS.has(el.localName)) defaultDisplay = 'block';
    else if (INLINE_BLOCK_TAGS.has(el.localName)) defaultDisplay = 'inline-block';
    else if (el.localName === 'table') defaultDisplay = 'table';
    else if (el.localName === 'tr') defaultDisplay = 'table-row';
    else if (el.localName === 'td' || el.localName === 'th') defaultDisplay = 'table-cell';
    computed.display = defaultDisplay;
    computed.visibility = 'visible';
    for (const [k, v] of Object.entries(el._style)) {
      if (v !== undefined && v !== null && v !== '') computed[k] = String(v);
    }
    return computed;
  }

  // ==================== Location & History ====================
  const initialUrlStr = typeof globalThis.__browserInitialUrl === 'string' && globalThis.__browserInitialUrl
    ? globalThis.__browserInitialUrl
    : 'https://app.example.test/';
  let currentUrl = new URL(initialUrlStr);
  const historyStack = [{url: currentUrl.href, state: null}];
  let historyIndex = 0;

  function setCurrentUrl(nextHref, dispatchHash = false) {
    const prevHash = currentUrl.hash;
    currentUrl = new URL(nextHref, currentUrl.href);
    if (dispatchHash && currentUrl.hash !== prevHash) {
      globalThis.dispatchEvent(new Event('hashchange', {bubbles: false}));
    }
  }

  const locationObj = {
    get href() { return currentUrl.href; },
    set href(v) { locationObj.assign(v); },
    get origin() { return currentUrl.origin; },
    get protocol() { return currentUrl.protocol; },
    get host() { return currentUrl.host; },
    get hostname() { return currentUrl.hostname; },
    get port() { return currentUrl.port; },
    get pathname() { return currentUrl.pathname; },
    set pathname(v) {
      const next = new URL(currentUrl.href);
      next.pathname = String(v);
      locationObj.assign(next.href);
    },
    get search() { return currentUrl.search; },
    set search(v) {
      const next = new URL(currentUrl.href);
      next.search = String(v);
      locationObj.assign(next.href);
    },
    get hash() { return currentUrl.hash; },
    set hash(v) {
      const next = new URL(currentUrl.href);
      next.hash = String(v);
      setCurrentUrl(next.href, true);
      historyStack[historyIndex] = {url: currentUrl.href, state: historyStack[historyIndex].state};
    },
    assign(url) {
      const resolved = new URL(String(url), currentUrl.href).href;
      historyStack.length = historyIndex + 1;
      historyStack.push({url: resolved, state: null});
      historyIndex = historyStack.length - 1;
      setCurrentUrl(resolved, true);
    },
    replace(url) {
      const resolved = new URL(String(url), currentUrl.href).href;
      historyStack[historyIndex] = {url: resolved, state: historyStack[historyIndex].state};
      setCurrentUrl(resolved, true);
    },
    toString() { return currentUrl.href; },
  };

  const historyObj = {
    get length() { return historyStack.length; },
    get state() {
      const s = historyStack[historyIndex].state;
      return s === null ? null : structuredClone(s);
    },
    pushState(state, _unused, url) {
      const resolved = url !== undefined && url !== null && String(url) !== ''
        ? new URL(String(url), currentUrl.href).href
        : currentUrl.href;
      historyStack.length = historyIndex + 1;
      historyStack.push({url: resolved, state: state === undefined ? null : structuredClone(state)});
      historyIndex = historyStack.length - 1;
      currentUrl = new URL(resolved);
    },
    replaceState(state, _unused, url) {
      const resolved = url !== undefined && url !== null && String(url) !== ''
        ? new URL(String(url), currentUrl.href).href
        : currentUrl.href;
      historyStack[historyIndex] = {url: resolved, state: state === undefined ? null : structuredClone(state)};
      currentUrl = new URL(resolved);
    },
    go(delta = 0) {
      const d = Number(delta) || 0;
      const targetIdx = historyIndex + d;
      if (targetIdx < 0 || targetIdx >= historyStack.length || targetIdx === historyIndex) return;
      historyIndex = targetIdx;
      currentUrl = new URL(historyStack[historyIndex].url);
      const st = historyStack[historyIndex].state;
      globalThis.dispatchEvent(new PopStateEvent('popstate', {
        bubbles: false,
        state: st === null ? null : structuredClone(st),
      }));
    },
    back() { historyObj.go(-1); },
    forward() { historyObj.go(1); },
  };

  // ==================== Storage & Dialog External Tools ====================
  function makeStorage(area) {
    return {
      getItem(key) {
        const res = globalThis.__browserInvoke('browser.storageGet', [area, String(key)]);
        return res === null || res === undefined ? null : String(res);
      },
      setItem(key, value) {
        globalThis.__browserInvoke('browser.storageSet', [area, String(key), String(value)]);
      },
      removeItem(key) {
        globalThis.__browserInvoke('browser.storageRemove', [area, String(key)]);
      },
      clear() {
        globalThis.__browserInvoke('browser.storageClear', [area]);
      },
    };
  }

  const localStorageObj = makeStorage('local');
  const sessionStorageObj = makeStorage('session');

  function browserAlert(message) {
    globalThis.__browserInvoke('browser.alert', [message === undefined ? '' : String(message)]);
  }
  function browserConfirm(message) {
    return Boolean(globalThis.__browserInvoke('browser.confirm', [message === undefined ? '' : String(message)]));
  }
  function browserPrompt(message, defaultValue) {
    const res = globalThis.__browserInvoke('browser.prompt', [
      message === undefined ? '' : String(message),
      defaultValue === undefined ? '' : String(defaultValue),
    ]);
    return res === null || res === undefined ? null : String(res);
  }

  // ==================== Deterministic Virtual Timers ====================
  let virtualNow = 0;
  let nextTimerId = 1;
  let nextTimerSeq = 1;
  const timers = new Map();

  function scheduleTimer(fn, delay, args, isInterval, isRaf) {
    if (typeof fn !== 'function') throw new TypeError('Timer callback must be a function');
    const ms = Math.max(0, Number(delay) || 0);
    const id = nextTimerId++;
    timers.set(id, {
      id,
      seq: nextTimerSeq++,
      fn,
      args,
      delay: ms,
      dueAt: virtualNow + ms,
      isInterval: Boolean(isInterval),
      isRaf: Boolean(isRaf),
    });
    return id;
  }

  function pickNextDueTimer(limitTime) {
    let best = null;
    for (const entry of timers.values()) {
      if (entry.dueAt > limitTime) continue;
      if (!best || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.seq < best.seq)) {
        best = entry;
      }
    }
    return best;
  }

  function fireTimerEntry(entry) {
    timers.delete(entry.id);
    if (entry.dueAt > virtualNow) virtualNow = entry.dueAt;
    if (entry.isInterval) {
      timers.set(entry.id, {
        ...entry,
        seq: nextTimerSeq++,
        dueAt: virtualNow + Math.max(1, entry.delay),
      });
    }
    if (entry.isRaf) return entry.fn.call(globalThis, virtualNow);
    return entry.fn.apply(globalThis, entry.args);
  }

  function flushTimers(maxMs = Infinity) {
    const finiteLimit = Number.isFinite(maxMs) ? virtualNow + Math.max(0, Number(maxMs)) : Infinity;
    let executed = 0;
    const maxExecutions = 10000;
    while (executed < maxExecutions) {
      const next = pickNextDueTimer(finiteLimit);
      if (!next) break;
      if (!Number.isFinite(finiteLimit) && next.isInterval) break;
      fireTimerEntry(next);
      executed++;
    }
    if (Number.isFinite(finiteLimit) && finiteLimit > virtualNow) {
      virtualNow = finiteLimit;
    }
    return {now: virtualNow, executed, pending: timers.size};
  }

  async function flushTimersAsync(maxMs = Infinity) {
    const finiteLimit = Number.isFinite(maxMs) ? virtualNow + Math.max(0, Number(maxMs)) : Infinity;
    let executed = 0;
    const maxExecutions = 10000;
    const drainMicrotasks = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    await drainMicrotasks();
    while (executed < maxExecutions) {
      const next = pickNextDueTimer(finiteLimit);
      if (!next) break;
      if (!Number.isFinite(finiteLimit) && next.isInterval) break;
      const ret = fireTimerEntry(next);
      executed++;
      if (ret && typeof ret.then === 'function') await ret;
      await drainMicrotasks();
    }
    if (Number.isFinite(finiteLimit) && finiteLimit > virtualNow) {
      virtualNow = finiteLimit;
    }
    return {now: virtualNow, executed, pending: timers.size};
  }

  // ==================== Window & Document Wiring ====================
  const windowTarget = new EventTarget();
  globalThis._listeners = windowTarget._listeners;
  globalThis.addEventListener = windowTarget.addEventListener.bind(globalThis);
  globalThis.removeEventListener = windowTarget.removeEventListener.bind(globalThis);
  globalThis.dispatchEvent = event => dispatchEventOn(globalThis, event);

  const initialHtmlStr = typeof globalThis.__browserInitialHtml === 'string' && globalThis.__browserInitialHtml
    ? globalThis.__browserInitialHtml
    : '<!DOCTYPE html><html><head><title>App</title></head><body><div id="app"></div></body></html>';
  const documentObj = parseHtmlDocument(initialHtmlStr);

  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = documentObj;
  globalThis.location = locationObj;
  globalThis.history = historyObj;
  globalThis.localStorage = localStorageObj;
  globalThis.sessionStorage = sessionStorageObj;
  globalThis.alert = browserAlert;
  globalThis.confirm = browserConfirm;
  globalThis.prompt = browserPrompt;

  globalThis.setTimeout = (fn, delay = 0, ...args) => scheduleTimer(fn, delay, args, false, false);
  globalThis.clearTimeout = id => { timers.delete(id); };
  globalThis.setInterval = (fn, delay = 0, ...args) => scheduleTimer(fn, delay, args, true, false);
  globalThis.clearInterval = id => { timers.delete(id); };
  globalThis.requestAnimationFrame = fn => scheduleTimer(fn, 16, [], false, true);
  globalThis.cancelAnimationFrame = id => { timers.delete(id); };
  if (typeof globalThis.queueMicrotask !== 'function') {
    globalThis.queueMicrotask = fn => {
      if (typeof fn !== 'function') throw new TypeError('queueMicrotask expects a function');
      Promise.resolve().then(() => fn());
    };
  }
  globalThis.getComputedStyle = getComputedStyle;
  globalThis.performance = {now: () => virtualNow};
  globalThis.__flushTimers = flushTimers;
  globalThis.__flushTimersAsync = flushTimersAsync;
  globalThis.__virtualNow = () => virtualNow;
  globalThis.__browserHasPendingTimers = () => {
    for (const entry of timers.values()) if (!entry.isInterval) return true;
    return false;
  };
  globalThis.__browserStepNextTimer = () => {
    let best = null;
    for (const entry of timers.values()) {
      if (entry.isInterval) continue;
      if (!best || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.seq < best.seq)) {
        best = entry;
      }
    }
    if (!best) return false;
    fireTimerEntry(best);
    return true;
  };

  globalThis.__snapshotDom = function __snapshotDom(rootOrSelector) {
    let root = documentObj.body || documentObj.documentElement;
    if (typeof rootOrSelector === 'string') {
      root = documentObj.querySelector(rootOrSelector);
    } else if (rootOrSelector && rootOrSelector instanceof Node) {
      root = rootOrSelector;
    }
    return {
      url: locationObj.href,
      title: documentObj.title,
      html: root ? (root.nodeType === 1 ? root.innerHTML : serializeChildren(root)) : '',
    };
  };

  // Expose standard DOM & Event constructors
  globalThis.EventTarget = EventTarget;
  globalThis.Event = Event;
  globalThis.CustomEvent = CustomEvent;
  globalThis.UIEvent = UIEvent;
  globalThis.MouseEvent = MouseEvent;
  globalThis.InputEvent = InputEvent;
  globalThis.KeyboardEvent = KeyboardEvent;
  globalThis.FocusEvent = FocusEvent;
  globalThis.SubmitEvent = SubmitEvent;
  globalThis.PopStateEvent = PopStateEvent;
  globalThis.Node = Node;
  globalThis.Text = Text;
  globalThis.Comment = Comment;
  globalThis.DocumentFragment = DocumentFragment;
  globalThis.Element = Element;
  globalThis.HTMLElement = HTMLElement;
  globalThis.Document = Document;
  globalThis.DOMTokenList = DOMTokenList;
  globalThis.DOMParser = DOMParser;
  globalThis.FormData = FormData;
  globalThis.MutationObserver = MutationObserver;
  globalThis.ResizeObserver = ResizeObserver;
  globalThis.IntersectionObserver = IntersectionObserver;
  globalThis.navigator = {userAgent: 'DeterministicBrowserVM/1.0', language: 'en-US', languages: ['en-US']};
})();`;
