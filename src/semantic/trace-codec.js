// Candidate semantic-trace/7 language. This codec is deliberately independent
// of the v6 decoder: historical bytes are not accepted or relabeled.
import {assertAlgorithmFields,assertAlgorithmId,assertAlgorithmValue,validateTerm,
  ALGORITHM_LIMITS} from './ir.js';
import {OPERATION_REGISTRY} from './operations.js';
import {encodeAlgorithmValue,renderValueName as name} from './value-render.js';
export {encodeAlgorithmValue} from './value-render.js';

export const ALGORITHM_TRACE_VERSION='semantic-trace/7';
export const ALGORITHM_TRACE_MAX_BYTES=65536;
export const ALGORITHM_RECORD_KINDS=Object.freeze([
  'compute','request','observe','write','return','throw','suspend'
]);
const plainSymbol=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const own=(value,key)=>Object.hasOwn(value,key);
const fail=message=>{throw new TypeError('Invalid '+ALGORITHM_TRACE_VERSION+': '+message);};
const dense=value=>Array.isArray(value)&&Object.keys(value).length===value.length;
const symbol=value=>plainSymbol.test(value)?value:JSON.stringify(value);
function roleCheck(kind,role){
  if(!['any','generated','observed'].includes(role))fail('record role');
  if(role==='generated'&&kind==='observe')fail('an external observation cannot be generated');
  if(role==='observed'&&kind!=='observe')fail('observed input requires an observation record');
}

export function validateAlgorithmRecord(record,{role='any'}={}){
  if(!record||!ALGORITHM_RECORD_KINDS.includes(record.kind))fail('record kind');
  roleCheck(record.kind,role);
  switch(record.kind){
    case 'compute':
      assertAlgorithmFields(record,['kind','id','term','result'],'compute claim');
      assertAlgorithmId(record.id);validateTerm(record.term);assertAlgorithmValue(record.result);break;
    case 'request':
      assertAlgorithmFields(record,['kind','id','boundary','operation','arguments'],'request claim');
      assertAlgorithmId(record.id);assertAlgorithmId(record.boundary);
      if(typeof record.operation!=='string'||!record.operation||record.operation.length>256||
        !dense(record.arguments)||record.arguments.length>128)fail('operation or argument budget');
      record.arguments.forEach(value=>assertAlgorithmValue(value));break;
    case 'observe':
      if(!['fulfilled','rejected','completed'].includes(record.status))fail('observation status');
      assertAlgorithmFields(record,record.status==='completed'?['kind','request','id','status']:
        ['kind','request','id','status','value'],'observation');
      assertAlgorithmId(record.request);assertAlgorithmId(record.id);
      if(record.status!=='completed')assertAlgorithmValue(record.value);break;
    case 'write':
      assertAlgorithmFields(record,['kind','object','key','value','present'],'visible write claim');
      assertAlgorithmValue(record.object);assertAlgorithmValue(record.value);
      if(record.object[0]!=='ref'||typeof record.key!=='string'||record.key==='__proto__'||
        typeof record.present!=='boolean')fail('visible write fields');break;
    case 'return':case 'throw':
      assertAlgorithmFields(record,['kind','value'],'completion claim');assertAlgorithmValue(record.value);break;
    case 'suspend':
      assertAlgorithmFields(record,['kind','requests','live'],'suspension claim');
      for(const key of ['requests','live']){
        if(!dense(record[key])||record[key].length>128||new Set(record[key]).size!==record[key].length)
          fail('suspension '+key);
        record[key].forEach(id=>assertAlgorithmId(id));
      }
      if(!record.requests.length)fail('suspension requires a pending request');break;
  }
  return record;
}

function termText(term){
  if(term.op==='literal')return encodeAlgorithmValue(term.value);
  if(term.op==='input')return '$'+name(term.id);
  if(term.op==='ref')return '%'+name(term.id);
  if(term.op==='project')return 'project('+termText(term.object)+', '+JSON.stringify(term.key)+')';
  if(term.op==='fold_left')return 'fold_left('+termText(term.input)+', '+termText(term.initial)+', add)';
  return term.op+'('+term.args.map(termText).join(', ')+')';
}
export function encodeAlgorithmTerm(term){validateTerm(term);return termText(term);}

