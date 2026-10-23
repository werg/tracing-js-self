// The sole model-facing semantic trace grammar. A record describes an effective
// source computation, not a reversible sequence of ECMAScript internal methods.
// Full runtime provenance stays in the private journal.
export const TRACE_VERSION='semantic-trace/2';

const fieldsFor={
  code:['sourceId','text','codes','sites','staticFunctions'],
  enter:['invocation','entry','code','receiver','arguments','captures','dependsOn'],
  value:['entry','invocation','graph','id','site','dependsOn','control','result','reads','writes'],
  branch:['id','invocation','site','dependsOn','control','test','path','reads'],
  loop:['id','invocation','site','dependsOn','control','path','reads'],
  carry:['id','invocation','site','dependsOn','control','from','to','copies','reads'],
  alloc:['id','invocation','site','dependsOn','control','allocations','writes','result','reads'],
  read:['id','invocation','site','dependsOn','control','reads','result'],
  write:['id','invocation','site','dependsOn','control','reads','writes','result','update'],
  delete:['id','invocation','site','dependsOn','control','writes'],
  call:['id','invocation','site','dependsOn','control','child','code','receiver','arguments','captures','reads','result','writes'],
  return:['id','invocation','site','dependsOn','control','result','destination'],
  throw:['id','invocation','site','dependsOn','control','result','destination','reason'],
  await:['id','invocation','site','dependsOn','control','promise','result'],
  resume:['id','invocation','site','dependsOn','control','promise','result'],
  settle:['id','invocation','site','dependsOn','control','promise','result'],
  request:['id','invocation','site','dependsOn','control','effect','operation','arguments','codec','signature','payload'],
  observe:['id','invocation','site','dependsOn','control','effect','result','input'],
  end:['invocation','kind'],
  'value-open':['id','type'],
  'value-part':['id','data'],
  'value-close':['id']
};
export const TRACE_KINDS=Object.freeze(Object.keys(fieldsFor));
const hasOwn=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function encodeRecord(kind,fields) {
  if(!hasOwn(fieldsFor,kind))throw new TypeError('Unknown effective trace kind '+kind);
  if(!plain(fields)||Object.keys(fields).some(key=>!fieldsFor[kind].includes(key)||
      fields[key]===undefined))
    throw new TypeError('Unexpected or undefined effective trace field in '+kind);
  const json=JSON.stringify(fields);
  if(typeof json!=='string')throw new TypeError('Unserializable effective trace record');
  return kind+' '+json;
}
export function decodeRecord(line) {
  if(typeof line!=='string'||line.includes('\n')||line.includes('\r'))
    throw new TypeError('Expected one effective trace line');
  const split=line.indexOf(' ');
  if(split<0)throw new SyntaxError('Missing effective trace fields');
  const kind=line.slice(0,split);
  if(!hasOwn(fieldsFor,kind))throw new SyntaxError('Unknown effective trace kind '+kind);
  const fields=JSON.parse(line.slice(split+1));
  if(encodeRecord(kind,fields)!==line)
    throw new SyntaxError('Noncanonical effective trace record');
  return {kind,fields};
}

