#!/usr/bin/env node
// One private CPU execution worker; newline-delimited JSON is its only stdout.
import {createInterface} from 'node:readline';
import {createHash, randomUUID} from 'node:crypto';
import {prepareTinkerTask, createTinkerSession, exportTinkerExample,
  readableMessagesFromJournal, auditTeacherConversation,
  TINKER_EXECUTION_SCHEMA} from '../src/training/tinker-execution.js';

const sessions = new Map(), preparedSessions = new Map();
const MAX_PREPARED_CACHE = 4096;
const keyOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function cachePrepared(inputKey, prepared) {
  // Retain only the lightweight outcome/effects needed for grading sessions,
  // never the multi-MB runtime journal bundle.
  const {bundle: _bundle, ...lightweight} = prepared;
  preparedSessions.set(inputKey, lightweight);
  preparedSessions.set(keyOf(prepared.task), lightweight);
  while (preparedSessions.size > MAX_PREPARED_CACHE * 2) {
    preparedSessions.delete(preparedSessions.keys().next().value);
  }
  return lightweight;
}

async function prepareForSession(task) {
  const key = keyOf(task);
  if (preparedSessions.has(key)) return preparedSessions.get(key);
  const prepared = await prepareTinkerTask(task);
  return cachePrepared(key, prepared);
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
      const reasoningChannel = request.reasoningChannel ?? 'thinking';
      if (request.task?.agentTrajectory) {
        if (traceFormat !== 'full') throw new TypeError('Trace ablations apply to executor teachers; supplied agent decisions have their own supervision');
        const {exportAgentTinkerExample} = await import('../src/training/tinker-import.js');
        return await exportAgentTinkerExample(request.task.agentTrajectory, request.task);
      }
      const key = keyOf(request.task);
      const prepared = await prepareTinkerTask(request.task);
      cachePrepared(key, prepared);
      const messages = readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat, reasoningChannel});
      const traceAudit = await auditTeacherConversation(prepared, messages, {traceFormat, reasoningChannel});
      return {schema: TINKER_EXECUTION_SCHEMA, id: prepared.id, family: prepared.family, sourceHash: prepared.sourceHash,
        task: prepared.task, messages,
        metadata: {...structuredClone(request.task.metadata ?? {}),
          ...(request.task.features ? {features: structuredClone(request.task.features)} : {}),
          ...(request.task.tier !== undefined ? {tier: request.task.tier} : {}),
          sourceVerified: true, teacher: 'owned-runtime+native-reference', traceFormat, reasoningChannel, traceAudit,
          traceRenderer: 'causal-event-source', referenceNarrationScope: 'event-source-aliases-without-final-heap-inference',
          externalObservationsTrainable: false, runtimeIdentifiersInTargets: false,
          externalCalls: prepared.fixture.calls.length, profile: 'sequential-data-execution',
          exceptionProfile: 'declared-error/name-message/1', optimizerSteps: 0}};
    }
    case 'audit': {
      const {auditTinkerSupervision} = await import('../src/training/tinker-supervision.js');
      return await auditTinkerSupervision(request.tasks, request.options ?? {});
    }
    case 'start': {
      if (sessions.size >= 128) throw new RangeError('Too many live execution sessions');
      const prepared = await prepareForSession(request.task), live = createTinkerSession(prepared), sessionId = randomUUID();
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
