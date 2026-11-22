// Source-bound module DAG state. Public/data admission remains a separate gate.
import {createHash} from 'node:crypto';

const fail = (message) => { throw new TypeError('Module scheduler state: ' + message); };
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' +
    Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const clone = (value) => JSON.parse(JSON.stringify(value));

export function buildModuleSchedulerPlanV8(metadata) {
  if (!metadata || metadata.profile !== 'evaluated-module/1' ||
      metadata.evaluationStrategy !== 'async-dependency-scheduler' ||
      !Array.isArray(metadata.modules) || !Array.isArray(metadata.asyncDependencies) ||
      typeof metadata.entryModule !== 'string') fail('unsupported linker metadata');
  const moduleByFile = new Map(metadata.modules.map((row) => [row.file, row]));
  if (moduleByFile.size !== metadata.modules.length ||
      metadata.modules.length !== metadata.asyncDependencies.length) fail('module table mismatch');
  const rows = metadata.asyncDependencies.map((row, index) => {
    if (!row || row.index !== index || !moduleByFile.has(row.file) ||
        typeof row.hasTLA !== 'boolean' || !Array.isArray(row.dependencies)) fail('dependency row');
    const source = moduleByFile.get(row.file).source;
    if (typeof source !== 'string') fail('missing original source');
    const dependencies = row.dependencies.map((dependencyFile) => {
      if (typeof dependencyFile !== 'string' || !moduleByFile.has(dependencyFile) ||
          dependencyFile === row.file) fail('dependency file');
      return dependencyFile;
    });
    if (new Set(dependencies).size !== dependencies.length) fail('duplicate dependency');
    return {file: row.file, index, sourceDigest: createHash('sha256').update(source).digest('hex'),
      dependencies, hasTLA: row.hasTLA};
  });
  const byFile = new Map(rows.map((row) => [row.file, row]));
  if (!byFile.has(metadata.entryModule)) fail('entry module');
  const visiting = new Set(), visited = new Set();
  function visit(file) {
    if (visiting.has(file)) fail('cyclic module graphs are outside this DAG profile');
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of byFile.get(file).dependencies) visit(dependency);
    visiting.delete(file); visited.add(file);
  }
  rows.forEach((row) => visit(row.file));
  const body = {schema: 'semantic-module-scheduler-plan/1',
    entryModule: metadata.entryModule, modules: rows};
  return {...body, digest: digest(body)};
}

export function verifyModuleSchedulerPlanV8(plan) {
  if (!exact(plan, ['schema', 'entryModule', 'modules', 'digest']) ||
      plan.schema !== 'semantic-module-scheduler-plan/1' || !id(plan.entryModule) ||
      !Array.isArray(plan.modules) || !id(plan.digest)) fail('plan envelope');
  const body = {schema: plan.schema, entryModule: plan.entryModule, modules: plan.modules};
  if (digest(body) !== plan.digest) fail('plan digest');
  const files = new Set();
  plan.modules.forEach((row, index) => {
    if (!exact(row, ['file', 'index', 'sourceDigest', 'dependencies', 'hasTLA']) ||
        !id(row.file) || row.index !== index || !/^[0-9a-f]{64}$/.test(row.sourceDigest) ||
        !Array.isArray(row.dependencies) || typeof row.hasTLA !== 'boolean' ||
        files.has(row.file) || new Set(row.dependencies).size !== row.dependencies.length)
      fail('module row');
    files.add(row.file);
  });
  if (!files.has(plan.entryModule)) fail('entry absent');
  const byFile = new Map(plan.modules.map((row) => [row.file, row]));
  const visiting = new Set(), visited = new Set();
  function visit(file) {
    const row = byFile.get(file);
    if (!row) fail('unknown dependency');
    if (visiting.has(file)) fail('cycle');
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dep of row.dependencies) visit(dep);
    visiting.delete(file); visited.add(file);
  }
  plan.modules.forEach((row) => visit(row.file));
  return plan;
}

export function createModuleSchedulerStateV8(plan) {
  verifyModuleSchedulerPlanV8(plan);
  return {schema: 'semantic-module-scheduler-state/1', planDigest: plan.digest,
    nextStartOrder: 0, modules: Object.fromEntries(plan.modules.map((row) =>
      [row.file, {status: 'waiting', pendingDependencies: row.dependencies.length,
        startOrder: null, frameId: null, executionPromiseId: null, awaited: null,
        completionJobId: null, failure: null, completedDependencies: []}]))};
}

