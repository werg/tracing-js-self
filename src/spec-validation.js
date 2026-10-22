// Independent, read-only interpretation of spec mutation commands. This module
// imports only the data vocabulary; it never calls execution/mutation routines.
import { ARITHMETIC_OPERATORS, SPEC_REGISTERS, SPEC_TRANSITIONS, specStep } from './spec-schema.js';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => structuredClone(value);
const own = (object, name) => Object.hasOwn(object, name);
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  eq(Object.keys(value).sort(), [...names].sort());

function scalar(value) {
  if (!Array.isArray(value)) return false;
  if (['undefined','null'].includes(value[0])) return value.length === 1;
  if (value.length !== 2) return false;
  switch (value[0]) {
    case 'bool': return typeof value[1] === 'boolean';
    case 'str': return typeof value[1] === 'string';
    case 'bigint': return typeof value[1] === 'string' && /^(0|-?[1-9]\d*)$/.test(value[1]);
    case 'num': return typeof value[1] === 'number'
      ? Number.isFinite(value[1]) && !Object.is(value[1], -0)
      : ['-0','NaN','+Infinity','-Infinity'].includes(value[1]);
    default: return false;
  }
}
function valueValid(value) {
  if (scalar(value)) return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 2 && ['ref','promise','host','hostfn','intrinsic','builtinfn'].includes(value[0]))
    return typeof value[1] === 'string' && value[1].length > 0;
  return value.length === 3 && value[0] === 'method' && valueValid(value[1]) && valueValid(value[2]);
}
function tokenValid(value, seen, current = null, primitive = false) {
  return keys(value, ['value','origin']) && (primitive ? scalar(value.value) : valueValid(value.value)) &&
    (value.origin === null || value.origin === current || seen.has(value.origin));
}

/** Called before applying this event's changes, to verify phase/source ownership. */
export function validateSpecEvent(state, event, fail) {
  const commands = event.stateChanges.filter(p => p.table === 'operations');
  const isSpec = event.operation.startsWith('spec.');
  if (!isSpec) {
    if (event.spec) fail('Spec metadata on a non-spec event', event.eventId);
    if (commands.length && (event.operation !== 'primitive.binary' || commands.length !== 1 || commands[0].kind !== 'operation.create'))
      fail('Unowned spec-operation creation', event.eventId);
    return;
  }
  if (event.completion && event.operation!=='spec.operation.complete')
    fail('Completion metadata before spec return phase',event.eventId);
  if (commands.length !== 1) fail('Expected one owned spec command', event.eventId);
  const command = commands[0], record = state.operations?.[command.id];
  if (!record || record.status !== 'running') fail('Spec event has no running operation', event.eventId);
  const frame = state.frames[record.frameId];
  if (!frame || frame.operationId !== record.id || frame.status !== 'running' || state.control.a0.activeFrameId !== frame.id)
    fail('Spec continuation is not owned by the active frame', event.eventId);
  let metadata;
  try { metadata = specStep(record); } catch { fail('Invalid spec phase operands', event.eventId); }
  if (event.operation !== metadata.operation || !eq(event.spec, metadata.spec)) fail('Spec phase metadata mismatch', event.eventId);
  if (event.siteId !== record.siteId || event.sourceId !== record.sourceId || event.codeId !== record.codeId ||
      event.invocationId !== record.frameId)
    fail('Spec continuation source mismatch', event.eventId);
  if (!eq(event.causes, [{kind:'spec-operation',operationId:record.id}])) fail('Spec operation cause mismatch', event.eventId);
  if (command.kind !== (record.phase === 'complete' ? 'operation.complete' : 'operation.advance'))
    fail('Wrong spec mutation for phase', event.eventId);
  const r = record.registers, side = record.phase.startsWith('left') ? 'left' : 'right';
  let inputs;
  switch(record.phase) {
    case 'left-primitive': inputs=[record.operands[0]];break;
    case 'right-primitive': inputs=[record.operands[1]];break;
    case 'select': inputs=[r.leftPrimitive,r.rightPrimitive];break;
    case 'left-string': inputs=[r.leftPrimitive];break;
    case 'right-string': inputs=[r.rightPrimitive];break;
    case 'concatenate': inputs=[r.leftString,r.rightString];break;
    case 'left-numeric': case 'right-numeric':
    case 'left-numeric-primitive': case 'right-numeric-primitive':
      inputs=[record.operator==='+' ? r[side+'Primitive'] : record.operands[side==='left'?0:1]];break;
    case 'left-numeric-kind': case 'right-numeric-kind':
    case 'left-number': case 'right-number': inputs=[r[side+'NumericPrimitive']];break;
    case 'numeric-types': case 'apply': inputs=[r.leftNumeric,r.rightNumeric];break;
    case 'coercion-get': inputs=[record.coercion?.input];break;
    case 'coercion-call': inputs=[record.coercion?.method,record.coercion?.input];break;
    case 'coercion-return': inputs=[frame.pendingCoercionThrow
      ? frame.pendingCoercionThrow.value??record.coercion?.input : frame.stack.at(-1)];break;
    case 'complete': inputs=record.completion?.type==='normal'?[record.completion.value]:[];break;
  }
  if (!inputs || inputs.some(input=>!input)) fail('Missing required spec register',event.eventId);
  if (!eq(event.operands,inputs.map(input=>input.value)) || !eq(event.operandOrigins,inputs.map(input=>input.origin)))
    fail('Spec operand/register provenance mismatch',event.eventId);
}

