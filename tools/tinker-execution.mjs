#!/usr/bin/env node
// One private CPU execution worker; newline-delimited JSON is its only stdout.
import {createInterface} from 'node:readline';
import {createHash, randomUUID} from 'node:crypto';
import {prepareTinkerTask, createTinkerSession, exportTinkerExample,
  TINKER_EXECUTION_SCHEMA} from '../src/training/tinker-execution.js';

const sessions = new Map(), preparedTasks = new Map();
const keyOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function prepare(task) {
  const key = keyOf(task);
  if (preparedTasks.has(key)) return preparedTasks.get(key);
  const prepared = await prepareTinkerTask(task);
  preparedTasks.set(key, prepared); preparedTasks.set(keyOf(prepared.task), prepared);
  // One prepared task can have both an input key and a frozen-task key.
  // Bound the map after inserting both aliases so distinct bundles cannot grow without limit.
  while (preparedTasks.size > 64) preparedTasks.delete(preparedTasks.keys().next().value);
  return prepared;
}
function session(id) {
  const result = sessions.get(id);
  if (!result) throw new TypeError('Unknown execution session');
  return result;
}
async function dispatch(request) {
  switch (request.op) {
    case 'health': return {schema: TINKER_EXECUTION_SCHEMA, node: process.version};
    case 'export': {
      const traceFormat = request.traceFormat ?? 'full';
      if (request.task?.canonicalArtifact) {
        const {exportCanonicalTinkerExample} = await import('../src/training/tinker-import.js');
        const exported = await exportCanonicalTinkerExample(request.task.canonicalArtifact, request.task);
        if (traceFormat === 'full') return exported;
        const transformed = await exportTinkerExample(exported.task, {traceFormat});
        return {...exported, messages: transformed.messages, metadata: {...exported.metadata,
          traceFormat, traceAudit: transformed.metadata.traceAudit}};
      }
      if (request.task?.agentTrajectory) {
        if (traceFormat !== 'full') throw new TypeError('Trace ablations apply to executor teachers; supplied agent decisions have their own supervision');
        const {exportAgentTinkerExample} = await import('../src/training/tinker-import.js');
        return await exportAgentTinkerExample(request.task.agentTrajectory, request.task);
      }
      return await exportTinkerExample(request.task, {traceFormat});
    }
    case 'audit': {
      const {auditTinkerSupervision} = await import('../src/training/tinker-supervision.js');
      return await auditTinkerSupervision(request.tasks, request.options ?? {});
    }
    case 'start': {
      if (sessions.size >= 128) throw new RangeError('Too many live execution sessions');
      const prepared = await prepare(request.task), live = createTinkerSession(prepared), sessionId = randomUUID();
      sessions.set(sessionId, live);
      return {sessionId, messages: live.messages};
    }
    case 'step': return await session(request.sessionId).step(request.action, request.generatedTokens);
    case 'grade': return session(request.sessionId).grade(request.totalGeneratedTokens);
    case 'close': {
      const live = sessions.get(request.sessionId);
      if (live) { live.close(); sessions.delete(request.sessionId); }
      return {closed: Boolean(live)};
    }
    default: throw new TypeError('Unknown execution worker operation');
  }
}
const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new RangeError('Worker request exceeds size limit');
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Worker request must be an object');
    const result = await dispatch(request);
    process.stdout.write(JSON.stringify({id: request.id ?? null, ok: true, result}) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({id: request?.id ?? null, ok: false,
      error: {name: error.name ?? 'Error', message: String(error.message ?? error)}}) + '\n');
  }
}
for (const live of sessions.values()) live.close();
