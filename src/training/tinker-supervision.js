// Local supervision checks. These results describe teacher data, never model performance.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {TINKER_TRACE_FORMATS, prepareTinkerTask, readableMessagesFromJournal,
  auditTeacherConversation} from './tinker-execution.js';

const demand = (condition, message) => { if (!condition) throw new TypeError(message); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const observations = messages => messages.flatMap((message, index) =>
  index >= 2 && message.role === 'user' ? [{index, message}] : []);

/** Compare two frozen environments with the same public prompt. The complete
 * prefix, including assistant requests and earlier reasoning, must remain
 * identical up to the first differing actual observation. */
export function auditCausalPrefixPair(left, right, {divergenceObservation} = {}) {
  const a = left.messages ?? left, b = right.messages ?? right;
  demand(Array.isArray(a) && Array.isArray(b), 'Causal pair requires two conversations');
  demand(isDeepStrictEqual(a.slice(0, 2), b.slice(0, 2)), 'Causal pair public prompts differ');
  const ao = observations(a), bo = observations(b);
  if (divergenceObservation === undefined) {
    divergenceObservation = ao.findIndex((item, index) => !isDeepStrictEqual(item.message, bo[index]?.message));
    if (divergenceObservation < 0) {
      demand(ao.length === bo.length && isDeepStrictEqual(a, b), 'Identical observations changed the conversation');
      return {passed: true, testedDivergence: false, identicalPrefixMessages: a.length};
    }
  }
  demand(Number.isSafeInteger(divergenceObservation) && divergenceObservation >= 0 &&
    divergenceObservation < ao.length && divergenceObservation < bo.length, 'Invalid divergence observation');
  const ai = ao[divergenceObservation].index, bi = bo[divergenceObservation].index;
  demand(ai === bi && isDeepStrictEqual(a.slice(0, ai), b.slice(0, bi)), 'Future observation changed an earlier model-visible prefix');
  demand(!isDeepStrictEqual(ao[divergenceObservation].message, bo[divergenceObservation].message), 'Selected observations do not diverge');
  return {passed: true, testedDivergence: true, divergenceObservation, identicalPrefixMessages: ai};
}

function featuresOf(input) {
  const features = input.metadata?.features ?? input.features ?? ['unclassified'];
  demand(Array.isArray(features) && features.every(value => typeof value === 'string' && value.length > 0), 'Features must be nonempty strings');
  return [...new Set(features.length ? features : ['unclassified'])].sort();
}

/** Deterministic, feature-stratified teacher review with replay evidence for
 * each format. includeMessages emits the actual conversations for human review.
 * Paired environments among sampled tasks additionally check future blindness. */
export async function auditTinkerSupervision(inputs, {formats = TINKER_TRACE_FORMATS,
  samplePerFeature = 2, seed = 17, includeMessages = false} = {}) {
  demand(Array.isArray(inputs) && inputs.length > 0, 'Audit requires a nonempty task array');
  demand(Number.isSafeInteger(seed) && Number.isSafeInteger(samplePerFeature) && samplePerFeature > 0,
    'Audit seed and samplePerFeature must be integers; samplePerFeature must be positive');
  demand(Array.isArray(formats) && formats.length > 0 && new Set(formats).size === formats.length &&
    formats.every(format => TINKER_TRACE_FORMATS.includes(format)), 'Invalid audit trace formats');
  const ids = new Set(), byFeature = new Map(), selected = new Map(), supplied = new Map();
  for (const row of inputs) {
    const input = row.task ?? row;
    if (row.messages) {
      demand(row.task && Array.isArray(row.messages), 'Exported conversation requires its frozen task');
      demand(row.id === input.id && row.family === input.family, 'Exported conversation identity differs from its task');
      supplied.set(input.id, row);
    }
    demand(typeof input.id === 'string' && !ids.has(input.id), 'Audit task IDs must be unique'); ids.add(input.id);
    for (const feature of featuresOf(input)) {
      if (!byFeature.has(feature)) byFeature.set(feature, []);
      byFeature.get(feature).push(input);
    }
  }
  for (const group of byFeature.values()) {
    group.sort((a, b) => digest([seed, a.id]).localeCompare(digest([seed, b.id])));
    for (const input of group.slice(0, samplePerFeature)) selected.set(input.id, input);
  }
  const rows = [], pairs = [], conversations = new Map(), formatTotals = {}, suppliedConversationAudits = [];
  for (const input of [...selected.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const prepared = await prepareTinkerTask(input);
    const original = supplied.get(input.id);
    if (original) {
      demand(original.sourceHash === prepared.sourceHash, 'Exported source identity differs from its frozen task');
      suppliedConversationAudits.push({id: input.id, ...await auditTeacherConversation(prepared,
        original.messages, {traceFormat: original.metadata?.traceFormat ?? 'full',
          reasoningChannel: original.metadata?.reasoningChannel ?? 'thinking'})});
    }
    for (const traceFormat of formats) {
      const messages = readableMessagesFromJournal(prepared.bundle, prepared, {traceFormat});
      const audit = await auditTeacherConversation(prepared, messages, {traceFormat});
      const row = {id: input.id, family: input.family, sourceHash: prepared.sourceHash,
        taskDigest: digest(prepared.task), features: featuresOf(input), tier: input.metadata?.tier ?? input.tier ?? null,
        traceFormat, ...audit, ...(includeMessages ? {messages} : {})};
      rows.push(row);
      const key = digest([traceFormat, messages.slice(0, 2)]);
      if (!conversations.has(key)) conversations.set(key, []);
      conversations.get(key).push({id: input.id, traceFormat, messages});
      const total = formatTotals[traceFormat] ??= {conversations: 0, narrationLines: 0, assistantBytes: 0, observationBytes: 0};
      for (const metric of ['narrationLines', 'assistantBytes', 'observationBytes']) total[metric] += audit[metric];
      total.conversations++;
    }
  }
  for (const group of conversations.values()) for (let index = 1; index < group.length; index++) {
    const left = group[0], right = group[index];
    pairs.push({left: left.id, right: right.id, traceFormat: left.traceFormat, ...auditCausalPrefixPair(left, right)});
  }
  const causalDivergencesChecked = pairs.filter(pair => pair.testedDivergence).length;
  return {schema: 'tinker-supervision-audit/1', evidenceKind: 'local-teacher-data-audit', modelPerformanceEvidence: false,
    valid: true, success: true, failures: [],
    summary: {inputTasks: inputs.length, sampleTasks: selected.size, conversations: rows.length,
      formats: [...formats], causalPairs: pairs.length, causalDivergencesChecked},
    seed, samplePerFeature, inputTasks: inputs.length, inputDigest: digest(inputs), sampleTasks: selected.size,
    formats: [...formats], allReplayed: rows.every(row => row.replayVerified),
    featureCoverage: Object.fromEntries([...byFeature].sort(([a], [b]) => a.localeCompare(b)).map(([feature, group]) =>
      [feature, {available: group.length, selected: group.filter(input => selected.has(input.id)).length}])),
    formatTotals, causalPairs: pairs, causalDivergencesChecked,
    suppliedConversationAudits, rows,
    interpretation: 'Verifies causal renderer provenance and complete replay; does not establish faithfulness of learned model reasoning.'};
}