export function encodeAlgorithmRecord(record,options={}){
  validateAlgorithmRecord(record,options);
  let line;
  switch(record.kind){
    case 'compute':line=name(record.id)+' = '+termText(record.term)+' => '+encodeAlgorithmValue(record.result);break;
    case 'request':line='request '+name(record.id)+' '+name(record.boundary)+': '+symbol(record.operation)+
      '('+record.arguments.map(encodeAlgorithmValue).join(', ')+')';break;
    case 'observe':line='observe '+name(record.request)+' as '+name(record.id)+': '+record.status+
      (record.status==='completed'?'':' '+encodeAlgorithmValue(record.value));break;
    case 'write':line='write '+encodeAlgorithmValue(record.object)+'['+JSON.stringify(record.key)+'] = '+
      encodeAlgorithmValue(record.value)+(record.present?'':' absent');break;
    case 'return':case 'throw':line=record.kind+' '+encodeAlgorithmValue(record.value);break;
    case 'suspend':line='suspend ['+record.requests.map(name).join(', ')+'] live ['+
      record.live.map(name).join(', ')+']';break;
  }
  if(Buffer.byteLength(line,'utf8')>ALGORITHM_TRACE_MAX_BYTES)fail('record byte budget');
  return line;
}

class Reader {
  constructor(text){this.text=text;this.offset=0;this.nodes=0;}
  fail(message){fail('at '+this.offset+': '+message);}
  peek(value){return this.text.startsWith(value,this.offset);}
  take(value){if(!this.peek(value))this.fail('expected '+JSON.stringify(value));this.offset+=value.length;}
  maybe(value){if(!this.peek(value))return false;this.offset+=value.length;return true;}
  match(pattern,label){
    const result=pattern.exec(this.text.slice(this.offset));
    if(!result)this.fail('expected '+label);this.offset+=result[0].length;return result[0];
  }
  string(){
    const start=this.offset;this.take('"');let escaped=false;
    while(this.offset<this.text.length){
      const char=this.text[this.offset++];
      if(escaped){escaped=false;continue;}
      if(char==='\\'){escaped=true;continue;}
      if(char==='"'){
        try{return JSON.parse(this.text.slice(start,this.offset));}catch{this.fail('JSON string');}
      }
    }
    this.fail('unterminated string');
  }
  name(){return this.peek('"')?this.string():this.match(/^[A-Za-z_$][A-Za-z0-9_$]*/,'identity');}
  symbol(){return this.peek('"')?this.string():
    this.match(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/,'operation');}
  value(){
    if(this.peek('"'))return ['str',this.string()];
    if(this.maybe('@'))return ['ref',this.name()];
    for(const [text,value] of [
      ['undefined',['undefined']],['null',['null']],['true',['bool',true]],['false',['bool',false]],
      ['-Infinity',['num','-Infinity']],['Infinity',['num','+Infinity']],['NaN',['num','NaN']]
    ])if(this.maybe(text))return value;
    const bigint=/^-?(?:0|[1-9][0-9]*)n/.exec(this.text.slice(this.offset));
    if(bigint){this.offset+=bigint[0].length;return ['bigint',bigint[0].slice(0,-1)];}
    const raw=this.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/,'scalar value');
    const value=Number(raw);return ['num',Object.is(value,-0)?'-0':value];
  }
  list(item,end){
    const values=[];
    if(this.maybe(end))return values;
    do{if(values.length>=128)this.fail('list budget');values.push(item());}while(this.maybe(', '));
    this.take(end);return values;
  }
  term(depth=0){
    if(++this.nodes>ALGORITHM_LIMITS.termNodes||depth>ALGORITHM_LIMITS.depth)this.fail('term budget');
    if(this.maybe('$'))return {op:'input',id:this.name()};
    if(this.maybe('%'))return {op:'ref',id:this.name()};
    const operation=/^([a-z][a-z_]*)\(/.exec(this.text.slice(this.offset));
    if(operation){
      const op=operation[1];this.offset+=operation[0].length;
      if(op==='project'){
        const object=this.term(depth+1);this.take(', ');const key=this.string();this.take(')');
        return {op,object,key};
      }
      if(op==='fold_left'){
        const input=this.term(depth+1);this.take(', ');const initial=this.term(depth+1);this.take(', add)');
        return {op,input,initial,step:'add',order:'ascending',profile:'dense-number-array/1'};
      }
      if(!own(OPERATION_REGISTRY,op))this.fail('unknown algorithm operation');
      return {op,args:this.list(()=>this.term(depth+1),')')};
    }
    return {op:'literal',value:this.value()};
  }
  record(){
    if(this.maybe('request ')){
      const id=this.name();this.take(' ');const boundary=this.name();this.take(': ');
      const operation=this.symbol();this.take('(');
      return {kind:'request',id,boundary,operation,arguments:this.list(()=>this.value(),')')};
    }
    if(this.maybe('observe ')){
      const request=this.name();this.take(' as ');const id=this.name();this.take(': ');
      const status=this.match(/^(?:fulfilled|rejected|completed)/,'observation status');
      if(status==='completed')return {kind:'observe',request,id,status};
      this.take(' ');return {kind:'observe',request,id,status,value:this.value()};
    }
    if(this.maybe('write ')){
      const object=this.value();this.take('[');const key=this.string();this.take('] = ');
      const value=this.value(),present=!this.maybe(' absent');return {kind:'write',object,key,value,present};
    }
    for(const kind of ['return','throw'])if(this.maybe(kind+' '))return {kind,value:this.value()};
    if(this.maybe('suspend [')){
      const requests=this.list(()=>this.name(),']');this.take(' live [');
      return {kind:'suspend',requests,live:this.list(()=>this.name(),']')};
    }
    const id=this.name();this.take(' = ');const term=this.term();this.take(' => ');
    return {kind:'compute',id,term,result:this.value()};
  }
}

