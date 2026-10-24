// Deliberately bounded grammar; unsupported syntax fails closed, never through native eval.
import { encode } from './values.js';
/** Var declarations belong to a function, including nested block and loop bodies. */
export function collectVarBindings(statements) {
  const names=new Set();
  function visit(n){
    if(!n)return;
    switch(n.type){
      case 'Variable':if(n.kind==='var')names.add(n.id);break;
      case 'VariableGroup':n.declarations.forEach(visit);break;
      case 'PatternBinding':
        if(n.kind==='var')for(const binding of n.bindings)names.add(binding.name);
        break;
      case 'Block':n.body.forEach(visit);break;
      case 'If':visit(n.consequent);visit(n.alternate);break;
      case 'For':visit(n.init);visit(n.body);break;
      case 'ForOf':if(n.kind==='var')names.add(n.id);visit(n.body);break;
      case 'While':case 'DoWhile':visit(n.body);break;
      case 'Try':visit(n.block);visit(n.handler?.body);visit(n.finalizer);break;
      // Descendant functions own their separate environment.
      case 'Function':case 'FunctionExpr':break;
    }
  }
  statements.forEach(visit);
  return [...names];
}
const ops = ['===','!==','=>','**','++','--','==','!=','<=','>=','+=','-=','&&','||','??'];
const singles = '{}()[];,.:+-*/%<>=!?';
function lex(source) {
  const tokens = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i+2); if (end < 0) throw new SyntaxError('Unterminated comment'); i = end + 2; continue; }
    const start = i; const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c; i++; let out = '';
      while (i < source.length && source[i] !== quote) {
        let ch = source[i++];
        if (ch === '\\') {
          if (i === source.length) throw new SyntaxError('Unterminated string escape');
          ch = source[i++];
          const escapes = {n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
          if ((ch === '0' && /[0-9]/.test(source[i] ?? '')) || /^[1-7]$/.test(ch))
            throw new SyntaxError('Legacy octal escapes are not implemented');
          if (Object.hasOwn(escapes,ch)) ch = escapes[ch];
          else if (ch === 'x') {
            const digits = source.slice(i,i+2);
            if (!/^[0-9a-f]{2}$/i.test(digits)) throw new SyntaxError('Invalid hex escape');
            ch = String.fromCharCode(parseInt(digits,16)); i += 2;
          } else if (ch === 'u') {
            if (source[i] === '{') {
              const end = source.indexOf('}',i+1);
              const digits = source.slice(i+1,end);
              if (end<0 || !/^[0-9a-f]{1,6}$/i.test(digits) ||
                  parseInt(digits,16)>0x10ffff) throw new SyntaxError('Invalid Unicode escape');
              ch = String.fromCodePoint(parseInt(digits,16)); i=end+1;
            } else {
              const digits = source.slice(i,i+4);
              if (!/^[0-9a-f]{4}$/i.test(digits)) throw new SyntaxError('Invalid Unicode escape');
              ch = String.fromCharCode(parseInt(digits,16)); i+=4;
            }
          } else if (ch === '\n') ch = '';
          else if (ch === '\r') { if (source[i] === '\n') i++; ch = ''; }
        }
        out += ch;
      }
      if (source[i] !== quote) throw new SyntaxError('Unterminated string');
      i++; tokens.push({kind:'literal',value:out,raw:source.slice(start,i),start,end:i}); continue;
    }
    if (/\d/.test(c)) {
      const m = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?n?/.exec(source.slice(i));
      i += m[0].length;
      const value = m[0].endsWith('n') ? BigInt(m[0].slice(0,-1)) : Number(m[0]);
      tokens.push({kind:'literal', value,raw:m[0],start,end:i}); continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      i++; while (i < source.length && /[a-zA-Z0-9_$]/.test(source[i])) i++;
      const value = source.slice(start,i);
      tokens.push({kind:'word',value,start,end:i}); continue;
    }
    const op = ops.find(x => source.startsWith(x,i)) ?? (singles.includes(c) ? c : null);
    if (!op) throw new SyntaxError(`Unsupported token at offset ${i}: ${c}`);
    i += op.length; tokens.push({kind:'punct',value:op,start,end:i});
  }
  tokens.push({kind:'eof',value:'<eof>',start:i,end:i}); return tokens;
}
const precedence = { '||':1, '??':1, '&&':2, '==':3,'!=':3,'===':3,'!==':3,'<':4,'<=':4,'>':4,'>=':4,'+':5,'-':5,'*':6,'/':6,'%':6,'**':7 };
export function parse(source) {
  const t = lex(source); let p = 0;
  const peek = () => t[p];
  const take = () => t[p++];
  const match = x => peek().value === x && (p++, true);
  const need = x => { if (!match(x)) throw new SyntaxError(`Expected ${x}, got ${peek().value} at ${peek().start}`); };
  const name = () => { const x = take(); if (x.kind !== 'word' || ['const','let','var','return','await','function','if','else','while','throw','try','catch','finally','break','continue','typeof','this','async','true','false','null','new'].includes(x.value)) throw new SyntaxError(`Expected identifier at ${x.start}`); return x.value; };
  const semi = () => { if (match(';') || peek().value === '}' || peek().kind === 'eof') return; throw new SyntaxError(`Expected ; at ${peek().start} (automatic semicolon insertion not implemented)`); };
  function primary() {
    const x = take();
    if (x.kind === 'literal') return {type:'Literal',value:encode(x.value),raw:x.raw,start:x.start,end:x.end};
    if (x.value === 'true' || x.value === 'false' || x.value === 'null') return {type:'Literal',value:encode(x.value === 'true'?true:x.value === 'false'?false:null),raw:x.value,start:x.start,end:x.end};
    if (x.value === 'this') return {type:'This',start:x.start,end:x.end};
    if (x.value === 'await') return {type:'Await',argument:expression(8),start:x.start,end:t[p-1].end};
    if (x.value === 'new') {
      const callee=take();
      if(!['Proxy','Set','Promise','SharedArrayBuffer','Int32Array'].includes(callee.value))
        throw new SyntaxError('Unsupported bounded constructor');
      need('(');
      const args=[];if(!match(')')){do{args.push(expression(0,false));}while(match(','));need(')');}
      if(callee.value==='Proxy'){
        if(args.length!==2)throw new SyntaxError('new Proxy needs target and handler');
        return {type:'Proxy',target:args[0],handler:args[1],start:x.start,end:t[p-1].end};
      }
      if(args.length>1)throw new SyntaxError('Bounded constructor takes at most one argument');
      return {type:'Construct',callee:callee.value,args,start:x.start,end:t[p-1].end};
    }
    if (['!','-','+','typeof'].includes(x.value)) return {type:'Unary',operator:x.value,argument:expression(8),start:x.start,end:t[p-1].end};
    if (x.value === '(') { const e = expression(); need(')'); return {...e,parenthesized:true}; }
    if (x.value === '[') { const elements=[]; if(!match(']')){do{elements.push(expression(0,false));}while(match(','));need(']');} return {type:'Array',elements,start:x.start,end:t[p-1].end}; }
    if (x.value === '{') { const properties=[]; if(!match('}')){do{ const k=take(); if(k.kind!=='word'&&k.kind!=='literal')throw new SyntaxError('Invalid object key'); need(':'); if(String(k.value)==='__proto__')throw new SyntaxError('Object-literal prototype setters are not implemented');properties.push({key:String(k.value),value:expression(0,false)}); }while(match(','));need('}');}return {type:'Object',properties,start:x.start,end:t[p-1].end}; }
    if (x.kind === 'word') return {type:'Identifier',name:x.value,start:x.start,end:x.end};
    throw new SyntaxError(`Unexpected token ${x.value} at ${x.start}`);
  }
  function expression(min=0, allowComma=true) {
    let left=primary();
    for (;;) {
      if (peek().value === '.' && 9 >= min) { take(); const key=take(); if(key.kind!=='word') throw new SyntaxError('Expected property name');left={type:'Member',object:left,property:{type:'Literal',value:encode(key.value),start:key.start,end:key.end},start:left.start,end:key.end};continue; }
      if (peek().value === '[' && 9>=min) {take();const key=expression();need(']');left={type:'Member',object:left,property:key,start:left.start,end:t[p-1].end};continue;}
      if (peek().value === '(' && 9>=min) {take();const args=[];if(!match(')')){do{args.push(expression(0,false));}while(match(','));need(')');}left={type:'Call',callee:left,args,start:left.start,end:t[p-1].end};continue;}
      const op=peek().value;
      if (['=','+=','-='].includes(op) && min<=0) {take(); const right=expression(0);if(!['Identifier','Member'].includes(left.type))throw new SyntaxError('Invalid assignment target');left={type:'Assign',operator:op,left,right,start:left.start,end:right.end};continue;}
      const prec=precedence[op];if (!prec || prec < min) break;
      if(op==='**' && ['Unary','Await'].includes(left.type) && !left.parenthesized)
        throw new SyntaxError('Unparenthesized unary expression before exponentiation');
      take(); const right=expression(prec+(op==='**'?0:1));left={type:'Binary',operator:op,left,right,start:left.start,end:right.end};
    }
    return left;
  }
  function block() {const first=peek();need('{');const body=[];while(peek().value!=='}'){if(peek().kind==='eof')throw new SyntaxError('Unclosed block');body.push(statement());}need('}');return {type:'Block',body,start:first.start,end:t[p-1].end};}
  function statement() {
    const x=peek();
    if(x.value==='{')return block();
    if(x.value==='async' && t[p+1].value==='function' || x.value==='function') {
      const async=match('async');need('function');const id=name();need('(');const params=[];if(!match(')')){do{params.push(name());}while(match(','));need(')');}const body=block();return {type:'Function',id,params,async,body,start:x.start,end:body.end};
    }
    if(['let','const','var'].includes(x.value)){take();const id=name();let init=null;if(match('='))init=expression();if(x.value==='const'&&!init)throw new SyntaxError('const requires initializer');semi();return {type:'Variable',kind:x.value,id,init,start:x.start,end:t[p-1].end};}
    if(match('return')) {const argument=[';','}','<eof>'].includes(peek().value)?null:expression();semi();return {type:'Return',argument,start:x.start,end:t[p-1].end};}
    if(match('throw')) {const argument=expression();semi();return {type:'Throw',argument,start:x.start,end:t[p-1].end};}
    if(match('try')){
      const blockBody=block();let handler=null,finalizer=null;
      if(match('catch')){
        let param=null;
        if(match('(')){param=name();need(')');}
        const body=block();
        if(param && body.body.some(n=>(n.type==='Variable' && n.kind!=='var' || n.type==='Function') && n.id===param))
          throw new SyntaxError('Duplicate catch parameter declaration');
        handler={param,body};
      }
      if(match('finally'))finalizer=block();
      if(!handler&&!finalizer)throw new SyntaxError('try requires catch or finally');
      return {type:'Try',block:blockBody,handler,finalizer,start:x.start,end:t[p-1].end};
    }
    if(match('break')){semi();return {type:'Break',start:x.start,end:t[p-1].end};}
    if(match('continue')){semi();return {type:'Continue',start:x.start,end:t[p-1].end};}
    if(match('if')){need('(');const test=expression();need(')');const consequent=statement();const alternate=match('else')?statement():null;return {type:'If',test,consequent,alternate,start:x.start,end:t[p-1].end};}
    if(match('while')){need('(');const test=expression();need(')');const body=statement();return {type:'While',test,body,start:x.start,end:t[p-1].end};}
    if(match(';'))return {type:'Empty',start:x.start,end:x.end};
    const expr=expression();semi();return {type:'Expression',expr,start:x.start,end:t[p-1].end};
  }
  const body=[];while(peek().kind!=='eof')body.push(statement());return {type:'Program',body,start:0,end:source.length};
}
let site=0;
export function compile(ast) {
  site=0;const programs={};let next=0;
  function bodyProgram(body,params=[],async=false,defaults=[],restIndex=-1) {
    const id=`code${++next}`, instructions=[];let loopDepth=0,forOfIndex=0;
    const emit=(op,arg,node)=>{const inst={op,arg,siteId:`s${++site}`,start:node?.start??0,end:node?.end??0};instructions.push(inst);return instructions.length-1;};
    // Declarations are created before execution for a block's scope.
    function statements(nodes,scoped=false) {
      if(scoped) emit('ENTER_SCOPE',null,nodes[0]);
      for(const n of nodes){
        const declarations=n.type==='VariableGroup'?n.declarations:
          n.type==='PatternBinding'?n.bindings.map(b=>({
            id:b.name,kind:n.kind,start:b.start,end:b.end
          })):
          n.type==='Variable'?[n]:[];
        for(const d of declarations)if(d.kind!=='var')emit('DECLARE',{name:d.id,kind:d.kind},d);
      }
      for(const n of nodes)if(n.type==='Function'){
        const fid=bodyProgram(n.body.body,n.params,n.async,n.defaults,n.restIndex);
        emit('DEF_FN',{name:n.id,codeId:fid,params:n.params,async:n.async},n);
      }
      for(const n of nodes)if(n.type!=='Function')stmt(n);
      if(scoped)emit('LEAVE_SCOPE',null,nodes.at(-1));
    }
    function expr(n) {
      switch(n.type){
        case 'Literal': emit('CONST',{value:n.value,raw:n.raw},n);break;
        case 'OwnedPinnedRegExp':
          emit('NEW_PINNED_REGEXP',{pattern:n.pattern,flags:n.flags},n);break;
        case 'DeferredRegExp':
          emit('UNSUPPORTED_EXPRESSION','RegExp execution requires owned matching semantics',n);break;
        case 'Construct':
          emit('GET',n.callee,n);
          for(const a of n.args)expr(a);
          emit('CONSTRUCT',n.args.length,n);break;
        case 'FunctionExpr':{
          const codeId=bodyProgram(n.body.body,n.params,n.async,n.defaults,n.restIndex);
          emit('MAKE_FUNCTION',{codeId,arrow:n.arrow,async:n.async},n);
          break;
        }
        case 'Template':
          for(const expression of n.expressions)expr(expression);
          emit('TEMPLATE',{quasis:n.quasis,count:n.expressions.length},n);
          break;
        case 'Identifier':emit('GET',n.name,n);break;
        case 'This':emit('THIS',null,n);break;
        case 'Unary':
          // typeof of an identifier must inspect the binding without first
          // throwing on an unresolvable name. Owned TDZ remains observable.
          if(n.operator==='typeof' && n.argument.type==='Identifier')
            emit('TYPEOF_BINDING',n.argument.name,n);
          else {expr(n.argument);emit('UNARY',n.operator,n);}
          break;
        case 'Update':
          if(n.argument){
            expr(n.argument.object);expr(n.argument.property);
            emit('UPDATE_PROP',{operator:n.operator,prefix:n.prefix},n);
          }else emit('UPDATE_BINDING',{name:n.name,operator:n.operator,prefix:n.prefix},n);
          break;
        case 'Sequence':
          for(const [i,element] of n.expressions.entries()){
            expr(element);
            if(i<n.expressions.length-1)emit('POP',null,element);
          }
          break;
        case 'Conditional':{
          expr(n.test);
          const no=emit('JUMP_IF_FALSE',null,n.test);
          expr(n.consequent);
          const done=emit('JUMP',null,n);
          instructions[no].arg=instructions.length;
          expr(n.alternate);
          instructions[done].arg=instructions.length;
          break;
        }
        case 'Await':expr(n.argument);emit('AWAIT',null,n);break;
        case 'Binary':
          if(['&&','||','??'].includes(n.operator)) {expr(n.left);const j=emit('LOGICAL_JUMP',{operator:n.operator,to:null},n);emit('POP',null,n);expr(n.right);instructions[j].arg.to=instructions.length;}
          else {expr(n.left);expr(n.right);emit('BINARY',n.operator,n);}break;
        case 'OptionalChain':{
          expr(n.base);
          const exits=[];
          for(let i=0;i<n.steps.length;i++){
            const step=n.steps[i];
            if(step.optional){
              // LOGICAL_JUMP ?? branches only for non-nullish owned tokens.
              // Nullish paths skip all remaining calls and computed keys.
              const guard=emit('LOGICAL_JUMP',{operator:'??',to:null},step);
              emit('POP',null,step);
              emit('CONST',{value:['undefined']},step);
              exits.push(emit('JUMP',null,step));
              instructions[guard].arg.to=instructions.length;
            }
            if(step.type==='member'){
              expr(step.property);
              emit(n.steps[i+1]?.type==='call'?'GET_METHOD':'GET_PROP',null,step);
            }else{
              for(const a of step.args)expr(a.type==='Spread'?a.argument:a);
              emit('CALL',step.args.some(a=>a.type==='Spread')?
                {count:step.args.length,
                  spread:step.args.flatMap((a,j)=>a.type==='Spread'?[j]:[])}:
                step.args.length,step);
            }
          }
          for(const jump of exits)instructions[jump].arg=instructions.length;
          break;
        }
        case 'Member':expr(n.object);expr(n.property);emit('GET_PROP',null,n);break;
        case 'Call':
          if(n.callee.type==='Member'){expr(n.callee.object);expr(n.callee.property);emit('GET_METHOD',null,n.callee);}else expr(n.callee);
          for(const a of n.args)expr(a.type==='Spread'?a.argument:a);
          emit('CALL',n.args.some(a=>a.type==='Spread')?
            {count:n.args.length,spread:n.args.flatMap((a,i)=>a.type==='Spread'?[i]:[])}:
            n.args.length,n);break;
        case 'Proxy':expr(n.target);expr(n.handler);emit('NEW_PROXY',null,n);break;
        case 'Array':emit('NEW_ARRAY',null,n);for(let i=0;i<n.elements.length;i++){emit('DUP',null,n);emit('CONST',{value:['str',String(i)]},n);expr(n.elements[i]);emit('PUT_PROP',null,n);emit('POP',null,n);}break;
        case 'Object':emit('NEW_OBJECT',null,n);for(const item of n.properties){emit('DUP',null,n);emit('CONST',{value:['str',item.key]},n);expr(item.value);emit('PUT_PROP',null,n);emit('POP',null,n);}break;
        case 'Assign':
          if(['&&=','||=','??='].includes(n.operator)){
            const operator=n.operator.slice(0,-1);
            if(n.left.type==='Identifier'){
              emit('GET',n.left.name,n.left);
              const guard=emit('LOGICAL_JUMP',{operator,to:null},n);
              emit('POP',null,n);
              expr(n.right);
              emit('SET',n.left.name,n);
              instructions[guard].arg.to=instructions.length;
            }else{
              // Preserve the receiver and key in inaccessible lexical cells.
              // Both are evaluated exactly once, even when RHS is skipped.
              const salt=++forOfIndex;
              const receiver='[[logical receiver '+salt+']]';
              const property='[[logical key '+salt+']]';
              emit('ENTER_SCOPE',null,n);
              emit('DECLARE',{name:receiver,kind:'const'},n.left);
              emit('DECLARE',{name:property,kind:'const'},n.left);
              expr(n.left.object);emit('INIT',receiver,n.left.object);
              expr(n.left.property);emit('INIT',property,n.left.property);
              emit('GET',receiver,n.left);
              emit('GET',property,n.left);
              emit('GET_PROP',null,n.left);
              const guard=emit('LOGICAL_JUMP',{operator,to:null},n);
              emit('POP',null,n);
              emit('GET',receiver,n.left);
              emit('GET',property,n.left);
              expr(n.right);
              emit('PUT_PROP',null,n);
              instructions[guard].arg.to=instructions.length;
              emit('LEAVE_SCOPE',null,n);
            }
            break;
          }
          if(n.left.type==='Identifier') {
            if(n.operator!=='=')emit('GET',n.left.name,n.left);
            expr(n.right);if(n.operator!== '=')emit('BINARY',n.operator.slice(0,-1),n);
            emit('SET',n.left.name,n);
          }else{
            expr(n.left.object);expr(n.left.property);
            if(n.operator!=='='){
              // Preserve the reference; computed keys and getters run once.
              emit('DUP2',null,n.left);
              emit('GET_PROP',null,n.left);
            }
            expr(n.right);
            if(n.operator!=='=')emit('BINARY',n.operator.slice(0,-1),n);
            emit('PUT_PROP',null,n);
          }break;
        default:throw new SyntaxError(`Unsupported expression: ${n.type}`);
      }
    }
    function stmt(n){
      switch(n.type){
        case 'Variable':{
          if(n.kind==='var'){
            if(n.init){expr(n.init);emit('SET',n.id,n);emit('POP',null,n);}
          }else{
            if(n.init)expr(n.init);else emit('CONST',{value:['undefined']},n);
            emit('INIT',n.id,n);
          }
          break;
        }
        case 'VariableGroup':for(const declaration of n.declarations)stmt(declaration);break;
        case 'PatternBinding':{
          // Every nested initializer/get/default remains an owned bytecode
          // effect. Hidden generated names are inaccessible to guest syntax.
          // The temporary scope is distinct from the lexical declarations.
          emit('ENTER_SCOPE',null,n);
          const temporary=node=>{
            const name='[[pattern '+(++forOfIndex)+']]';
            emit('DECLARE',{name,kind:'let'},node);
            return name;
          };
          function bindPattern(pattern,variable){
            if(pattern.type==='PatternName'){
              emit('GET',variable,pattern);
              emit(n.kind==='var'?'SET':'INIT',pattern.name,pattern);
              if(n.kind==='var')emit('POP',null,pattern);
              return;
            }
            if(pattern.type==='PatternDefault'){
              emit('GET',variable,pattern);
              emit('CONST',{value:['undefined']},pattern);
              emit('BINARY','===',pattern);
              const skip=emit('JUMP_IF_FALSE',null,pattern);
              expr(pattern.fallback);
              emit('SET',variable,pattern);
              emit('POP',null,pattern);
              instructions[skip].arg=instructions.length;
              bindPattern(pattern.target,variable);
              return;
            }
            if(pattern.type==='PatternArray'){
              emit('GET','Array',pattern);
              emit('CONST',{value:['str','isArray']},pattern);
              emit('GET_METHOD',null,pattern);
              emit('GET',variable,pattern);
              emit('CALL',1,pattern);
              const invalid=emit('JUMP_IF_FALSE',null,pattern);
              const accepted=emit('JUMP',null,pattern);
              instructions[invalid].arg=instructions.length;
              emit('UNSUPPORTED_EXPRESSION',
                'Array binding requires an owned standard array',pattern);
              instructions[accepted].arg=instructions.length;
              for(const entry of pattern.elements){
                const child=temporary(entry);
                emit('GET',variable,entry);
                emit('CONST',{value:['num',entry.index]},entry);
                emit('GET_PROP',null,entry);
                emit('INIT',child,entry);
                bindPattern(entry.target,child);
              }
              return;
            }
            if(pattern.type==='PatternObject'){
              for(const entry of pattern.entries){
                const child=temporary(entry);
                emit('GET',variable,entry);
                if(entry.computedKey)expr(entry.computedKey);
                else emit('CONST',{value:['str',entry.key]},entry);
                emit('GET_PROP',null,entry);
                emit('INIT',child,entry);
                bindPattern(entry.target,child);
              }
              return;
            }
            throw new SyntaxError('Unsupported pattern shape: '+pattern.type);
          }
          const root=temporary(n);
          expr(n.init);emit('INIT',root,n);
          bindPattern(n.pattern,root);
          emit('LEAVE_SCOPE',null,n);
          break;
        }
        case 'Expression':expr(n.expr);emit('POP',null,n);break;
        case 'Return':if(n.argument)expr(n.argument);else emit('CONST',{value:['undefined']},n);emit('RETURN',null,n);break;
        case 'Throw':expr(n.argument);emit('THROW',null,n);break;
        case 'Block':statements(n.body,true);break;
        case 'Switch':{
          // Each declared arm returns: discriminant once and no fallthrough.
          expr(n.discriminant);
          const fallback=n.cases.find(c=>!c.test);
          for(const c of n.cases){
            if(!c.test)continue;
            emit('DUP',null,c.test);
            expr(c.test);
            emit('BINARY','===',n);
            const next=emit('JUMP_IF_FALSE',null,n);
            emit('POP',null,c.test);
            stmt(c.body);
            instructions[next].arg=instructions.length;
          }
          emit('POP',null,n);
          if(fallback)stmt(fallback.body);
          break;
        }
        case 'If':{expr(n.test);const no=emit('JUMP_IF_FALSE',null,n.test);stmt(n.consequent);if(n.alternate){const end=emit('JUMP',null,n);instructions[no].arg=instructions.length;stmt(n.alternate);instructions[end].arg=instructions.length;}else instructions[no].arg=instructions.length;break;}
        case 'While':{
          const entry=emit('LOOP_ENTER',null,n),top=instructions.length;
          expr(n.test);const no=emit('JUMP_IF_FALSE',null,n.test);
          loopDepth++;stmt(n.body);loopDepth--;
          emit('JUMP',top,n);
          const end=instructions.length;emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:top};
          instructions[no].arg=end;break;
        }
        case 'DoWhile':{
          const entry=emit('LOOP_ENTER',null,n),top=instructions.length;
          loopDepth++;stmt(n.body);loopDepth--;
          const testPc=instructions.length;
          expr(n.test);
          const no=emit('JUMP_IF_FALSE',null,n.test);
          emit('JUMP',top,n);
          const end=instructions.length;
          emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:testPc};
          instructions[no].arg=end;
          break;
        }
        case 'ForOf':{
          // A fail-closed owned iterator slice: ordinary dense arrays only.
          // The hidden state names cannot be spelled by guest JavaScript and
          // retain one evaluated iterable across every iteration.
          const salt=++forOfIndex;
          const item=n.bindings?'[[for-of item '+salt+']]':n.id;
          const iterable='[[for-of iterable '+salt+']]';
          const index='[[for-of index '+salt+']]';
          emit('ENTER_SCOPE',null,n);
          emit('DECLARE',{name:iterable,kind:'let'},n);
          emit('DECLARE',{name:index,kind:'let'},n);
          expr(n.iterable);emit('INIT',iterable,n);
          emit('CONST',{value:['num',0]},n);emit('INIT',index,n);
          // An array iterator has observable built-in semantics distinct from
          // property enumeration. Never pretend arbitrary iterables are arrays.
          emit('GET','Array',n);
          emit('CONST',{value:['str','isArray']},n);
          emit('GET_METHOD',null,n);
          emit('GET',iterable,n);
          emit('CALL',1,n);
          const invalid=emit('JUMP_IF_FALSE',null,n);
          const accepted=emit('JUMP',null,n);
          instructions[invalid].arg=instructions.length;
          emit('CONST',{value:['str','Unsupported for-of iterable: owned array required']},n);
          emit('THROW',null,n);
          instructions[accepted].arg=instructions.length;
          const entry=emit('LOOP_ENTER',null,n);
          const top=instructions.length;
          emit('GET',iterable,n);
          emit('CONST',{value:['str','length']},n);
          emit('GET_PROP',null,n);
          emit('GET',index,n);
          emit('BINARY','>',n); // array.length > index
          const no=emit('JUMP_IF_FALSE',null,n);
          if(n.kind!=='var'){
            emit('ENTER_SCOPE',null,n);
            emit('DECLARE',{name:item,kind:n.kind},n);
            for(const binding of n.bindings??[])
              emit('DECLARE',{name:binding.name,kind:n.kind},binding);
          }
          emit('GET',iterable,n);
          emit('GET',index,n);
          emit('GET_PROP',null,n);
          emit(n.kind==='var'?'SET':'INIT',item,n);
          if(n.kind==='var')emit('POP',null,n);
          if(n.bindings){
            // For each iteration the fresh lexical scope owns both the
            // iterator value and each destructured lexical capture.
            emit('GET','Array',n);
            emit('CONST',{value:['str','isArray']},n);
            emit('GET_METHOD',null,n);
            emit('GET',item,n);
            emit('CALL',1,n);
            const invalidItem=emit('JUMP_IF_FALSE',null,n);
            const acceptedItem=emit('JUMP',null,n);
            instructions[invalidItem].arg=instructions.length;
            emit('UNSUPPORTED_EXPRESSION',
              'for-of array binding requires an owned array item',n);
            instructions[acceptedItem].arg=instructions.length;
            for(const binding of n.bindings){
              emit('GET',item,binding);
              emit('CONST',{value:['num',binding.index]},binding);
              emit('GET_PROP',null,binding);
              if(binding.fallback){
                emit('DUP',null,binding);
                emit('CONST',{value:['undefined']},binding);
                emit('BINARY','===',binding);
                const skip=emit('JUMP_IF_FALSE',null,binding);
                emit('POP',null,binding);
                expr(binding.fallback);
                instructions[skip].arg=instructions.length;
              }
              emit('INIT',binding.name,binding);
            }
          }
          loopDepth++;stmt(n.body);loopDepth--;
          if(n.kind!=='var')emit('LEAVE_SCOPE',null,n);
          const updatePc=instructions.length;
          emit('UPDATE_BINDING',{name:index,operator:'++',prefix:true},n);
          emit('POP',null,n);
          emit('JUMP',top,n);
          const end=instructions.length;
          emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:updatePc};
          instructions[no].arg=end;
          emit('LEAVE_SCOPE',null,n);
          break;
        }
        case 'For':{
          const declarations=n.init?.type==='VariableGroup'?n.init.declarations:
            n.init?.type==='Variable'?[n.init]:[];
          const lexical=declarations[0]?.kind==='let';
          const loopNames=declarations.map(d=>d.id);
          if(lexical){
            emit('ENTER_SCOPE',null,n);
            for(const d of declarations)emit('DECLARE',{name:d.id,kind:d.kind},d);
          }
          if(n.init){
            if(['Variable','VariableGroup'].includes(n.init.type))stmt(n.init);
            else{expr(n.init);emit('POP',null,n.init);}
          }
          const entry=emit('LOOP_ENTER',null,n);
          // ECMA-262 CreatePerIterationEnvironment: a new captured binding
          // before the first test and again between each body and update.
          if(lexical)emit('CLONE_LOOP_ENV',loopNames,n);
          const top=instructions.length;
          const no=n.test?(expr(n.test),emit('JUMP_IF_FALSE',null,n.test)):null;
          loopDepth++;stmt(n.body);loopDepth--;
          const updatePc=instructions.length;
          if(lexical)emit('CLONE_LOOP_ENV',loopNames,n);
          if(n.update){expr(n.update);emit('POP',null,n.update);}
          emit('JUMP',top,n);
          const end=instructions.length;
          emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:updatePc};
          if(no!==null)instructions[no].arg=end;
          if(lexical)emit('LEAVE_SCOPE',null,n);
          break;
        }
        case 'Break':case 'Continue':
          if(!loopDepth)throw new SyntaxError(n.type.toLowerCase()+' outside loop');
          emit('LOOP_JUMP',n.type.toLowerCase(),n);break;
        case 'Try':{
          const entry=emit('TRY_ENTER',null,n);
          stmt(n.block);emit('TRY_NORMAL',null,n.block);
          let catchPc=null,finallyPc=null;
          if(n.handler){
            catchPc=instructions.length;
            emit('BIND_CATCH',n.handler.param,n.handler.body);
            // A catch parameter and its top-level block declarations share
            // one lexical environment, so duplicate names cannot shadow it.
            statements(n.handler.body.body);
            emit('TRY_NORMAL',null,n.handler.body);
          }
          if(n.finalizer){
            finallyPc=instructions.length;
            stmt(n.finalizer);emit('END_FINALLY',null,n.finalizer);
          }
          instructions[entry].arg={catchPc,finallyPc,afterPc:instructions.length};
          break;
        }
        case 'Empty':break;
        default:throw new SyntaxError(`Unsupported statement: ${n.type}`);
      }
    }
    // Default parameters evaluate in left-to-right order, only when the
    // argument value is undefined. The profile rejects references to later
    // parameter bindings and body locals requiring an unmodeled TDZ.
    defaults.forEach((initializer,i)=>{
      if(!initializer)return;
      const guard=emit('DEFAULT_GUARD',{name:params[i],skipPc:null},initializer);
      expr(initializer);
      emit('SET',params[i],initializer);
      emit('POP',null,initializer);
      instructions[guard].arg.skipPc=instructions.length;
    });
    statements(body);
    emit('CONST',{value:['undefined']},ast);emit('RETURN',null,ast);
    programs[id]={id,params,restIndex,async,varNames:collectVarBindings(body),instructions};return id;
  }
  const entry=bodyProgram(ast.body);
  return {entry,programs,sites:Object.values(programs).flatMap(x=>x.instructions.map(({siteId,start,end,op})=>({siteId,start,end,op,codeId:x.id})))};
}