// Keep only values, decisions and state effects that a model must follow.
// A source site is a stable link back to the observed program, never a
// bytecode successor. Historical reads/writes are facts, not interpreter steps.
export function semanticLine(row) {
  const fields={id:row.id,invocation:row.invocation,site:row.site,
    ...(row.dependsOn.length?{dependsOn:row.dependsOn}:{}),
    ...(row.control?{control:row.control}:{})};
  if(row.reads.length)fields.reads=row.reads;
  if(row.writes.length)fields.writes=row.writes;
  if(row.op==='branch'){
    fields.test=row.test;
    fields.path=row.path;
  }else if(row.op==='loop')fields.path='repeat';
  else if(row.op==='carry'){
    if(row.copies)fields.copies=row.copies;
    else {fields.from=row.from;fields.to=row.to;}
  }else if(row.result!==null)fields.result=row.result;
  if(row.update)fields.update=row.update;
  if(row.op==='throw'&&row.completion) {
    fields.reason={type:row.completion.errorType??'throw',
      ...(row.completion.message?{message:row.completion.message}:{})};
  }
  if(row.child){
    Object.assign(fields,{child:row.child,code:row.code,receiver:row.receiver,
      arguments:row.arguments,captures:row.captures});
  }
  if(row.allocations)fields.allocations=row.allocations;
  if(row.op==='return'||row.op==='throw')fields.destination=row.destination??null;
  if(row.op==='request')Object.assign(fields,{effect:row.effect,
    operation:row.operation,arguments:row.arguments,codec:row.codec,
    signature:row.signature,payload:row.payload});
  if(row.op==='observe'){
    fields.effect=row.effect;
    if(row.input)fields.input=row.input;
  }
  if(row.op==='await'||row.op==='resume'||row.op==='settle')fields.promise=row.promise;
  return encodeRecord(row.op,fields);
}
export function fragmentLine(line,{maxBytes=512}={}) {
  if(Buffer.byteLength(line,'utf8')<=maxBytes)return [line];
  const {kind,fields}=decodeRecord(line);
  const id=fields.id??('record:'+kind);
  const output=[encodeRecord('value-open',{id,type:'semantic-record'})];
  let part='';
  for(const char of line){
    const next=part+char;
    if(Buffer.byteLength(encodeRecord('value-part',{id,data:next}),'utf8')>maxBytes){
      if(!part)throw new RangeError('A scalar cannot fit the serialization capacity');
      output.push(encodeRecord('value-part',{id,data:part}));
      part=char;
    }else part=next;
  }
  if(part)output.push(encodeRecord('value-part',{id,data:part}));
  output.push(encodeRecord('value-close',{id}));
  if(output.some(record=>Buffer.byteLength(record,'utf8')>maxBytes))
    throw new RangeError('Fragment exceeds serialized capacity');
  return output;
}
export function restoreLines(lines) {
  const output=[];
  for(let i=0;i<lines.length;i++){
    const item=decodeRecord(lines[i]);
    if(item.kind!=='value-open'){
      if(item.kind==='value-part'||item.kind==='value-close')
        throw new Error('Orphaned value fragment');
      output.push(lines[i]);continue;
    }
    const id=item.fields.id;
    let joined='',closed=false;
    for(++i;i<lines.length;i++){
      const part=decodeRecord(lines[i]);
      if(part.fields.id!==id)throw new Error('Interleaved value fragments');
      if(part.kind==='value-close'){closed=true;break;}
      if(part.kind!=='value-part'||typeof part.fields.data!=='string'||!part.fields.data.length)
        throw new Error('Invalid partial record');
      joined+=part.fields.data;
    }
    if(!closed||!joined)throw new Error('Unclosed or empty fragmented value');
    const restored=decodeRecord(joined);
    if(id!==(restored.fields.id??('record:'+restored.kind))||
       item.fields.type!=='semantic-record')
      throw new Error('Fragment identity or type mismatch');
    output.push(joined);
  }
  return output;
}

function showValue(value) {
  if(!Array.isArray(value))return JSON.stringify(value);
  switch(value[0]){
    case 'undefined':return 'undefined';
    case 'null':return 'null';
    case 'bool':return String(value[1]);
    case 'num':return String(value[1]);
    case 'str':return JSON.stringify(value[1]);
    case 'bigint':return value[1]+'n';
    case 'ref':return '&'+value[1];
    default:return value[0]+'('+JSON.stringify(value.slice(1))+')';
  }
}
// Deterministic expanded view for review/debugging. This is never additional
// generated supervision and never inserts a speculative natural-language gloss.
export function renderRecord(line,source=null) {
  const {kind,fields:f}=decodeRecord(line);
  const site=source?.sites?.find(s=>s.id===f.site);
  const expr=site&&typeof source?.text==='string'?
    source.text.slice(site.start,site.end):f.site??kind;
  if(kind==='branch')return 'if '+expr+' ('+showValue(f.test)+') -> '+f.path;
  if(kind==='loop')return 'loop '+expr+' -> '+f.path;
  if(kind==='carry')return 'iteration '+(f.copies??[{from:f.from,to:f.to}]).map(x=>
    x.from.key+': '+x.from.env+' -> '+x.to.env).join(', ');
  if(kind==='enter')return 'enter '+(f.entry??f.code)+'('+f.arguments.map(showValue).join(', ')+')';
  if(kind==='return'||kind==='throw')return kind+' '+showValue(f.result);
  if(kind==='read')return 'read '+expr+' -> '+showValue(f.result);
  if(kind==='value')return f.graph?'input '+f.entry:expr+' -> '+showValue(f.result);
  if(kind==='write'||kind==='alloc'){
    const changes=(f.writes??[]).map(w=>w.kind==='cell'?
      w.key+' = '+showValue(w.value):
      '&'+w.object+'['+JSON.stringify(w.key)+'] '+(w.present?'= '+showValue(w.value):'deleted'));
    return (kind==='alloc'?'allocate ':'set ')+changes.join(', ');
  }
  if(kind==='call')return 'call '+expr+' -> '+f.child;
  if(kind==='end')return 'end '+f.kind;
  return kind+' '+expr;
}
