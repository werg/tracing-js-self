// Strict public witness language. This grammar does not expose VM frames,
// property versions, journal origins, or the normalized teacher event stream.
export const WITNESS_VERSION='semantic-trace/4';
export const CONTEXT_VERSION='semantic-context/4';
export const EXECUTION_VERSION='semantic-execution/4';
export const CONTINUATION_VERSION='semantic-continuation/4';
export const HARNESS_PROFILE='selected-harness/2';
export const COMPLETION_POLICIES=Object.freeze([
  'call-return','await-returned-promise','owned-quiescence'
]);
export function canonicalCompletionPolicy(policy){
  if(!COMPLETION_POLICIES.includes(policy))throw new TypeError('Invalid completion policy');
  return policy;
}
export const SUPERVISION_VERSION='semantic-supervision/2';
export const SELECTED_STATE_FIELDS=Object.freeze(['schema','heap','locals','captureAliases','stack',
  'continuations','ready','callReturn','pending','completion']);
export const MODEL_CONTEXT_INTERVAL=32;

const schema=Object.freeze({
  code:['entry','source','sites','randomSeed'],
  input:['graph','retained'],
  compute:['expr','result','bind','invocation','site'],
  choose:['expr','decision','path','invocation','site'],
  allocate:['name','kind','length','properties','code','captures','invocation'],
  read:['object','key','value','present','invocation'],
  write:['object','key','value','present','invocation'],
  bind:['name','value','from','invocation'],
  call:['child','callee','receiver','arguments','invocation'],
  transfer:['kind','value','handler','invocation'],
  return:['value','invocation'],
  throw:['value','invocation'],
  request:['effect','operation','arguments','invocation','site','payload','promise'],
  observe:['effect','result','status','graph'],
  job:['action','job','owner','result','closure'],
  promise:['action','promise','value','target','job','reaction','closure','rejectionClosure','invocation'],
  await:['promise','continuation','invocation','returnPromise'],
  resume:['continuation','invocation','result','status'],
  end:['kind'],
  'value-open':['id','type'],
  'value-part':['id','data'],
  'value-close':['id']
});
export const WITNESS_KINDS=Object.freeze(Object.keys(schema));
export const WITNESS_SCHEMA=Object.freeze(Object.fromEntries(
  Object.entries(schema).map(([kind,fields])=>[kind,Object.freeze([...fields])])));
