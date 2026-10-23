// Deliberately bounded grammar; unsupported syntax fails closed, never through native eval.
import { encode } from './values.js';
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
      if(callee.value!=='Proxy')throw new SyntaxError('Only new Proxy(target, handler) is implemented');
      need('(');
      const args=[];if(!match(')')){do{args.push(expression(0,false));}while(match(','));need(')');}
      if(args.length!==2)throw new SyntaxError('new Proxy needs target and handler');
      return {type:'Proxy',target:args[0],handler:args[1],start:x.start,end:t[p-1].end};
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
  function bodyProgram(body,params=[],async=false) {
    const id=`code${++next}`, instructions=[];let loopDepth=0;
    const emit=(op,arg,node)=>{const inst={op,arg,siteId:`s${++site}`,start:node?.start??0,end:node?.end??0};instructions.push(inst);return instructions.length-1;};
    // Declarations are created before execution for a block's scope.
    function statements(nodes,scoped=false) {
      if(scoped) emit('ENTER_SCOPE',null,nodes[0]);
      for(const n of nodes){
        const declarations=n.type==='VariableGroup'?n.declarations:
          n.type==='Variable'?[n]:[];
        for(const d of declarations)emit('DECLARE',{name:d.id,kind:d.kind},d);
      }
      for(const n of nodes)if(n.type==='Function'){
        const fid=bodyProgram(n.body.body,n.params,n.async);
        emit('DEF_FN',{name:n.id,codeId:fid,params:n.params,async:n.async},n);
      }
      for(const n of nodes)if(n.type!=='Function')stmt(n);
      if(scoped)emit('LEAVE_SCOPE',null,nodes.at(-1));
    }
    function expr(n) {
      switch(n.type){
        case 'Literal': emit('CONST',{value:n.value,raw:n.raw},n);break;
        case 'FunctionExpr':{
          const codeId=bodyProgram(n.body.body,n.params,false);
          emit('MAKE_FUNCTION',{codeId,arrow:n.arrow},n);
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
        case 'Member':expr(n.object);expr(n.property);emit('GET_PROP',null,n);break;
        case 'Call':
          if(n.callee.type==='Member'){expr(n.callee.object);expr(n.callee.property);emit('GET_METHOD',null,n.callee);}else expr(n.callee);
          for(const a of n.args)expr(a);emit('CALL',n.args.length,n);break;
        case 'Proxy':expr(n.target);expr(n.handler);emit('NEW_PROXY',null,n);break;
        case 'Array':emit('NEW_ARRAY',null,n);for(let i=0;i<n.elements.length;i++){emit('DUP',null,n);emit('CONST',{value:['str',String(i)]},n);expr(n.elements[i]);emit('PUT_PROP',null,n);emit('POP',null,n);}break;
        case 'Object':emit('NEW_OBJECT',null,n);for(const item of n.properties){emit('DUP',null,n);emit('CONST',{value:['str',item.key]},n);expr(item.value);emit('PUT_PROP',null,n);emit('POP',null,n);}break;
        case 'Assign':
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
        case 'Variable':if(n.init)expr(n.init);else emit('CONST',{value:['undefined']},n);emit('INIT',n.id,n);break;
        case 'VariableGroup':for(const declaration of n.declarations)stmt(declaration);break;
        case 'Expression':expr(n.expr);emit('POP',null,n);break;
        case 'Return':if(n.argument)expr(n.argument);else emit('CONST',{value:['undefined']},n);emit('RETURN',null,n);break;
        case 'Throw':expr(n.argument);emit('THROW',null,n);break;
        case 'Block':statements(n.body,true);break;
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
        case 'For':{
          const lexical=n.init?.type==='Variable';
          if(lexical){
            emit('ENTER_SCOPE',null,n);
            emit('DECLARE',{name:n.init.id,kind:n.init.kind},n.init);
          }
          if(n.init){
            if(lexical)stmt(n.init);
            else{expr(n.init);emit('POP',null,n.init);}
          }
          const entry=emit('LOOP_ENTER',null,n);
          // ECMA-262 CreatePerIterationEnvironment: a new captured binding
          // before the first test and again between each body and update.
          if(lexical)emit('CLONE_LOOP_ENV',n.init.id,n);
          const top=instructions.length;
          const no=n.test?(expr(n.test),emit('JUMP_IF_FALSE',null,n.test)):null;
          loopDepth++;stmt(n.body);loopDepth--;
          const updatePc=instructions.length;
          if(lexical)emit('CLONE_LOOP_ENV',n.init.id,n);
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
    statements(body);
    emit('CONST',{value:['undefined']},ast);emit('RETURN',null,ast);
    programs[id]={id,params,async,instructions};return id;
  }
  const entry=bodyProgram(ast.body);
  return {entry,programs,sites:Object.values(programs).flatMap(x=>x.instructions.map(({siteId,start,end,op})=>({siteId,start,end,op,codeId:x.id})))};
}
