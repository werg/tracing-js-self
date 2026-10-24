// Strict public witness language. This grammar does not expose VM frames,
// property versions, journal origins, or the normalized teacher event stream.
export const WITNESS_VERSION='semantic-trace/3';
export const CONTEXT_VERSION='semantic-context/3';
export const EXECUTION_VERSION='semantic-execution/3';
export const SUPERVISION_VERSION='semantic-supervision/2';

const schema=Object.freeze({
  code:['entry','source','sites'],
  input:['graph'],
  compute:['expr','result','bind','invocation','site'],
  choose:['expr','decision','path','invocation','site'],
  allocate:['name','kind','length','properties','code','invocation'],
  read:['object','key','value','present','invocation'],
  write:['object','key','value','present','invocation'],
  bind:['name','value','invocation'],
  call:['child','callee','receiver','arguments','invocation'],
  transfer:['kind','value','handler','invocation'],
  return:['value','invocation'],
  throw:['value','invocation'],
  request:['effect','operation','arguments','invocation'],
  observe:['effect','result','status'],
  job:['action','job','owner','result'],
  end:['kind'],
  'value-open':['id','type'],
  'value-part':['id','data'],
  'value-close':['id']
});
export const WITNESS_KINDS=Object.freeze(Object.keys(schema));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const has=(object,key)=>Object.hasOwn(object,key);
const scalarSpecial=new Set(['NaN','-0','+Infinity','-Infinity']);
const decimal=/^(?:0|-?[1-9][0-9]*)$/;
const identity=/^[a-z][a-z0-9]*$/;
function fail(message){throw new TypeError('Invalid semantic-trace/3: '+message);}
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
    if(node.op==='literal'&&Object.keys(node).length===2){
      assertValue(node.value);operands++;return;
    }
    if(node.op==='local'&&Object.keys(node).length===2&&
       typeof node.name==='string'&&identity.test(node.name)){operands++;return;}
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
function validateGraph(graph){
  if(!object(graph)||Object.keys(graph).sort().join(',')!=='objects,roots'||
     !Array.isArray(graph.roots)||!Array.isArray(graph.objects)||graph.objects.length>256)
    fail('input graph');
  const known=new Set(),properties={};
  for(const node of graph.objects){
    if(!object(node)||!['array','object'].includes(node.kind)||
       typeof node.id!=='string'||!identity.test(node.id)||known.has(node.id)||
       !Array.isArray(node.properties)||
       Object.keys(node).some(key=>!['id','kind','prototype','properties'].includes(key))||
       (has(node,'prototype')&&(node.kind!=='object'||node.prototype!==null)))
      fail('input graph identity or prototype');
    known.add(node.id);properties[node.id]=node.properties;
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
  const required={
    code:['entry','source','sites'],input:['graph'],compute:['expr','result'],
    choose:['expr','decision','path'],allocate:['name','kind','properties'],
    read:['object','key','value','present'],write:['object','key','value','present'],
    bind:['name','value'],call:['child','callee','receiver','arguments'],
    transfer:['kind','value','handler'],return:['value'],throw:['value'],
    request:['effect','operation','arguments'],observe:['effect','result','status'],
    job:['action','job','owner'],end:['kind'],
    'value-open':['id','type'],'value-part':['id','data'],'value-close':['id']
  };
  if(required[kind].some(key=>!has(fields,key)))fail('missing required '+kind+' field');
  if(kind==='input')validateGraph(fields.graph);
  if(kind==='code' && (typeof fields.entry!=='string'||!identity.test(fields.entry)||
     typeof fields.source!=='string'||!fields.source.length||!Array.isArray(fields.sites)))
    fail('source context');
  if(kind==='compute'||kind==='choose'){
    validateExpression(fields.expr);
    assertValue(kind==='compute'?fields.result:fields.decision);
    if(kind==='choose'&&!['then','else','use-left','evaluate-right'].includes(fields.path))
      fail('choice continuation');
  }
  if(['bind','read','write'].includes(kind))assertValue(fields.value);
  if(['return','throw','transfer'].includes(kind))assertValue(fields.value);
  if(kind==='allocate' && (!identity.test(fields.name) ||
      !['array','object','closure'].includes(fields.kind)||!Array.isArray(fields.properties)))
    fail('allocation identity');
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
  if(kind==='observe'&&!['fulfilled','rejected'].includes(fields.status))fail('observation status');
  if(kind==='job'&&!['enqueue','dispatch','complete'].includes(fields.action))fail('job action');
  for(const key of ['name','bind','invocation','child','object']){
    if(has(fields,key)&&(typeof fields[key]!=='string'||!identity.test(fields[key])))
      fail('malformed witness identity '+key);
  }
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