export function decodeAlgorithmRecord(line,options={}){
  if(typeof line!=='string'||!line.length||/[\r\n]/.test(line)||
    Buffer.byteLength(line,'utf8')>ALGORITHM_TRACE_MAX_BYTES)fail('single record or byte budget');
  const reader=new Reader(line),record=reader.record();
  if(reader.offset!==line.length)reader.fail('trailing bytes');
  validateAlgorithmRecord(record,options);
  if(encodeAlgorithmRecord(record,options)!==line)fail('noncanonical spelling');
  return record;
}

// This is a syntax constraint, not an authority for values, budgets, bindings,
// capabilities, or causal order. The strict codec/controller remain required.
export function algorithmTraceGrammar({role='generated'}={}){
  if(!['generated','observed','any'].includes(role))fail('grammar role');
  const roots=role==='observed'?'observation':role==='any'?
    'computation | request | observation | write | returned | thrown | suspended':
    'computation | request | write | returned | thrown | suspended';
  const arities=new Map();
  for(const [op,spec] of Object.entries(OPERATION_REGISTRY)){
    if(!arities.has(spec.arity))arities.set(spec.arity,[]);arities.get(spec.arity).push(op);
  }
  const operations=[...arities].map(([arity,names])=>'operation-'+arity+' ::= '+names.map(JSON.stringify).join(' | '));
  const applications=[...arities.keys()].map(arity=>'operation-'+arity+' "(" '+
    Array.from({length:arity},()=> 'term').join(' ", " ')+' ")"');
  return `root ::= ${roots}\n`+String.raw`computation ::= identity " = " term " => " value
request ::= "request " identity " " identity ": " symbol "(" values? ")"
observation ::= "observe " identity " as " identity ": " ("completed" | status " " value)
status ::= "fulfilled" | "rejected"
write ::= "write @" identity "[" string "] = " value " absent"?
returned ::= "return " value
thrown ::= "throw " value
suspended ::= "suspend [" identities "] live [" identities? "]"
identities ::= identity (", " identity)*
values ::= value (", " value)*
term ::= value | "$" identity | "%" identity | "project(" term ", " string ")" | "fold_left(" term ", " term ", add)" | application
`+'application ::= '+applications.join(' | ')+'\n'+operations.join('\n')+'\n'+String.raw`value ::= string | bigint | number | "undefined" | "null" | "true" | "false" | "NaN" | "Infinity" | "-Infinity" | "@" identity
identity ::= name | string
symbol ::= name ("." name)* | string
name ::= [A-Za-z_$] [A-Za-z0-9_$]*
bigint ::= "-"? uint "n"
number ::= "-"? uint ("." [0-9]+)? ("e" ("+" | "-") [0-9]+)?
uint ::= "0" | [1-9] [0-9]*
string ::= "\"" char* "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-f]
`;
}
export const syntaxOnlyV7Grammar=()=>algorithmTraceGrammar({role:'generated'});
export const syntaxOnlyV7ObservationGrammar=()=>algorithmTraceGrammar({role:'observed'});