function verifyState(plan, state) {
  if (!exact(state, ['schema', 'planDigest', 'nextStartOrder', 'modules']) ||
      state.schema !== 'semantic-module-scheduler-state/1' ||
      state.planDigest !== plan.digest || !Number.isSafeInteger(state.nextStartOrder) ||
      state.nextStartOrder < 0 || !exact(state.modules, plan.modules.map((row) => row.file)))
    fail('state shape');
  const orders = [], frames = new Set(), executions = new Set();
  for (const module of plan.modules) {
    const row = state.modules[module.file];
    if (!exact(row, ['status', 'pendingDependencies', 'startOrder', 'frameId',
      'executionPromiseId', 'awaited', 'completionJobId', 'failure', 'completedDependencies']) ||
      !['waiting', 'running', 'suspended', 'fulfilled', 'rejected'].includes(row.status) ||
      !Array.isArray(row.completedDependencies) ||
      new Set(row.completedDependencies).size !== row.completedDependencies.length ||
      row.completedDependencies.some((file) => !module.dependencies.includes(file)) ||
      row.pendingDependencies !== module.dependencies.length - row.completedDependencies.length)
      fail('module state');
    const started = row.startOrder !== null;
    if (started) {
      if (!Number.isSafeInteger(row.startOrder) || row.startOrder < 0 ||
          row.startOrder >= state.nextStartOrder || !id(row.frameId) ||
          (module.hasTLA ? !id(row.executionPromiseId) : row.executionPromiseId !== null) ||
          frames.has(row.frameId) || (row.executionPromiseId !== null && executions.has(row.executionPromiseId)))
        fail('module identity state');
      frames.add(row.frameId);
      if (row.executionPromiseId !== null) executions.add(row.executionPromiseId);
      orders.push(row.startOrder);
    } else if (row.frameId !== null || row.executionPromiseId !== null) fail('unstarted identity');
    if (row.status === 'waiting' &&
        (started || row.awaited !== null || row.completionJobId !== null || row.failure !== null))
      fail('waiting module state');
    if (row.status === 'running' &&
        (!started || row.pendingDependencies !== 0 || row.awaited !== null || row.completionJobId !== null || row.failure !== null))
      fail('running module state');
    if (row.status === 'suspended' &&
        (!started || row.pendingDependencies !== 0 || !exact(row.awaited, ['promiseId']) || !id(row.awaited.promiseId) ||
         row.completionJobId !== null || row.failure !== null))
      fail('suspended module state');
    if (row.status === 'fulfilled' &&
        (!started || row.pendingDependencies !== 0 || row.awaited !== null || !id(row.completionJobId) || row.failure !== null))
      fail('fulfilled module state');
    if (row.status === 'rejected' &&
        (row.awaited !== null || (started && row.pendingDependencies !== 0) ||
         !exact(row.failure, ['moduleFile', 'promiseId', 'jobId']) ||
         !plan.modules.some((item) => item.file === row.failure.moduleFile) ||
         (plan.modules.find(item=>item.file===row.failure.moduleFile).hasTLA ?
           !id(row.failure.promiseId) : row.failure.promiseId !== null) ||
         !id(row.failure.jobId) || !id(row.completionJobId) ||
         row.completionJobId !== row.failure.jobId ||
         (started && row.failure.moduleFile !== module.file)))
      fail('rejected module state');
  }
  for (const module of plan.modules) {
    const row = state.modules[module.file];
    for (const file of module.dependencies) {
      const dependency = state.modules[file];
      const completed = row.completedDependencies.includes(file);
      if (dependency.status === 'fulfilled' && !completed)
        fail('missing completed dependency edge');
      if (completed && dependency.status !== 'fulfilled' &&
          !(row.status === 'rejected' && dependency.status === 'rejected' &&
            canonical(row.failure) === canonical(dependency.failure)))
        fail('completed dependency has no settled authority');
    }
    if (row.status === 'rejected' && row.startOrder === null &&
        !row.completedDependencies.some((file) => state.modules[file].status === 'rejected' &&
          canonical(row.failure) === canonical(state.modules[file].failure)))
      fail('propagated failure has no rejected dependency');
  }
  if (new Set(orders).size !== orders.length || orders.length !== state.nextStartOrder)
    fail('noncanonical start order');
}
export function validateModuleSchedulerStateV8(plan,state){
  verifyModuleSchedulerPlanV8(plan);verifyState(plan,state);return {valid:true};
}
function existingPromise(facts, promiseId) {
  const promise = facts?.promises?.[promiseId];
  if (!promise || promise.id !== promiseId || !['pending','fulfilled','rejected'].includes(promise.status))
    fail('expected existing await promise');
  return promise;
}
function settledJob(facts, action, expectedStatus) {
  const promise = facts?.promises?.[action.promiseId];
  const job = facts?.jobs?.[action.jobId];
  if (!promise || promise.id !== action.promiseId || promise.status !== expectedStatus ||
      !job || job.id !== action.jobId || job.promiseId !== action.promiseId ||
      job.frameId !== action.frameId || job.status !== expectedStatus ||
      (action.type === 'module.resume' && (job.kind !== 'promise-reaction' || job.moduleFile !== action.file)))
    fail('resume is not bound to the existing promise job');
  if (!Object.hasOwn(promise, 'value') || !Object.hasOwn(job, 'value') ||
      canonical(promise.value) !== canonical(job.value)) fail('promise/job outcome mismatch');
  return {promise, job};
}

