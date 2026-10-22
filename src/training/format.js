// One deterministic line-oriented training trace grammar. JSON is used only
// for typed operands/values so numeric tags and UTF-16 escaping round-trip.
export const TRACE_VERSION='semantic-trace/1';
const words=new Set(['enter','value','branch','loop','alloc','read','write','delete',
  'call','return','throw','await','resume','settle','request','observe','code','end',
  'value-open','value-part','value-close']);
export function encodeRecord(kind, fields) {
  if(!words.has(kind))throw new TypeError('Unknown semantic record '+kind);
  if(!fields || typeof fields!=='object' || Array.isArray(fields))
    throw new TypeError('Record fields must be an object');
  return kind+' '+JSON.stringify(fields);
}
export function decodeRecord(line) {
  if(typeof line!=='string' || line.includes('\n'))throw new TypeError('Expected one trace line');
  const split=line.indexOf(' ');
  if(split<0)throw new SyntaxError('Missing record fields');
  const kind=line.slice(0,split);
  if(!words.has(kind))throw new SyntaxError('Unknown trace record '+kind);
  const fields=JSON.parse(line.slice(split+1));
  if(encodeRecord(kind,fields)!==line)throw new SyntaxError('Noncanonical trace record');
  return {kind,fields};
}
export function semanticLine(row) {
  const {id,site,invocation,dependsOn,control,result,reads,writes}=row;
  const fields={id,invocation,site,
    ...(dependsOn.length?{dependsOn}:{}),
    ...(control?{control}:{}),
    ...(row.operands.length?{operands:row.operands}:{}),
    ...(result!==null?{result}:{}),
    ...(row.arithmetic?{arithmetic:row.arithmetic}:{}),
    ...(row.completion?{completion:row.completion}:{}),
    ...(reads.length?{reads}:{}),
    ...(writes.length?{writes}:{}),
    ...(row.decision!==undefined?{decision:row.decision,successor:row.successor}:{}),
    ...(row.child?{child:row.child,code:row.code,receiver:row.receiver,arguments:row.arguments}:{}),
    ...(row.allocations?{allocations:row.allocations}:{}),
    ...(row.destination?{destination:row.destination}:{}),
    ...(row.effect?{effect:row.effect,operation:row.operation??null}:{}),
    ...(row.promise?{promise:row.promise}:{}),
  };
  if(row.op==='request')fields.arguments=row.arguments;
  return encodeRecord(row.op,fields);
}
export function fragmentLine(line, {maxBytes=512}={}) {
  if(Buffer.byteLength(line,'utf8')<=maxBytes)return [line];
  const {fields}=decodeRecord(line);
  const id=fields.id??('record:'+decodeRecord(line).kind);
  const output=[encodeRecord('value-open',{id,type:'semantic-record'})];
  let part='';
  for(const char of line){
    const next=part+char;
    if(Buffer.byteLength(encodeRecord('value-part',{id,data:next}),'utf8')>maxBytes){
      if(!part)throw new RangeError('A scalar cannot fit the serialization capacity');
      output.push(encodeRecord('value-part',{id,data:part}));
      part=char;
    } else part=next;
  }
  if(part)output.push(encodeRecord('value-part',{id,data:part}));
  output.push(encodeRecord('value-close',{id}));
  for(const record of output)if(Buffer.byteLength(record,'utf8')>maxBytes)
    throw new RangeError('Fragment exceeds serialized capacity');
  return output;
}
export function restoreLines(lines) {
  const output=[];
  for(let i=0;i<lines.length;i++){
    const item=decodeRecord(lines[i]);
    if(item.kind!=='value-open'){output.push(lines[i]);continue;}
    const id=item.fields.id;
    let joined='',closed=false;
    for(++i;i<lines.length;i++){
      const part=decodeRecord(lines[i]);
      if(part.fields.id!==id)throw new Error('Interleaved value fragments');
      if(part.kind==='value-close'){closed=true;break;}
      if(part.kind!=='value-part')throw new Error('Invalid partial record');
      joined+=part.fields.data;
    }
    if(!closed)throw new Error('Unclosed fragmented value');
    decodeRecord(joined);
    output.push(joined);
  }
  return output;
}
