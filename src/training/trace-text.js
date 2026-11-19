// The production model-facing spelling of checked semantic claims. This is a
// small data parser, never a JavaScript evaluator or a source interpreter.
// format.js validates the typed claims before writing and after reading.
const own=(value,key)=>Object.hasOwn(value,key);
const identifier=/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*/u;
const symbol=/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*(?:\.[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)*/u;
const reserved=new Set(['undefined','null','true','false','NaN','Infinity','typeof','void']);
const json=value=>{
  const result=JSON.stringify(value);
  if(typeof result!=='string')throw new TypeError('Unrepresentable trace data');
  return result;
};
const name=value=>typeof value==='string'&&symbol.exec(value)?.[0]===value?value:json(value);

export function traceValue(value){
  switch(value[0]){
    case 'undefined':case 'null':return value[0];
    case 'str':case 'bool':return json(value[1]);
    case 'num':return value[1]==='+Infinity'?'Infinity':
      typeof value[1]==='string'?value[1]:json(value[1]);
    case 'bigint':return value[1]+'n';
    case 'ref':return '@'+value[1];
    default:throw new TypeError('Unrepresentable trace value');
  }
}

export function traceExpression(expression){
  switch(expression.op){
    case 'literal':return traceValue(expression.value);
    case 'local':return reserved.has(expression.name)?'local('+json(expression.name)+')':expression.name;
    case 'read':return '@'+expression.object+'['+json(expression.key)+']';
    case 'random':return 'random()';
    case 'unary':return '('+expression.operator+' '+traceExpression(expression.arg)+')';
    case 'binary':return '('+traceExpression(expression.left)+' '+expression.operator+' '+
      traceExpression(expression.right)+')';
    default:throw new TypeError('Unrepresentable trace expression');
  }
}

const values=items=>'('+items.map(traceValue).join(', ')+')';
const properties=items=>'{'+items.map(item=>json(item.key)+': '+traceValue(item.value)).join(', ')+'}';
const captures=items=>'{'+items.map(item=>item.binding+': '+item.cell).join(', ')+'}';

export function encodeTraceText(kind,f){
  let text;
  switch(kind){
    case 'code':text='source '+json(f.entry)+' = '+json(f.source)+' sites '+json(f.sites)+
      (own(f,'randomSeed')?' seed '+f.randomSeed:'');break;
    case 'input':text='input '+json(f.graph)+(own(f,'retained')?' retained '+json(f.retained):'');break;
    case 'compute':text='compute '+traceExpression(f.expr)+' => '+traceValue(f.result)+
      (own(f,'bind')?' as '+f.bind:'');break;
    case 'choose':text='choose '+traceExpression(f.expr)+' => '+traceValue(f.decision)+' -> '+f.path;break;
    case 'bind':text=f.name+' = '+traceValue(f.value)+(own(f,'from')?' from '+f.from:'');break;
    case 'allocate':text='new @'+f.name+' '+f.kind+' '+properties(f.properties)+
      (own(f,'length')?' length '+f.length:'')+(own(f,'code')?' code '+json(f.code):'')+
      (own(f,'captures')?' captures '+captures(f.captures):'');break;
    case 'read':case 'write':text=kind+' @'+f.object+'['+json(f.key)+']'+
      (kind==='read'?' => ':' = ')+traceValue(f.value)+(f.present?'':' absent');break;
    case 'call':text='call '+name(f.callee)+values(f.arguments)+' this '+traceValue(f.receiver)+' -> @'+f.child;break;
    case 'transfer':text='transfer '+f.kind+' '+traceValue(f.value)+' via '+json(f.handler);break;
    case 'return':case 'throw':text=kind+' '+traceValue(f.value);break;
    case 'request':text='request @'+f.effect+' '+name(f.operation)+values(f.arguments)+
      ' payload '+f.payload+(own(f,'promise')?' promise @'+f.promise:'');break;
    case 'observe':text='observe @'+f.effect+' '+f.status+' '+traceValue(f.result)+
      (own(f,'graph')?' graph '+json(f.graph):'');break;
    case 'job':text='job '+f.action+' @'+f.job+' for @'+f.owner+
      (own(f,'result')?' result '+json(f.result):'')+(own(f,'closure')?' closure @'+f.closure:'');break;
    case 'promise':
      text='promise '+f.action+' @'+f.promise;
      if(['resolve','reject'].includes(f.action))text+=' = '+traceValue(f.value);
      else if(f.action==='adopt')text+=' -> @'+f.target;
      else if(f.action==='react')text+=' '+f.reaction+' as @'+f.job+
        (own(f,'closure')?' closure @'+f.closure:'')+
        (own(f,'rejectionClosure')?' reject @'+f.rejectionClosure:'')+
        (own(f,'target')?' target @'+f.target:'');
      break;
    case 'await':text='await @'+f.promise+' as @'+f.continuation+
      (own(f,'returnPromise')?' returns @'+f.returnPromise:'');break;
    case 'resume':text='resume @'+f.continuation+' '+f.status+' '+traceValue(f.result);break;
    case 'end':text='end '+f.kind;break;
    case 'summarize':
      text='evaluate '+name(f.entry)+values(f.arguments)+' => '+traceValue(f.result);
      if(f.profile==='pure-control-helper/1')text+=' choosing '+f.decisions.map(decision=>
        decision.site.start+'..'+decision.site.end+':'+decision.selected).join(', ');
      else if(f.profile==='dense-array-sum/1')text+=' over '+f.iterations+' items into '+f.accumulator;
      break;
    case 'value-open':text='record @'+f.id+' type '+json(f.type);break;
    case 'value-part':text='part @'+f.id+' '+json(f.data);break;
    case 'value-close':text='close @'+f.id;break;
    default:throw new TypeError('Unknown trace text kind');
  }
  if(own(f,'invocation'))text+=' in @'+f.invocation;
  if(own(f,'site'))text+=' at '+f.site.start+'..'+f.site.end;
  return text;
}

class Reader {
  constructor(text){this.text=text;this.offset=0;this.nodes=0;}
  fail(message){throw new TypeError('Invalid semantic-trace/6 text at '+this.offset+': '+message);}
  peek(text){return this.text.startsWith(text,this.offset);}
  take(text){if(!this.peek(text))this.fail('expected '+json(text));this.offset+=text.length;}
  maybe(text){if(!this.peek(text))return false;this.offset+=text.length;return true;}
  match(pattern,label){const result=pattern.exec(this.text.slice(this.offset));
    if(!result)this.fail('expected '+label);this.offset+=result[0].length;return result[0];}
  word(){return this.match(/^[a-z][a-z-]*/,'keyword');}
  identifier(){return this.match(identifier,'source identifier');}
  identity(){this.take('@');return this.match(/^[a-z][a-z0-9:_-]*/,'identity');}
  symbol(){return this.peek('"')?this.string():this.match(symbol,'source name');}
  string(){const result=this.json();if(typeof result!=='string')this.fail('expected string');return result;}
  integer(){const text=this.match(/^(?:0|[1-9][0-9]*)/,'nonnegative integer');
    const value=Number(text);if(!Number.isSafeInteger(value))this.fail('integer range');return value;}
  site(){const start=this.integer();this.take('..');return {start,end:this.integer()};}
  json(){
    const begin=this.offset,first=this.text[begin];
    if(first==='"'){
      let escaped=false,closed=false;this.offset++;
      while(this.offset<this.text.length){
        const char=this.text[this.offset++];
        if(escaped){escaped=false;continue;}
        if(char==='\\'){escaped=true;continue;}
        if(char==='"'){closed=true;break;}
      }
      if(!closed)this.fail('unterminated string');
    }else if(first==='{'||first==='['){
      const stack=[];let quoted=false,escaped=false;
      do {
        const char=this.text[this.offset++];
        if(char===undefined)this.fail('unterminated JSON data');
        if(quoted){
          if(escaped)escaped=false;
          else if(char==='\\')escaped=true;
          else if(char==='"')quoted=false;
        }else if(char==='"')quoted=true;
        else if(char==='{'||char==='['){
          stack.push(char);if(stack.length>256)this.fail('JSON nesting budget');
        }else if(char==='}'||char===']'){
          if(stack.pop()!==(char==='}'?'{':'['))this.fail('JSON delimiter');
        }
      }while(stack.length||quoted);
    }else this.match(/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/,'JSON data');
    try{return JSON.parse(this.text.slice(begin,this.offset));}catch{this.fail('JSON data');}
  }
  value(){
    if(this.peek('"'))return ['str',this.string()];
    if(this.peek('@'))return ['ref',this.identity()];
    for(const [text,value] of [
      ['undefined',['undefined']],['null',['null']],['true',['bool',true]],['false',['bool',false]],
      ['-Infinity',['num','-Infinity']],['Infinity',['num','+Infinity']],['NaN',['num','NaN']]
    ])if(this.maybe(text))return value;
    const bigint=/^-?(?:0|[1-9][0-9]*)n/.exec(this.text.slice(this.offset));
    if(bigint){this.offset+=bigint[0].length;return ['bigint',bigint[0].slice(0,-1)];}
    const number=this.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/,'value');
    const value=Number(number);return ['num',Object.is(value,-0)?'-0':value];
  }
  expression(){
    if(++this.nodes>32)this.fail('expression node budget');
    if(this.maybe('(')){
      for(const operator of ['typeof','void','!','+','-','~'])if(this.maybe(operator+' ')){
        const arg=this.expression();this.take(')');return {op:'unary',operator,arg};
      }
      const left=this.expression();this.take(' ');
      const operator=this.match(/^(?:===|!==|>>>|\*\*|<=|>=|==|!=|<<|>>|[+*/%<>&|^\-])/,'binary operator');
      this.take(' ');const right=this.expression();this.take(')');return {op:'binary',operator,left,right};
    }
    if(this.maybe('local(')){const name=this.string();this.take(')');return {op:'local',name};}
    if(this.maybe('random()'))return {op:'random'};
    if(this.peek('@')){
      const object=this.identity();
      if(this.maybe('[')){const key=this.string();this.take(']');return {op:'read',object,key};}
      return {op:'literal',value:['ref',object]};
    }
    const word=identifier.exec(this.text.slice(this.offset))?.[0];
    if(word&&!reserved.has(word)){this.offset+=word.length;return {op:'local',name:word};}
    return {op:'literal',value:this.value()};
  }
  arguments(){this.take('(');const result=[];
    if(this.maybe(')'))return result;
    do{result.push(this.value());}while(this.maybe(', '));this.take(')');return result;}
  properties(){this.take('{');const result=[];
    if(this.maybe('}'))return result;
    do{const key=this.string();this.take(': ');result.push({key,value:this.value()});}while(this.maybe(', '));
    this.take('}');return result;}
  captures(){this.take('{');const result=[];
    if(this.maybe('}'))return result;
    do{const binding=this.identifier();this.take(': ');result.push({binding,cell:this.identifier()});}while(this.maybe(', '));
    this.take('}');return result;}
}