/** Validate against independently supplied current runtime promise/job facts.
 * Returns a new snapshot; the input state is never mutated on success or failure. */
export function applyModuleSchedulerActionV8(plan, state, action, facts = {}) {
  verifyModuleSchedulerPlanV8(plan);
  if (!state || state.schema !== 'semantic-module-scheduler-state/1' ||
      state.planDigest !== plan.digest || !action || typeof action !== 'object') fail('state/action envelope');
  verifyState(plan, state);
  const next = clone(state);
  const row = next.modules[action.file];
  const source = plan.modules.find((item) => item.file === action.file);
  if (!row || !source) fail('unknown module');
  if (action.type === 'module.start') {
    if (!exact(action, ['type', 'file', 'frameId', 'executionPromiseId']) ||
        row.status !== 'waiting' || row.pendingDependencies !== 0 || !id(action.frameId) ||
        (source.hasTLA ? !id(action.executionPromiseId) : action.executionPromiseId !== null))
      fail('module start');
    const deps = source.dependencies.map((file) => next.modules[file]);
    if (deps.some((dep) => dep.status !== 'fulfilled')) fail('dependencies have not completed');
    if (!facts.frames?.[action.frameId] || facts.frames[action.frameId].id !== action.frameId ||
        facts.frames[action.frameId].moduleFile !== action.file ||
        facts.frames[action.frameId].executionPromiseId !== action.executionPromiseId)
      fail('module execution frame identity');
    if (Object.values(next.modules).some((item) => item.frameId === action.frameId ||
        (action.executionPromiseId !== null && item.executionPromiseId === action.executionPromiseId))) fail('reused module execution identity');
    if (source.hasTLA && (!facts.promises?.[action.executionPromiseId] ||
        facts.promises[action.executionPromiseId].id !== action.executionPromiseId ||
        facts.promises[action.executionPromiseId].status !== 'pending'))
      fail('execution promise identity');
    row.status = 'running';
    row.frameId = action.frameId;
    row.executionPromiseId = action.executionPromiseId;
    row.startOrder = next.nextStartOrder++;
    row.completedDependencies = source.dependencies.slice();
  } else if (action.type === 'module.await') {
    if (!exact(action, ['type', 'file', 'frameId', 'promiseId']) ||
        row.status !== 'running' || row.frameId !== action.frameId ||
        !source.hasTLA || row.awaited !== null || !id(action.promiseId))
      fail('module await');
    const frame = facts.frames?.[action.frameId];
    if (!frame || frame.id !== action.frameId || frame.moduleFile !== action.file ||
        frame.executionPromiseId !== row.executionPromiseId ||
        frame.awaitedPromiseId !== action.promiseId) fail('module await frame identity');
    existingPromise(facts, action.promiseId);
    row.awaited = {promiseId: action.promiseId};
    row.status = 'suspended';
  } else if (action.type === 'module.resume') {
    if (!exact(action, ['type', 'file', 'frameId', 'promiseId', 'jobId']) ||
        row.status !== 'suspended' || row.frameId !== action.frameId ||
        row.awaited?.promiseId !== action.promiseId || !id(action.jobId))
      fail('module resume');
    const promise = facts.promises?.[action.promiseId];
    if (!promise || !['fulfilled', 'rejected'].includes(promise.status)) fail('awaited promise is unsettled');
    const frame = facts.frames?.[action.frameId];
    if (!frame || frame.id !== action.frameId || frame.moduleFile !== action.file ||
        frame.executionPromiseId !== row.executionPromiseId ||
        frame.awaitedPromiseId !== action.promiseId) fail('resume frame identity');
    settledJob(facts, action, promise.status);
    // A rejected await resumes the body with a throw. Source catch/finally may
    // handle it; only the independently settled execution proves module failure.
    row.awaited = null;
    row.status = 'running';
  } else if (action.type === 'module.complete' || action.type === 'module.reject') {
    const rejecting = action.type === 'module.reject';
    if (!exact(action, ['type', 'file', 'frameId', 'promiseId', 'jobId']) ||
        !['running', 'suspended'].includes(row.status) ||
        row.frameId !== action.frameId || row.executionPromiseId !== action.promiseId ||
        !id(action.jobId)) fail('module settlement');
    const status = rejecting ? 'rejected' : 'fulfilled';
    let promise,job;
    if(source.hasTLA) ({promise,job}=settledJob(facts,action,status));
    else {
      job=facts.jobs?.[action.jobId];
      const frame=facts.frames?.[action.frameId];
      if(!job||job.id!==action.jobId||job.promiseId!==null||job.frameId!==action.frameId||
         job.status!==status||!Object.hasOwn(job,'value')||!frame||frame.id!==action.frameId||
         frame.moduleFile!==action.file||frame.executionPromiseId!==null||
         frame.status!=='completed'||frame.completion?.type!==(rejecting?'throw':'return')||
         canonical(frame.completion.value)!==canonical(job.value)) fail('synchronous completion authority');
      promise={id:null};
    }
    const expectedKind = source.hasTLA ? (rejecting ? 'module-evaluation-failure' : 'module-execution-settle') :
      (rejecting?'module-synchronous-failure':'module-synchronous-complete');
    if (job.kind !== expectedKind || job.moduleFile !== action.file) fail('module execution settlement authority');
    if (row.status === 'suspended') fail('cannot settle with an unresolved await');
    row.status = status;
    row.awaited = null;
    row.completionJobId = job.id;
    if (rejecting) {
      row.failure = {moduleFile: action.file, promiseId: promise.id, jobId: job.id};
    }
  } else if (action.type === 'module.propagateFailure') {
    if (!exact(action, ['type', 'file', 'dependencyFile', 'promiseId', 'jobId']) ||
        row.status !== 'waiting' || !source.dependencies.includes(action.dependencyFile) ||
        row.completedDependencies.includes(action.dependencyFile) ||
        next.modules[action.dependencyFile]?.status !== 'rejected' ||
        next.modules[action.dependencyFile].failure?.promiseId !== action.promiseId ||
        next.modules[action.dependencyFile].failure?.jobId !== action.jobId ||
        (action.promiseId!==null&&!id(action.promiseId)) || !id(action.jobId)) fail('dependency failure propagation');
    const promise = facts.promises?.[action.promiseId];
    const job = facts.jobs?.[action.jobId];
    const asynchronous=plan.modules.find(item=>item.file===next.modules[action.dependencyFile].failure.moduleFile).hasTLA;
    if (asynchronous&&(!promise || promise.id !== action.promiseId || promise.status !== 'rejected') ||
        !job || job.id !== action.jobId || job.promiseId !== action.promiseId ||
        job.status !== 'rejected' || job.kind !== (asynchronous?'module-evaluation-failure':'module-synchronous-failure') ||
        job.moduleFile !== next.modules[action.dependencyFile].failure.moduleFile ||
        !Object.hasOwn(job, 'value') || asynchronous&&(!Object.hasOwn(promise, 'value') ||
        canonical(promise.value) !== canonical(job.value)))
      fail('dependency propagation job identity');
    row.status = 'rejected';
    row.failure = {moduleFile: next.modules[action.dependencyFile].failure.moduleFile,
      promiseId: action.promiseId, jobId: job.id};
    row.completionJobId = job.id;
    row.completedDependencies.push(action.dependencyFile);
    row.pendingDependencies -= 1;
  } else fail('unknown action type');
  if (action.type === 'module.complete') {
    for (const parent of plan.modules.filter((item) => item.dependencies.includes(action.file))) {
      const parentState = next.modules[parent.file];
      if (!parentState.completedDependencies.includes(action.file)) {
        parentState.completedDependencies.push(action.file);
        parentState.pendingDependencies -= 1;
      }
    }
  }
  verifyState(plan, next);
  return next;
}
