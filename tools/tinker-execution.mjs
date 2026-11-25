#!/usr/bin/env node
// One private CPU execution worker; newline-delimited JSON is its only stdout.
import {createInterface} from 'node:readline';
import {createHash, randomUUID} from 'node:crypto';
import {prepareTinkerTask, createTinkerSession, readableMessagesFromJournal,
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
      if (request.task?.canonicalArtifact) {
        const {exportCanonicalTinkerExample} = await import('../src/training/tinker-import.js');
        return await exportCanonicalTinkerExample(request.task.canonicalArtifact, request.task);
      }
      if (request.task?.agentTrajectory) {
        const {exportAgentTinkerExample} = await import('../src/training/tinker-import.js');
        return await exportAgentTinkerExample(request.task.agentTrajectory, request.task);
      }
      const prepared = await prepare(request.task);
      return {schema: TINKER_EXECUTION_SCHEMA, id: prepared.id, family: prepared.family, sourceHash: prepared.sourceHash,
        task: prepared.task, messages: readableMessagesFromJournal(prepared.bundle, prepared),
        metadata: {sourceVerified: true, teacher: 'owned-runtime+native-reference', externalObservationsTrainable: false,
          runtimeIdentifiersInTargets: false, externalCalls: prepared.fixture.calls.length,
          profile: 'sequential-data-execution', exceptionProfile: 'declared-error/name-message/1', optimizerSteps: 0}};
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