export const WITNESS_REQUIRED=Object.freeze(Object.fromEntries(Object.entries({
  code:['entry','source','sites'],input:['graph'],compute:['expr','result'],
  choose:['expr','decision','path'],allocate:['name','kind','properties'],
  read:['object','key','value','present'],write:['object','key','value','present'],
  bind:['name','value'],call:['child','callee','receiver','arguments'],
  transfer:['kind','value','handler'],return:['value'],throw:['value'],
  request:['effect','operation','arguments','invocation','site','payload'],observe:['effect','result','status'],
  job:['action','job','owner'],end:['kind'],promise:['action','promise'],
  await:['promise','continuation','invocation'],resume:['continuation','invocation','result','status'],
  'value-open':['id','type'],'value-part':['id','data'],'value-close':['id']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const HARNESS_RECORD_SCHEMAS=Object.freeze(Object.fromEntries(Object.entries({
  program:['programId','digest','entry','source','sites','functions','capabilities','dependencies','sourceMap','languageProfile','module','sourceMetadata'],
  invocation:['programId','invocationId','realmId','triggerId','completionPolicy','realmPolicy','inputGraph','entry','sourceDigest','receiver','closureId','activation','parentInvocationId','taskRevision','deadline','bindings','ingressKey'],
  semantic:['invocationId','traceFormat','line'],
  handler:['subscriptionId','programId','realmId','trackId','realmPolicy','entry','queueLimit','closureId','lifetime','ownerInvocationId'],
  event:['subscriptionId','eventId','invocationId','triggerId','programId','realmId'],
  'handler-close':['subscriptionId','discarded'],
  dispatch:['invocationId','effectId','key','attempt'],
  result:['invocationId','effectId','status','result','line','errorOrigin'],
  'source-evict':['programId','digest'],'source-read':['programId','digest','source'],
  'model-context':['invocationId','sourceReads'],cancel:['invocationId','reason','uncertain'],
  reconcile:['invocationId','effectId','disposition','evidenceId'],
  'callback-reattach':['subscriptionId','realmId','evidenceId']
}).map(([kind,required])=>[kind,Object.freeze({mode:kind==='semantic'?'generated':'observed',
  required:Object.freeze(required),optional:Object.freeze(kind==='dispatch'?['nativeAction']:
    kind==='model-context'?['selectedState','realmPrefixDigest','visibleThrough']:[])})])));
export const HARNESS_COMMON_FIELDS=Object.freeze(['schema','session','sequence','ownerSequence','track','mode','kind']);
export function validateHarnessRecord(record){
  const spec=Object.hasOwn(HARNESS_RECORD_SCHEMAS,record?.kind)?HARNESS_RECORD_SCHEMAS[record.kind]:null;
  if(!spec||record.schema!==EXECUTION_VERSION||record.mode!==spec.mode||
     HARNESS_COMMON_FIELDS.concat(spec.required).some(field=>!Object.hasOwn(record,field))||
     Object.keys(record).some(field=>![...HARNESS_COMMON_FIELDS,...spec.required,...spec.optional].includes(field)))
    throw new TypeError('Invalid '+EXECUTION_VERSION+' record schema, authority or fields');
  for(const field of ['session','track','programId','invocationId','realmId','triggerId','subscriptionId','eventId','trackId'])
    if(record[field]!==undefined&&(typeof record[field]!=='string'||!/^[a-z][a-z0-9:_-]*$/.test(record[field])))
      throw new TypeError('Invalid harness routing identity '+field);
  if(!Number.isSafeInteger(record.sequence)||record.sequence<1||
     !Number.isSafeInteger(record.ownerSequence)||record.ownerSequence<1)
    throw new TypeError('Invalid harness sequence');
  if(record.kind==='model-context'){
    const stateFields=['selectedState','realmPrefixDigest','visibleThrough'];
    if(stateFields.some(field=>Object.hasOwn(record,field))){
      const state=record.selectedState;
      if(!stateFields.every(field=>Object.hasOwn(record,field))||
        !state||typeof state!=='object'||Array.isArray(state)||
        Object.keys(state).length!==SELECTED_STATE_FIELDS.length||
        SELECTED_STATE_FIELDS.some(field=>!Object.hasOwn(state,field))||
        state.schema!==CONTINUATION_VERSION||
        !['heap','locals','captureAliases','stack','continuations','ready'].every(field=>Array.isArray(state[field]))||
        typeof record.realmPrefixDigest!=='string'||!/^[0-9a-f]{64}$/.test(record.realmPrefixDigest)||
        record.visibleThrough!==record.sequence-1)
        throw new TypeError('Selected context requires its exact state and prior public cutoff');
    }
  }
  if(record.kind==='invocation'){
    if(!COMPLETION_POLICIES.includes(record.completionPolicy)||!['fresh','retained'].includes(record.realmPolicy)||
       !['call','callback','module-init'].includes(record.activation)||
       !Number.isSafeInteger(record.taskRevision)||record.taskRevision<1||
       record.deadline!==null&&!Number.isFinite(record.deadline))throw new TypeError('Invalid invocation contract');
    assertValue(record.receiver);
  }
  if(record.line!==undefined){
    const decoded=decodeWitness(record.line);
    if(record.kind==='semantic'&&(record.traceFormat!==WITNESS_VERSION||['code','input','observe'].includes(decoded.kind))||
       record.kind==='result'&&decoded.kind!=='observe')throw new TypeError('Invalid harness witness authority');
  }
  return true;
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const has=(object,key)=>Object.hasOwn(object,key);
const scalarSpecial=new Set(['NaN','-0','+Infinity','-Infinity']);
const decimal=/^(?:0|-?[1-9][0-9]*)$/;
const identity=/^[a-z][a-z0-9]*$/;
// Guest source identifiers use ECMAScript spelling; witness identities do not.
const sourceIdentifier=/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u;
function fail(message){throw new TypeError('Invalid '+WITNESS_VERSION+': '+message);}
export function assertValue(v){
  if(!Array.isArray(v))fail('untagged value');
  const [tag,arg]=v;
  if(['undefined','null'].includes(tag)&&v.length===1)return v;
  if(v.length!==2)fail('tag arity');
  if(tag==='bool'&&typeof arg==='boolean')return v;
  if(tag==='str'&&typeof arg==='string')return v;
  if(tag==='bigint'&&typeof arg==='string'&&decimal.test(arg))return v;
  if(tag==='num'&&((typeof arg==='number'&&Number.isFinite(arg)&&!Object.is(arg,-0))||
    scalarSpecial.has(arg)))return v;
  if(tag==='ref'&&typeof arg==='string'&&identity.test(arg))return v;
  fail('noncanonical scalar or reference');
}
export function validateExpression(expr,{maxOperators=8}={}){
  let nodes=0,operators=0,operands=0;
  function visit(node){
    if(!object(node)||++nodes>32)fail('expression node budget exceeded');
    if(node.op==='random'&&Object.keys(node).length===1){
      operators++;return;
    }
    if(node.op==='literal'&&Object.keys(node).length===2){
      assertValue(node.value);operands++;return;
    }
    if(node.op==='local'&&Object.keys(node).length===2&&
       typeof node.name==='string'&&sourceIdentifier.test(node.name)){operands++;return;}
    if(node.op==='read'&&Object.keys(node).length===3 &&
       typeof node.object==='string'&&identity.test(node.object) &&
       typeof node.key==='string'){operands++;return;}
    if(node.op==='unary'&&Object.keys(node).length===3&&
       ['!','+','-','~','typeof','void'].includes(node.operator)){
      operators++;visit(node.arg);return;
    }
    if(node.op==='binary'&&Object.keys(node).length===4&&
       ['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=',
        '&','|','^','<<','>>','>>>'].includes(node.operator)){
      operators++;visit(node.left);visit(node.right);return;
    }
    fail('unknown expression operation or fields');
  }
  visit(expr);
  if(operators>maxOperators)fail('expression operator budget exceeded');
  return {operatorCount:operators,operandCount:operands,nodeCount:nodes};
}
export function validateGraph(graph,{externalReferences=[]}={}){
  if(!object(graph)||Object.keys(graph).sort().join(',')!=='objects,roots'||
     !Array.isArray(graph.roots)||!Array.isArray(graph.objects)||graph.objects.length>256)
    fail('input graph');
  const known=new Set(externalReferences),declared=new Set(),properties={};
  for(const node of graph.objects){
    if(!object(node)||!['array','object'].includes(node.kind)||
       typeof node.id!=='string'||!identity.test(node.id)||declared.has(node.id)||
       !Array.isArray(node.properties)||
       Object.keys(node).some(key=>!['id','kind','prototype','properties'].includes(key))||
       (has(node,'prototype')&&(node.kind!=='object'||node.prototype!==null)))
      fail('input graph identity or prototype');
    known.add(node.id);declared.add(node.id);properties[node.id]=node.properties;
  }
  for(const node of graph.objects){
    const keys=new Set();
    for(const prop of node.properties){
      if(!object(prop)||Object.keys(prop).sort().join(',')!=='key,value'||
         typeof prop.key!=='string'||prop.key==='__proto__'||keys.has(prop.key))
        fail('input property');
      keys.add(prop.key);assertValue(prop.value);
    }
    if(node.kind==='array'){
      const length=node.properties.find(p=>p.key==='length');
      if(!length||length.value?.[0]!=='num'||!Number.isInteger(length.value[1])||
         length.value[1]<0||length.value[1]>4096)fail('array length');
      for(const p of node.properties){
        if(/^(0|[1-9][0-9]*)$/.test(p.key) && Number(p.key)>=length.value[1])
          fail('array index outside length');
      }
    }
  }
  for(const root of [...graph.roots,...graph.objects.flatMap(n=>n.properties.map(p=>p.value))]){
    assertValue(root);
    if(root[0]==='ref'&&!known.has(root[1]))fail('dangling graph reference');
  }
}
export function validateWitness(kind,fields){
  if(!has(schema,kind)||!object(fields))fail('record kind or payload');
  if(Object.keys(fields).some(key=>!schema[kind].includes(key)||fields[key]===undefined))
    fail('unknown or undefined record field');
  const required=WITNESS_REQUIRED;
  if(required[kind].some(key=>!has(fields,key)))fail('missing required '+kind+' field');
  if(kind==='input'){
    const retained=fields.retained??[];
    if(!Array.isArray(retained)||new Set(retained).size!==retained.length||
       retained.some(value=>typeof value!=='string'||!identity.test(value)))
      fail('retained graph references');
    validateGraph(fields.graph,{externalReferences:retained});
  }
  if(kind==='code' && (typeof fields.entry!=='string'||
     (!sourceIdentifier.test(fields.entry)&&!/^function:[0-9]+$/.test(fields.entry))||
     typeof fields.source!=='string'||!fields.source.length||!Array.isArray(fields.sites)))
    fail('source context');
  if(kind==='code'&&fields.randomSeed!==undefined&&
     (!Number.isInteger(fields.randomSeed)||fields.randomSeed<0||
      fields.randomSeed>0xffffffff))fail('unsupported deterministic seed');
  if(kind==='compute'||kind==='choose'){
    validateExpression(fields.expr);
    assertValue(kind==='compute'?fields.result:fields.decision);
    if(kind==='choose'&&!['then','else','use-left','evaluate-right'].includes(fields.path))
      fail('choice continuation');
  }
  if(['bind','read','write'].includes(kind))assertValue(fields.value);
  if(['return','throw','transfer'].includes(kind))assertValue(fields.value);
  if(kind==='allocate' && (!identity.test(fields.name) ||
      !['array','object','closure','set','regexp'].includes(fields.kind)||!Array.isArray(fields.properties)))
    fail('allocation identity');
  if(kind==='allocate'&&fields.kind==='closure'){
    if(!Array.isArray(fields.captures??[]))fail('closure capture contract');
    const bindings=new Set();
    for(const relation of fields.captures??[]){
      if(!object(relation)||Object.keys(relation).sort().join(',')!=='binding,cell'||
         typeof relation.binding!=='string'||typeof relation.cell!=='string'||
         !sourceIdentifier.test(relation.cell)||bindings.has(relation.binding))
        fail('malformed captured cell relation');
      bindings.add(relation.binding);
    }
  }
  if(kind==='bind'&&fields.from!==undefined&&
     (typeof fields.from!=='string'||!sourceIdentifier.test(fields.from)||
      fields.from===fields.name))fail('invalid source cell relation');
  if(kind==='request'){
    const site=fields.site;
    if(typeof fields.operation!=='string'||!fields.operation||
       typeof fields.effect!=='string'||!identity.test(fields.effect)||
       !Array.isArray(fields.arguments)||fields.arguments.length>32||
       !object(site)||Object.keys(site).sort().join(',')!=='end,start'||
       !Number.isSafeInteger(site.start)||site.start<0||
       !Number.isSafeInteger(site.end)||site.end<=site.start||
       typeof fields.payload!=='string'||
       Buffer.byteLength(fields.payload,'utf8')>65536)
      fail('grounded external invocation');
    for(const argument of fields.arguments)assertValue(argument);
    let parsed;
    try {parsed=JSON.parse(fields.payload);}catch{fail('invalid external payload');}
    if((!Array.isArray(parsed)&&parsed?.schema!=='owned-graph/1')||JSON.stringify(parsed)!==fields.payload)
      fail('noncanonical external payload');
  }
  if(kind==='call' && (typeof fields.callee!=='string' ||
      !Array.isArray(fields.arguments)))fail('call arguments or source code');
  if(kind==='call'){
    assertValue(fields.receiver);
    for(const arg of fields.arguments)assertValue(arg);
  }
  if(['read','write'].includes(kind) && (typeof fields.key!=='string'||
      typeof fields.object!=='string'||typeof fields.present!=='boolean'))
    fail('location');
  if(kind==='end'&&!['return','throw'].includes(fields.kind))fail('completion kind');
  if(kind==='observe'){
    assertValue(fields.result);
    if(!['fulfilled','rejected'].includes(fields.status))fail('observation status');
    if(fields.graph!==undefined){
      validateGraph(fields.graph);
      if(fields.graph.roots.length!==1||
         JSON.stringify(fields.graph.roots[0])!==JSON.stringify(fields.result))
        fail('observed result graph root mismatch');
    }
  }
  if(kind==='promise'){
    const action=fields.action;
    if(!['create','resolve','reject','adopt','react'].includes(action))fail('promise action');
    const requiredFields={create:[],resolve:['value'],reject:['value'],
      adopt:['target'],react:['job','reaction']}[action];
    if(requiredFields.some(key=>!has(fields,key)))fail('missing promise action field');
    const allowed=['action','promise','invocation',...requiredFields,
      ...(action==='react'?['closure','rejectionClosure','target']:[])];
    if(Object.keys(fields).some(key=>!allowed.includes(key)))fail('extraneous promise action field');
    if(has(fields,'value'))assertValue(fields.value);
    if(action==='react'&&!['then','catch','finally'].includes(fields.reaction))
      fail('promise reaction');
    if(has(fields,'rejectionClosure')&&fields.reaction!=='then')fail('rejection closure requires then reaction');
  }
  if(kind==='resume'){
    assertValue(fields.result);
    if(!['fulfilled','rejected'].includes(fields.status))fail('resume status');
  }
  if(kind==='job'&&!['enqueue','dispatch','complete'].includes(fields.action))fail('job action');
  if(kind==='job'&&fields.closure!==undefined&&fields.action!=='enqueue')fail('closure belongs to job registration');
  for(const key of ['object','promise','target','continuation','closure','rejectionClosure','returnPromise','job']){
    if(has(fields,key)&&(typeof fields[key]!=='string'||!identity.test(fields[key])))
      fail('malformed witness identity '+key);
  }
  for(const key of ['name','bind'])
    if(has(fields,key)&&(typeof fields[key]!=='string'||
       !(kind==='allocate'?identity:sourceIdentifier).test(fields[key])))
      fail('malformed witness binding '+key);
  for(const key of ['invocation','child','owner'])
    if(has(fields,key)&&(typeof fields[key]!=='string'||
       !/^[a-z][a-z0-9:_-]*$/.test(fields[key])))fail('malformed invocation identity');
  return true;
}
export function encodeWitness(kind,fields){
  validateWitness(kind,fields);
  // JSON insertion order is a deliberate part of this codec; the parser
  // rejects alternate field order, duplicate keys, and non-JSON scalar tokens.
  return kind+' '+JSON.stringify(fields);
}
export function decodeWitness(line){
  if(typeof line!=='string'||/[\r\n]/.test(line))fail('multiline record');
  const split=line.indexOf(' ');
  if(split<1)fail('missing record separator');
  const kind=line.slice(0,split);
  let fields;
  try{fields=JSON.parse(line.slice(split+1));}catch{fail('JSON syntax');}
  if(encodeWitness(kind,fields)!==line)fail('noncanonical bytes');
  return {kind,fields};
}

export function fragmentWitness(line,{maxBytes=512}={}){
  decodeWitness(line);
  if(Buffer.byteLength(line,'utf8')<=maxBytes)return [line];
  const id='r'+Buffer.byteLength(line,'utf8');
  const opening=encodeWitness('value-open',{id,type:'semantic-record'});
  const close=encodeWitness('value-close',{id});
  if([opening,close].some(v=>Buffer.byteLength(v,'utf8')>maxBytes))
    throw new RangeError('Witness fragment framing exceeds capacity');
  const parts=[];let buffer='';
  for(const char of line){
    const attempt=buffer+char;
    if(Buffer.byteLength(encodeWitness('value-part',{id,data:attempt}),'utf8')>maxBytes){
      if(!buffer)throw new RangeError('Witness scalar too large for fragment');
      parts.push(encodeWitness('value-part',{id,data:buffer}));buffer=char;
    }else buffer=attempt;
  }
  if(buffer)parts.push(encodeWitness('value-part',{id,data:buffer}));
  return [opening,...parts,close];
}
export function restoreWitness(lines){
  const restored=[];
  for(let i=0;i<lines.length;i++){
    const {kind,fields}=decodeWitness(lines[i]);
    if(kind!=='value-open'){
      if(['value-part','value-close'].includes(kind))
        throw new SyntaxError('Orphaned witness transport fragment');
      restored.push(lines[i]);continue;
    }
    if(fields.type!=='semantic-record')throw new SyntaxError('Unknown transport fragment type');
    let data='',closed=false;
    for(++i;i<lines.length;i++){
      const piece=decodeWitness(lines[i]);
      if(piece.fields.id!==fields.id)throw new SyntaxError('Interleaved witness fragments');
      if(piece.kind==='value-close'){closed=true;break;}
      if(piece.kind!=='value-part'||!piece.fields.data)
        throw new SyntaxError('Invalid witness fragment');
      data+=piece.fields.data;
    }
    if(!closed)throw new SyntaxError('Incomplete witness fragment');
    decodeWitness(data);
    if(fields.id!=='r'+Buffer.byteLength(data,'utf8'))
      throw new SyntaxError('Witness fragment identity mismatch');
    restored.push(data);
  }
  return restored;
}