export function decodeTraceText(text){
  const r=new Reader(text);let kind,f={};
  // Bindings retain source spelling, even when a source name matches a trace
  // command. The exact assignment separator disambiguates the two grammars.
  const binding=identifier.exec(text)?.[0];
  if(binding&&text.startsWith(' = ',binding.length)){
    kind='bind';f.name=r.identifier();r.take(' = ');f.value=r.value();
    if(r.maybe(' from '))f.from=r.identifier();
  }else{
    const command=r.word();r.take(' ');
    switch(command){
      case 'source':kind='code';f.entry=r.string();r.take(' = ');f.source=r.string();
        r.take(' sites ');f.sites=r.json();if(r.maybe(' seed '))f.randomSeed=r.integer();break;
      case 'input':kind='input';f.graph=r.json();if(r.maybe(' retained '))f.retained=r.json();break;
      case 'compute':kind='compute';f.expr=r.expression();r.take(' => ');f.result=r.value();
        if(r.maybe(' as '))f.bind=r.identifier();break;
      case 'choose':kind='choose';f.expr=r.expression();r.take(' => ');f.decision=r.value();
        r.take(' -> ');f.path=r.word();break;
      case 'new':kind='allocate';f.name=r.identity();r.take(' ');f.kind=r.word();r.take(' ');
        f.properties=r.properties();if(r.maybe(' length '))f.length=r.integer();
        if(r.maybe(' code '))f.code=r.string();if(r.maybe(' captures '))f.captures=r.captures();break;
      case 'read':case 'write':kind=command;f.object=r.identity();r.take('[');f.key=r.string();r.take(']');
        r.take(kind==='read'?' => ':' = ');f.value=r.value();f.present=!r.maybe(' absent');break;
      case 'call':kind='call';f.callee=r.symbol();f.arguments=r.arguments();r.take(' this ');
        f.receiver=r.value();r.take(' -> ');f.child=r.identity();break;
      case 'transfer':kind='transfer';f.kind=r.word();r.take(' ');f.value=r.value();
        r.take(' via ');f.handler=r.json();break;
      case 'return':case 'throw':kind=command;f.value=r.value();break;
      case 'request':kind='request';f.effect=r.identity();r.take(' ');f.operation=r.symbol();
        f.arguments=r.arguments();r.take(' payload ');f.payload=json(r.json());
        if(r.maybe(' promise '))f.promise=r.identity();break;
      case 'observe':kind='observe';f.effect=r.identity();r.take(' ');f.status=r.word();r.take(' ');
        f.result=r.value();if(r.maybe(' graph '))f.graph=r.json();break;
      case 'job':kind='job';f.action=r.word();r.take(' ');f.job=r.identity();r.take(' for ');
        f.owner=r.identity();if(r.maybe(' result '))f.result=r.json();
        if(r.maybe(' closure '))f.closure=r.identity();break;
      case 'promise':kind='promise';f.action=r.word();r.take(' ');f.promise=r.identity();
        if(['resolve','reject'].includes(f.action)){r.take(' = ');f.value=r.value();}
        else if(f.action==='adopt'){r.take(' -> ');f.target=r.identity();}
        else if(f.action==='react'){
          r.take(' ');f.reaction=r.word();r.take(' as ');f.job=r.identity();
          if(r.maybe(' closure '))f.closure=r.identity();
          if(r.maybe(' reject '))f.rejectionClosure=r.identity();
          if(r.maybe(' target '))f.target=r.identity();
        }break;
      case 'await':kind='await';f.promise=r.identity();r.take(' as ');f.continuation=r.identity();
        if(r.maybe(' returns '))f.returnPromise=r.identity();break;
      case 'resume':kind='resume';f.continuation=r.identity();r.take(' ');f.status=r.word();r.take(' ');
        f.result=r.value();break;
      case 'end':kind='end';f.kind=r.word();break;
      case 'evaluate':kind='summarize';f.entry=r.symbol();f.arguments=r.arguments();r.take(' => ');
        f.result=r.value();f.profile='pure-helper/1';
        if(r.maybe(' choosing ')){
          f.profile='pure-control-helper/1';f.decisions=[];
          do{const site=r.site();r.take(':');f.decisions.push({site,selected:r.word()});}while(r.maybe(', '));
        }else if(r.maybe(' over ')){
          f.profile='dense-array-sum/1';f.iterations=r.integer();r.take(' items into ');f.accumulator=r.identifier();
        }break;
      case 'record':kind='value-open';f.id=r.identity();r.take(' type ');f.type=r.string();break;
      case 'part':kind='value-part';f.id=r.identity();r.take(' ');f.data=r.string();break;
      case 'close':kind='value-close';f.id=r.identity();break;
      default:r.fail('unknown record command');
    }
  }
  if(r.maybe(' in '))f.invocation=r.identity();
  if(r.maybe(' at '))f.site=r.site();
  if(r.offset!==text.length)r.fail('trailing or noncanonical bytes');
  return {kind,fields:f};
}
