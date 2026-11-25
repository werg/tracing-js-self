// Import supplied agent conversations into readable SFT data.
import {createHash} from 'node:crypto';
import {tokenizer} from 'acorn';
import {exportTinkerExample, normalizedSourceHash} from './tinker-execution.js';

const requireValue = (value, message) => { if (!value) throw new TypeError(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function contentText(message) {
  requireValue(message.content === undefined || message.content === null || typeof message.content === 'string',
    'Agent imports require plain-text message content');
  const content = message.content ?? '';
  requireValue(content.length <= 1048576, 'Agent message exceeds content limit');
  return content;
}

function parseToolCall(call) {
  requireValue(plain(call) && typeof call.id === 'string' && call.id.length > 0,
    'Each tool call needs a distinct routing ID');
  const fn = call.function;
  requireValue(plain(fn) && typeof fn.name === 'string' && /^[A-Za-z_$][\w.$-]*$/.test(fn.name),
    'A tool call needs a function name');
  let args = fn.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { throw new TypeError('Tool-call arguments must be valid JSON'); }
  }
  requireValue(plain(args) && JSON.stringify(args).length <= 262144,
    'Tool-call arguments must be a bounded JSON object');
  return {id: call.id, name: fn.name, arguments: args};
}

function programHashes(source) {
  try {
    const hashes = [normalizedSourceHash(source)];
    hashes.push(normalizedSourceHash('"use strict";\n' + source));
    return hashes;
  } catch {
    try {
      const tokens = [...tokenizer(source, {ecmaVersion: 'latest'})].map(token =>
        [token.type.label, typeof token.value === 'bigint' ? String(token.value) : token.value ?? null]);
      return [digest(['javascript-tool-snippet', tokens])];
    } catch { return [digest(['unparsed-javascript-tool-source', source])]; }
  }
}

/** Normalize actual agent turns without putting tool routing IDs in the text.
 * Supplied assistant decisions are not certified agent-task successes. */
export function readableAgentMessages(trajectory) {
  requireValue(plain(trajectory) && Array.isArray(trajectory.messages) &&
    trajectory.messages.length > 0 && trajectory.messages.length <= 4096,
    'Agent trajectory requires a bounded messages array');
  const names = trajectory.javascriptToolNames ?? ['javascript', 'js', 'execute_javascript', 'run_js', 'eval_js'];
  requireValue(Array.isArray(names) && names.length > 0 && names.every(name => typeof name === 'string' && name),
    'javascriptToolNames must identify the tools carrying JavaScript source');
  const javascriptTools = new Set(names);
  const messages = [], pending = new Map(), seen = new Set(), sourceHashes = new Set();
  let calls = 0, assistants = 0, totalCharacters = 0;
  for (const [index, row] of trajectory.messages.entries()) {
    requireValue(plain(row) && ['system', 'user', 'assistant', 'tool'].includes(row.role),
      'Unsupported agent message role');
    const content = contentText(row);
    totalCharacters += content.length;
    if (row.role === 'system') {
      requireValue(index === 0 && !pending.size, 'System instruction must begin the trajectory');
      messages.push({role: 'system', content, trainable: false});
    } else if (row.role === 'user') {
      requireValue(!pending.size, 'A new user turn cannot precede outstanding tool observations');
      messages.push({role: 'user', content, trainable: false});
    } else if (row.role === 'assistant') {
      requireValue(!pending.size, 'An assistant continuation needs its outstanding observations first');
      const toolCalls = row.tool_calls ?? [];
      requireValue(Array.isArray(toolCalls) && toolCalls.length <= 64, 'Invalid tool-call list');
      const parts = content ? [content] : [];
      for (const raw of toolCalls) {
        const call = parseToolCall(raw);
        requireValue(!seen.has(call.id), 'Tool routing IDs must be unique within a trajectory');
        pending.set(call.id, call); seen.add(call.id); calls++;
        if (javascriptTools.has(call.name)) {
          const source = call.arguments.code ?? call.arguments.source;
          requireValue(typeof source === 'string' && source.trim(), 'JavaScript tool calls require code or source');
          for (const hash of programHashes(source)) sourceHashes.add(hash);
        }
        const rendered = 'Call ' + call.name + ' with arguments:\n' + JSON.stringify(call.arguments);
        totalCharacters += rendered.length;
        parts.push(rendered);
      }
      requireValue(parts.length > 0, 'Empty assistant demonstrations are not useful supervision');
      messages.push({role: 'assistant', content: parts.join('\n'), trainable: true});
      assistants++;
    } else {
      requireValue(typeof row.tool_call_id === 'string' && pending.has(row.tool_call_id),
        'External observation lacks an earlier outstanding call');
      const call = pending.get(row.tool_call_id);
      requireValue(row.name === undefined || row.name === call.name, 'Tool result name differs from its earlier call');
      const context = JSON.stringify(call.arguments);
      totalCharacters += context.length;
      messages.push({role: 'user', content: 'External observation from ' + call.name +
        ' for arguments ' + context + ':\n' + content, trainable: false});
      pending.delete(row.tool_call_id);
    }
    requireValue(totalCharacters <= 8 * 1024 * 1024, 'Agent conversation exceeds content limit');
  }
  requireValue(!pending.size, 'Agent trajectory has missing external observations');
  requireValue(assistants > 0 && calls > 0 && sourceHashes.size > 0,
    'Agent trajectory must contain an assistant JavaScript tool call');
  requireValue(messages.at(-1)?.role === 'assistant', 'A complete agent trajectory must include its final assistant result');
  return {messages, toolCalls: calls, sourceHashes: [...sourceHashes].sort()};
}

/** A normal executable task plus agentTrajectory:{messages}. The task can also
 * live in agentTrajectory.task. Independent verification covers that attached
 * task; the supplied agent objective and embedded programs remain uncertified. */
export async function exportAgentTinkerExample(trajectory, options = {}) {
  const normalized = readableAgentMessages(trajectory);
  const task = {...(trajectory.task ?? {}), ...options};
  delete task.agentTrajectory;
  const exported = await exportTinkerExample(task);
  return {...exported, messages: normalized.messages,
    sourceHashes: [...new Set([exported.sourceHash, ...normalized.sourceHashes])].sort(),
    metadata: {...exported.metadata,
      importedFrom: 'agent-tool-conversation',
      agentTrajectoryDigest: digest(trajectory.messages),
      agentTaskSuccessVerified: false, trajectorySourceVerified: false,
      sourceVerificationScope: 'attached-executor-task-only',
      supervisionScope: 'supplied-agent-decisions-and-results',
      externalObservationsTrainable: false, toolCalls: normalized.toolCalls,
    }};
}