export function applySpecCommand(state, command, event, seen, fail) {
  const bad = message => fail(message, event.eventId);
  const id = command.id;
  if (typeof id !== 'string' || !/^op[1-9]\d*$/.test(id) || !state.operations) bad('Invalid spec operation identity');
  if (command.kind === 'operation.create') {
    if (!keys(command, ['kind','table','id','record']) || own(state.operations, id)) bad('Duplicate or malformed operation creation');
    const r = command.record;
    if (!keys(r, ['id','frameId','algorithm','operator','siteId','sourceId','codeId','operands','registers','completion','coercion','phase','status','version']) ||
        r.id !== id || r.version !== 1 || r.status !== 'running' || r.algorithm !== 'ApplyStringOrNumericBinaryOperator' ||
        !ARITHMETIC_OPERATORS.includes(r.operator) || r.phase !== (r.operator === '+' ? 'left-primitive' : 'left-numeric') ||
        r.completion !== null || r.coercion!==null || !keys(r.registers, []) || !Array.isArray(r.operands) || r.operands.length !== 2 ||
        !r.operands.every(t => tokenValid(t, seen))) bad('Invalid initial owned operation record');
    const f = state.frames[r.frameId];
    if (!f || f.operationId !== id || f.codeId !== r.codeId || f.status !== 'running' || state.control.a0.activeFrameId !== f.id ||
        event.siteId !== r.siteId || event.sourceId !== r.sourceId || event.codeId !== r.codeId || event.invocationId !== r.frameId ||
        !eq(event.operands, r.operands.map(t => t.value)) || !eq(event.operandOrigins, r.operands.map(t => t.origin)) ||
        !eq(event.causes, [{kind:'spec-operation',operationId:id}])) bad('Operation creation ownership mismatch');
    state.operations[id] = copy(r); return;
  }
  const r = state.operations[id];
  if (!r || r.status !== 'running' || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion !== r.version)
    bad('Owned operation version precondition mismatch');
  if (command.kind === 'operation.complete') {
    if (!keys(command, ['kind','table','id','expectedVersion','completion']) || r.phase !== 'complete' || !r.completion ||
        !eq(command.completion, r.completion) || !eq(event.completion, r.completion)) bad('Invalid owned operation completion');
    const frame = state.frames[r.frameId];
    if (frame.operationId !== null) bad('Completed operation still attached to frame');
    if (r.completion.type === 'normal') {
      if (!eq(frame.stack.at(-1), {value:r.completion.value.value,origin:event.eventId}) ||
          !eq(event.result, r.completion.value.value)) bad('Operation result not returned to owning frame');
    } else {
      const unsupported=r.completion.type==='unsupported',control=state.control.a0;
      if(unsupported){
        if(frame.status!=='unsupported'||!eq(frame.completion,r.completion)||
          control.status!=='unsupported'||control.activeFrameId!==null||
          !eq(control.failure,{kind:'unsupported',frameId:r.frameId,completion:r.completion}))
          bad('Unsupported operation did not terminate at its owning frame');
      }else if(control.status==='failed'){
        const failure=control.failure, terminal=state.frames[failure?.frameId];
        if(failure?.kind!=='guest-abrupt'||!eq(failure.completion,r.completion)||
          terminal?.status!=='thrown'||!eq(terminal.completion,r.completion)||
          control.activeFrameId!==null)
          bad('Uncaught arithmetic throw did not terminate');
      }else{
        const active=state.frames[control.activeFrameId];
        const rejection=frame.status==='thrown' && frame.asyncPromiseId &&
          state.promises[frame.asyncPromiseId]?.status==='rejected';
        if(!rejection && (active?.status!=='running'||
           !['running','thrown'].includes(frame.status)||
           !active.handlers?.some(h=>h.phase==='catch'||h.phase==='finally')))
          bad('Arithmetic throw did not reach a catch/finally handler or async rejection');
      }
    }
    r.phase = 'done'; r.status = 'completed'; r.version++; return;
  }
  if (command.kind !== 'operation.advance' ||
      !keys(command, ['kind','table','id','expectedVersion','from','to','writes','completionBefore','completionAfter','coercionBefore','coercionAfter']) ||
      command.from !== r.phase || !SPEC_TRANSITIONS[r.phase]?.includes(command.to) ||
      !Array.isArray(command.writes) || !eq(r.completion,command.completionBefore) ||
      !eq(r.coercion,command.coercionBefore)) bad('Invalid owned operation transition');
  const allowed = {
    'left-primitive':'leftPrimitive', 'right-primitive':'rightPrimitive',
    'left-string':'leftString', 'right-string':'rightString', concatenate:'value',
    'left-numeric-primitive':'leftNumericPrimitive', 'right-numeric-primitive':'rightNumericPrimitive',
    'left-numeric-kind':'leftNumeric', 'right-numeric-kind':'rightNumeric',
    'left-number':'leftNumeric', 'right-number':'rightNumeric', apply:'value'
  }[r.phase] ?? (['coercion-call','coercion-return'].includes(r.phase) ? r.coercion?.register : undefined);
  const completion = command.completionAfter;
  const earlyAbrupt = completion && completion.type!=='normal';
  const numericNumberBranch = r.phase.endsWith('-numeric-kind') && command.to.endsWith('-number');
  const conversionResult=['coercion-call','coercion-return'].includes(r.phase);
  const conversionWritten=conversionResult && command.to===r.coercion?.resume;
  const conversionEntry=command.to==='coercion-get' && r.phase.endsWith('-primitive');
  const expectedWrites = allowed && !earlyAbrupt && !numericNumberBranch && !conversionEntry &&
    (!conversionResult || conversionWritten) ? 1 : 0;
  if (command.writes.length!==expectedWrites) bad('Missing or unexpected owned register write');
  const written = new Set();
  for (const write of command.writes) {
    if (!keys(write, ['name','before','after']) || !SPEC_REGISTERS.includes(write.name) || write.name !== allowed ||
        written.has(write.name) || own(r.registers, write.name) || write.before !== null ||
        !tokenValid(write.after,seen,event.eventId,true) || write.after.origin !== event.eventId)
      bad('Invalid owned register write');
    written.add(write.name); r.registers[write.name] = copy(write.after);
    if (!eq(event.result,write.after.value)) bad('Spec result/register mismatch');
    if (write.name.endsWith('Numeric') && !['num','bigint'].includes(write.after.value[0])) bad('Non-numeric spec register');
    if (write.name.endsWith('String') && write.after.value[0]!=='str') bad('Non-string spec register');
    if (r.phase.endsWith('-number') && write.after.value[0]!=='num') bad('ToNumber must produce Number');
    if (r.phase.endsWith('-numeric-kind') && write.after.value[0]!=='bigint') bad('ToNumeric BigInt branch type mismatch');
    if (r.phase==='concatenate' && write.after.value[0]!=='str') bad('Concatenation must produce String');
    if (r.phase==='apply' && write.after.value[0]!==r.registers.leftNumeric.value[0]) bad('Numeric leaf result type mismatch');
    if ((r.phase.endsWith('-primitive') && !conversionResult || r.phase.endsWith('-numeric-kind')) && !eq(write.after.value,event.operands[0]))
      bad('Identity conversion changed a primitive value');
  }
  if (!command.writes.length && !['select','numeric-types','complete'].includes(r.phase) && event.result!==null)
    bad('Unexpected spec phase result');
  if (r.phase==='select') {
    const stringBranch=r.registers.leftPrimitive.value[0]==='str'||r.registers.rightPrimitive.value[0]==='str';
    if (command.to!==(stringBranch?'left-string':'left-numeric') || !eq(event.result,['bool',stringBranch]))
      bad('Invalid string/numeric branch');
  }
  if (r.phase.endsWith('-numeric-kind')) {
    const left=r.phase.startsWith('left'), input=r.registers[(left?'left':'right')+'NumericPrimitive'];
    const bigint=input.value[0]==='bigint';
    if (command.to!==(bigint?(left?'right-numeric':'numeric-types'):(left?'left-number':'right-number')))
      bad('Invalid ToNumeric type branch');
  }
  if (r.phase==='numeric-types') {
    const same=r.registers.leftNumeric.value[0]===r.registers.rightNumeric.value[0];
    if (command.to!==(same?'apply':'complete') || !eq(event.result,['bool',same])) bad('Invalid numeric type branch');
  }
  // Independently check the small owned OrdinaryToPrimitive continuation
  // shape, including the current conversion operand and child invocation.
  const oldCoercion=r.coercion, nextCoercion=command.coercionAfter;
  const conversionPhase=['coercion-get','coercion-call','coercion-return'].includes(r.phase);
  if(command.to==='coercion-get' && r.phase.endsWith('-primitive')) {
    const left=r.phase.startsWith('left');
    const numeric=r.phase.includes('numeric');
    const input=numeric
      ? (r.operator==='+'?r.registers[left?'leftPrimitive':'rightPrimitive']:r.operands[left?0:1])
      : r.operands[left?0:1];
    const register=left?(numeric?'leftNumericPrimitive':'leftPrimitive')
      :(numeric?'rightNumericPrimitive':'rightPrimitive');
    const resume=numeric?(left?'left-numeric-kind':'right-numeric-kind')
      :(left?'right-primitive':'select');
    if(oldCoercion!==null || input?.value?.[0]!=='ref' ||
       !keys(nextCoercion,['side','input','register','resume','index','method','waitingFrameId']) ||
       nextCoercion.side!==(left?'left':'right') || !eq(nextCoercion.input,input) ||
       nextCoercion.register!==register||nextCoercion.resume!==resume||
       nextCoercion.index!==0||nextCoercion.method!==null||nextCoercion.waitingFrameId!==null)
      bad('Malformed owned coercion entry');
  } else if(r.phase==='coercion-get') {
    if(!oldCoercion||!keys(nextCoercion,Object.keys(oldCoercion))||
       command.to!=='coercion-call'||nextCoercion.index!==oldCoercion.index||
       !eq(nextCoercion.input,oldCoercion.input)||
       !tokenValid(nextCoercion.method,seen)||
       nextCoercion.waitingFrameId!==null)
      bad('Invalid owned method lookup');
    const obj=state.heap[oldCoercion.input.value[1]];
    const name=oldCoercion.index===0?'valueOf':'toString';
    const own=obj&&Object.hasOwn(obj.properties,name);
    if(!obj||!['object','array'].includes(obj.kind))bad('Unowned internal method receiver');
    const value=own?obj.properties[name].value:['builtinfn',
      name==='valueOf'?'Object.valueOf':obj.kind==='array'?'Array.toString':'Object.toString'];
    const origin=own?obj.properties[name].origin:null;
    const observation={kind:'property',objectId:obj.id,key:name,
      version:Object.hasOwn(obj.propertyVersions??{},name)?obj.propertyVersions[name]:0,shapeVersion:obj.shapeVersion??0,
      present:own,value,supplyingEvent:origin??null};
    if(!eq(nextCoercion.method,{value,origin})||!eq(event.readObservations,[observation]))
      bad('Owned [[Get]] method/provenance mismatch');
  } else if(r.phase==='coercion-call' || r.phase==='coercion-return'){
    if(!oldCoercion||!['valueOf','toString'].includes(oldCoercion.index===0?'valueOf':
       oldCoercion.index===1?'toString':'invalid'))bad('Invalid coercion method ordinal');
    if(command.to==='coercion-return') {
      const child=state.frames[nextCoercion?.waitingFrameId];
      const target=state.heap[oldCoercion.method?.value?.[1]];
      if(r.phase!=='coercion-call'||!target||target.kind!=='function'||target.async||
         !child||child.callerFrameId!==r.frameId||
         child.codeId!==target.codeId||child.asyncPromiseId!==null||
         !eq(child.thisValue,oldCoercion.input.value)||
         state.envs[child.envId]?.parent!==target.closureEnvId||
         child.status!=='running'||state.control.a0.activeFrameId!==child.id||
         !eq(nextCoercion.method,oldCoercion.method)||
         nextCoercion.index!==oldCoercion.index)
        bad('Unowned guest method call');
    } else if(command.to==='coercion-get'){
      if(!nextCoercion||nextCoercion.index!==oldCoercion.index+1||
         (r.phase==='coercion-return' &&
           ['undefined','null','bool','num','str','bigint'].includes(event.operands[0]?.[0]))||
         nextCoercion.index!==1||nextCoercion.method!==null||
         nextCoercion.waitingFrameId!==null||
         !eq(nextCoercion.input,oldCoercion.input))
        bad('Invalid conversion method fallback');
    } else if(command.to===oldCoercion.resume) {
      if(nextCoercion!==null||command.writes.length!==1||
         (r.phase==='coercion-return' &&
           !eq(command.writes[0].after?.value,event.operands[0])))
        bad('Primitive coercion return disagrees with completed guest call');
    } else if(command.to==='complete'){
      if(!completion||!['throw','unsupported'].includes(completion.type))
        bad('Missing coercion abrupt completion');
    } else bad('Invalid dynamic coercion transition');
  } else if(!eq(oldCoercion,nextCoercion))bad('Unexpected coercion state mutation');
  if(r.phase.endsWith('-primitive') && command.to!=='coercion-get' &&
     !eq(oldCoercion,nextCoercion))bad('Unexpected conversion state');
  if (command.to === 'complete') {
    if (r.completion !== null || !completion) bad('Missing or repeated spec completion');
    if (completion.type === 'normal') {
      if (!keys(completion,['type','value']) || !tokenValid(completion.value,seen,event.eventId,true) ||
          !eq(completion.value,r.registers.value) || !['apply','concatenate'].includes(r.phase)) bad('Invalid normal spec completion');
    } else if (completion.type === 'throw') {
      if (r.phase==='coercion-return' && completion.value) {
        if(!tokenValid(completion.value,seen))bad('Invalid thrown conversion method value');
      } else if (!keys(completion,['type','errorType','message','origin']) || completion.origin !== event.eventId ||
          typeof completion.message !== 'string' ||
          !((r.phase === 'numeric-types' && completion.errorType === 'TypeError') ||
            (r.phase === 'apply' && completion.errorType === 'RangeError') ||
            (['coercion-call','coercion-return'].includes(r.phase) &&
              completion.errorType==='TypeError'))) bad('Invalid abrupt spec completion');
    } else if (completion.type === 'unsupported') {
      if (!keys(completion,['type','feature','message','origin']) || completion.origin !== event.eventId ||
          !(r.phase.endsWith('-primitive') || r.phase==='coercion-get' || r.phase==='coercion-call') ||
          !['ToPrimitive(Object)','ArrayToString(complex)','AsyncToPrimitive'].includes(completion.feature) ||
          typeof completion.message !== 'string') bad('Invalid unsupported spec completion');
    } else bad('Unknown spec completion');
  } else if (completion !== null) bad('Unexpected early spec completion');
  r.phase = command.to; r.completion = copy(completion); r.coercion=copy(command.coercionAfter); r.version++;
}
