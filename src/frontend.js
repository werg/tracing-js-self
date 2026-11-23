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
      case 'ForIn':case 'ForOf':if(n.kind==='var')for(const name of n.bindings?n.bindings.map(b=>b.name):[n.id])names.add(name);visit(n.body);break;
      case 'While':case 'DoWhile':case 'Label':visit(n.body);break;
      case 'Switch':for(const c of n.cases)c.body.forEach(visit);break;
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
const SHARED_CONSTRUCTORS=new Set(['Int8Array','Uint8Array','Int16Array','Uint16Array',
 'Int32Array','Uint32Array','BigInt64Array','BigUint64Array','Float32Array','Float64Array']);
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
    if(x.value==='function'||(x.value==='async'&&peek().value==='function')){
      const async=x.value==='async';
      if(async)need('function');
      const localName=peek().value==='('?null:name();
      need('(');const params=[];
      if(!match(')')){do{params.push(name());}while(match(','));need(')');}
      const body=block();
      return {type:'FunctionExpr',params,async,arrow:false,name:localName,body,start:x.start,end:body.end};
    }
    if (x.value === 'new') {
      const callee=take();
      if(!['Proxy','Set','Promise','ArrayBuffer','SharedArrayBuffer','DataView'].includes(callee.value)&&!SHARED_CONSTRUCTORS.has(callee.value))
        throw new SyntaxError('Unsupported bounded constructor');
      need('(');
      const args=[];if(!match(')')){do{args.push(expression(0,false));}while(match(','));need(')');}
      if(callee.value==='Proxy'){
        if(args.length!==2)throw new SyntaxError('new Proxy needs target and handler');
        return {type:'Proxy',target:args[0],handler:args[1],start:x.start,end:t[p-1].end};
      }
      if(args.length>3)throw new SyntaxError('Bounded constructor argument budget');
      return {type:'Construct',callee:callee.value,args,start:x.start,end:t[p-1].end};
    }
    if (['!','-','+','typeof','delete'].includes(x.value)) return {type:'Unary',operator:x.value,argument:expression(8),start:x.start,end:t[p-1].end};
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
  function bodyProgram(body,params=[],async=false,defaults=[],restIndex=-1,inheritedStrict=false,parameterSites=[],parameterPatterns=[],generator=false,classConstructor=false) {
    // Strictness belongs to the lexical code, not to the caller. Only an
    // unescaped, unparenthesized string in the directive prologue enables it;
    // nested functions (including arrows/default initializers) inherit it.
    let strict=inheritedStrict;
    for(const node of body){
      if(node.type!=='Expression'||node.expr.type!=='Literal'||
         node.expr.value[0]!=='str'||node.expr.parenthesized||
         node.start!==node.expr.start)break;
      if(node.expr.raw==='"use strict"'||node.expr.raw==="'use strict'")strict=true;
    }
    const id=`code${++next}`, instructions=[];let loopDepth=0,forOfIndex=0;
    const emit=(op,arg,node)=>{const inst={op,arg,siteId:`s${++site}`,start:node?.start??0,end:node?.end??0};instructions.push(inst);return instructions.length-1;};
    // Declarations are created before execution for a block's scope.
    function predeclare(nodes) {
      for(const n of nodes){
        const declarations=(n.type==='VariableGroup'?n.declarations:[n]).flatMap(d=>
          d.type==='PatternBinding'?d.bindings.map(b=>({id:b.name,kind:d.kind,start:b.start,end:b.end})):
          ['Variable','ClassBinding'].includes(d.type)?[d]:[]);
        for(const d of declarations)if(d.kind!=='var')emit('DECLARE',{name:d.id,kind:d.kind},d);
      }
      for(const n of nodes)if(n.type==='Function'){
        const fid=bodyProgram(n.body.body,n.params,n.async,n.defaults,n.restIndex,strict,n.parameterSites,n.parameterPatterns,n.generator);
        emit('DEF_FN',{name:n.id,codeId:fid,params:n.params,async:n.async},n);
      }
    }
    function statements(nodes,scoped=false) {
      if(scoped)emit('ENTER_SCOPE',null,nodes[0]);
      predeclare(nodes);
      for(const n of nodes)if(n.type!=='Function')stmt(n);
      if(scoped)emit('LEAVE_SCOPE',null,nodes.at(-1));
    }
    function expr(n,inferredName=null) {
      switch(n.type){
        case 'Literal': emit('CONST',{value:n.value,raw:n.raw},n);break;
        case 'OwnedPinnedRegExp':
          emit('NEW_PINNED_REGEXP',{pattern:n.pattern,flags:n.flags},n);break;
        case 'DeferredRegExp':
          emit('UNSUPPORTED_EXPRESSION','RegExp execution requires owned matching semantics',n);break;
        case 'Construct':
          if(typeof n.callee==='string')emit('GET',n.callee,n);else expr(n.callee);
          for(const a of n.args)expr(a);
          emit('CONSTRUCT',n.args.length,n);break;
        case 'FunctionExpr':{
          const codeId=bodyProgram(n.body.body,n.params,n.async,n.defaults,n.restIndex,strict||n.strict===true,n.parameterSites,n.parameterPatterns,n.generator,n.classConstructor===true);
          emit('MAKE_FUNCTION',{codeId,arrow:n.arrow,async:n.async,nonConstructible:n.nonConstructible===true,...(n.name?{name:n.name}:n.generator&&inferredName!==null?{inferredName}:{})},n);
          break;
        }
        case 'ClassExpr':emitClass(n,inferredName);break;
        case 'PrivateMember':expr(n.object);emit('PRIVATE_GET',{name:n.name},n);break;
        case 'PrivateHas':expr(n.object);emit('PRIVATE_HAS',{name:n.name},n);break;
        case 'Yield':expr(n.argument);emit('YIELD',null,n);break;
        case 'YieldDelegate':emitYieldDelegate(n);break;
        case 'TaggedTemplate':
          if(n.tag.type==='PrivateMember'){expr(n.tag.object);emit('PRIVATE_GET_METHOD',{name:n.tag.name},n.tag);}
          else if(n.tag.type==='SuperMember'){superReference(n.tag);emit('SUPER_GET_METHOD',null,n.tag);}
          else if(n.tag.type==='Member'){expr(n.tag.object);expr(n.tag.property);emit('GET_METHOD',null,n.tag);}
          else expr(n.tag);
          emit('GET_TEMPLATE_OBJECT',{cooked:n.cooked,raw:n.raw},n);
          for(const expression of n.expressions)expr(expression);
          emit('CALL',n.expressions.length+1,n);break;
        case 'Template':
          for(const expression of n.expressions)expr(expression);
          emit('TEMPLATE',{quasis:n.quasis,count:n.expressions.length},n);
          break;
        case 'Identifier':emit('GET',n.name,n);break;
        case 'This':emit('THIS',null,n);break;
        case 'NewTarget':emit('NEW_TARGET',null,n);break;
        case 'Unary':
          // typeof of an identifier must inspect the binding without first
          // throwing on an unresolvable name. Owned TDZ remains observable.
          if(n.operator==='typeof' && n.argument.type==='Identifier')
            emit('TYPEOF_BINDING',n.argument.name,n);
          else if(n.operator==='delete'&&n.argument.type==='Member'){
            expr(n.argument.object);expr(n.argument.property);emit('DELETE_PROP',null,n);
          }else {expr(n.argument);emit('UNARY',n.operator,n);}
          break;
        case 'Update':
          if(n.argument?.type==='PrivateMember'){
            expr(n.argument.object);emit('PRIVATE_UPDATE',{name:n.argument.name,operator:n.operator,prefix:n.prefix},n);
          }else if(n.argument){
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
          if(n.operator==='instanceof'){
            const salt=++forOfIndex,left='[[instance value '+salt+']]',right='[[instance constructor '+salt+']]';
            emit('ENTER_SCOPE',null,n);for(const name of [left,right])emit('DECLARE',{name,kind:'const'},n);
            expr(n.left);emit('INIT',left,n);expr(n.right);emit('REQUIRE_OBJECT',null,n);emit('INIT',right,n);
            emit('GET',right,n);emit('CONST',{value:['symbol','well-known:hasInstance']},n);emit('GET_METHOD',null,n);
            const hook=emit('LOGICAL_JUMP',{operator:'??',to:null},n);emit('POP',null,n);
            emit('GET',left,n);emit('GET',right,n);emit('INSTANCEOF_DEFAULT',null,n);
            const done=emit('JUMP',null,n);instructions[hook].arg.to=instructions.length;
            emit('GET',left,n);emit('CALL',1,n);emit('INSTANCEOF_RESULT',null,n);
            instructions[done].arg=instructions.length;emit('LEAVE_SCOPE',null,n);break;
          }
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
              for(const a of step.args){
                expr(a.type==='Spread'?a.argument:a);
                if(a.type==='Spread')emit('SPREAD',null,a);
              }
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
        case 'SuperMember':superReference(n);emit('SUPER_GET',null,n);break;
        case 'SuperCall':
          emit('SUPER_CONSTRUCTOR',null,n);
          for(const argument of n.args){expr(argument.type==='Spread'?argument.argument:argument);if(argument.type==='Spread')emit('SPREAD',null,argument);}
          emit('SUPER_CALL',n.args.some(a=>a.type==='Spread')?{count:n.args.length,spread:n.args.flatMap((a,i)=>a.type==='Spread'?[i]:[])}:n.args.length,n);
          emit('SUPER_BIND',null,n);break;
        case 'Call':
          if(n.callee.type==='SuperMember'){superReference(n.callee);emit('SUPER_GET_METHOD',null,n.callee);}
          else if(n.callee.type==='PrivateMember'){expr(n.callee.object);emit('PRIVATE_GET_METHOD',{name:n.callee.name},n.callee);}else if(n.callee.type==='Member'){expr(n.callee.object);expr(n.callee.property);emit('GET_METHOD',null,n.callee);}else expr(n.callee);
          for(const a of n.args){
            expr(a.type==='Spread'?a.argument:a);
            if(a.type==='Spread')emit('SPREAD',null,a);
          }
          emit('CALL',n.args.some(a=>a.type==='Spread')?
            {count:n.args.length,spread:n.args.flatMap((a,i)=>a.type==='Spread'?[i]:[])}:
            n.args.length,n);break;
        case 'Proxy':expr(n.target);expr(n.handler);emit('NEW_PROXY',null,n);break;
        case 'Array':
          emit('NEW_ARRAY',n.elements.includes(null)&&!n.elements.some(element=>element?.type==='Spread')?
            {length:n.elements.length}:null,n);
          if(n.elements.some(element=>element?.type==='Spread')){
            // Commit each spread before evaluating the following element.
            // In particular, a later call may mutate the spread's source.
            for(const element of n.elements){
              emit('DUP',null,n);
              if(element===null)emit('CONST',{value:['undefined']},n);
              else expr(element.type==='Spread'?element.argument:element);
              if(element?.type==='Spread')emit('SPREAD',null,element);
              emit('APPEND_ARRAY',{spread:element?.type==='Spread',...(element===null?{hole:true}:{})},n);
              emit('POP',null,n);
            }
          }else for(let i=0;i<n.elements.length;i++){
            if(n.elements[i]===null)continue;
            emit('DUP',null,n);emit('CONST',{value:['str',String(i)]},n);
            expr(n.elements[i]);emit('PUT_PROP',null,n);emit('POP',null,n);
          }
          break;
        case 'Object':{
          const spreads=n.properties.some(item=>item.kind==='spread');
          let saved=null;
          if(spreads){
            emit('ENTER_SCOPE',null,n);saved='[[object '+(++forOfIndex)+']]';
            emit('DECLARE',{name:saved,kind:'const'},n);
          }
          emit('NEW_OBJECT',null,n);
          if(spreads)emit('INIT',saved,n);
          for(const item of n.properties){
            if(item.kind==='spread'){
              const source='[[spread '+(++forOfIndex)+']]';
              emit('DECLARE',{name:source,kind:'const'},item);
              expr(item.value);emit('INIT',source,item);copyOwn(saved,source,[],item);continue;
            }
            if(spreads)emit('GET',saved,n);else emit('DUP',null,n);
            if(item.computedKey){expr(item.computedKey);emit('PROPERTY_KEY',null,item.computedKey);}
            else emit('CONST',{value:['str',item.key]},n);
            expr(item.value,item.kind==='prototype'?null:{stack:true});
            if(item.value.nonConstructible&&containsSuperProperty(item.value))emit('SET_HOME_OBJECT',{offset:2},item);
            emit('DEFINE_LITERAL_PROP',{kind:item.kind??'init'},item.start===undefined?n:item);
            emit('POP',null,n);
          }
          if(spreads){emit('GET',saved,n);emit('LEAVE_SCOPE',null,n);}
          break;
        }
        case 'PatternAssignment':emitPattern(n,true);break;
        case 'Assign':
          if(n.left.type==='SuperMember'){
            superReference(n.left);
            if(n.operator!=='='){emit('DUP',null,n.left);emit('SUPER_GET',null,n.left);}
            expr(n.right);if(n.operator!=='=')emit('BINARY',n.operator.slice(0,-1),n);
            emit('SUPER_SET',null,n);break;
          }
          if(n.left.type==='PrivateMember'){
            const name=n.left.name;
            if(['&&=','||=','??='].includes(n.operator)){
              const saved='[[private receiver '+(++forOfIndex)+']]';
              emit('ENTER_SCOPE',null,n);emit('DECLARE',{name:saved,kind:'const'},n);
              expr(n.left.object);emit('INIT',saved,n);emit('GET',saved,n);emit('PRIVATE_GET',{name},n.left);
              const guard=emit('LOGICAL_JUMP',{operator:n.operator.slice(0,-1),to:null},n);
              emit('POP',null,n);emit('GET',saved,n);expr(n.right);emit('PRIVATE_SET',{name},n);
              instructions[guard].arg.to=instructions.length;emit('LEAVE_SCOPE',null,n);
            }else{
              expr(n.left.object);
              if(n.operator!=='='){emit('DUP',null,n);emit('PRIVATE_GET',{name},n.left);}
              expr(n.right);if(n.operator!=='=')emit('BINARY',n.operator.slice(0,-1),n);
              emit('PRIVATE_SET',{name},n);
            }
            break;
          }
          if(['&&=','||=','??='].includes(n.operator)){
            const operator=n.operator.slice(0,-1);
            if(n.left.type==='Identifier'){
              emit('GET',n.left.name,n.left);
              const guard=emit('LOGICAL_JUMP',{operator,to:null},n);
              emit('POP',null,n);
              expr(n.right,n.left.name);
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
              emit('GET_PROP',{cachePropertyKey:property},n.left);
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
            expr(n.right,n.operator==='='?n.left.name:null);if(n.operator!== '=')emit('BINARY',n.operator.slice(0,-1),n);
            emit('SET',n.left.name,n);
          }else{
            expr(n.left.object);expr(n.left.property);
            if(n.operator!=='='){
              // Preserve the reference; computed keys and getters run once.
              emit('DUP2',{cachePropertyKey:true},n.left);
              emit('GET_PROP',null,n.left);
            }
            expr(n.right);
            if(n.operator!=='=')emit('BINARY',n.operator.slice(0,-1),n);
            emit('PUT_PROP',null,n);
          }break;
        default:throw new SyntaxError(`Unsupported expression: ${n.type}`);
      }
    }
    function superReference(n){emit('THIS',null,n);expr(n.property);emit('SUPER_REFERENCE',null,n);}
    function containsSuperProperty(node){
      return node!==null&&typeof node==='object'&&(node.type==='SuperMember'||Object.values(node).some(value=>
        Array.isArray(value)?value.some(containsSuperProperty):containsSuperProperty(value)));
    }
    // CopyDataProperties snapshots key identities, then rechecks each own
    // descriptor before reading. Each getter is an ordinary owned GET_PROP
    // continuation, so later throws never replay already completed reads.
    function copyOwn(target,source,excluded,node,{required=false}={}){
      const salt=++forOfIndex,keys='[[copy keys '+salt+']]',index='[[copy index '+salt+']]',key='[[copy key '+salt+']]';
      for(const name of [keys,index,key])emit('DECLARE',{name,kind:'let'},node);
      emit('GET',source,node);for(const name of excluded)emit('GET',name,node);
      emit('COPY_KEYS',{exclude:excluded.length,required},node);emit('INIT',keys,node);
      emit('CONST',{value:['num',0]},node);emit('INIT',index,node);
      emit('CONST',{value:['undefined']},node);emit('INIT',key,node);
      const top=instructions.length;
      emit('GET',keys,node);emit('CONST',{value:['str','length']},node);emit('GET_PROP',null,node);
      emit('GET',index,node);emit('BINARY','>',node);const done=emit('JUMP_IF_FALSE',null,node);
      emit('GET',keys,node);emit('GET',index,node);emit('GET_PROP',null,node);emit('SET',key,node);emit('POP',null,node);
      emit('GET',source,node);emit('GET',key,node);emit('HAS_ENUMERABLE_OWN',null,node);
      const skip=emit('JUMP_IF_FALSE',null,node);
      emit('GET',target,node);emit('GET',key,node);emit('GET',source,node);emit('GET',key,node);
      emit('GET_PROP',null,node);emit('DEFINE_LITERAL_PROP',{kind:'init'},node);emit('POP',null,node);
      instructions[skip].arg=instructions.length;
      emit('UPDATE_BINDING',{name:index,operator:'++',prefix:true},node);emit('POP',null,node);
      emit('JUMP',top,node);instructions[done].arg=instructions.length;
    }
    function emitYieldDelegate(n){
      const salt=++forOfIndex,iterator='[[delegate '+salt+']]',next='[[delegate next '+salt+']]',
        kind='[[delegate kind '+salt+']]',sent='[[delegate sent '+salt+']]',step='[[delegate step '+salt+']]';
      emit('ENTER_SCOPE',null,n);
      for(const name of [iterator,next,kind,sent,step])emit('DECLARE',{name,kind:'let'},n);
      expr(n.argument);emit('CONST',{value:['symbol','well-known:iterator']},n);emit('GET_METHOD',null,n);emit('CALL',0,n);
      emit('REQUIRE_OBJECT',null,n);emit('INIT',iterator,n);
      emit('GET',iterator,n);emit('CONST',{value:['str','next']},n);emit('GET_METHOD',null,n);emit('INIT',next,n);
      emit('CONST',{value:['str','next']},n);emit('INIT',kind,n);
      for(const name of [sent,step]){emit('CONST',{value:['undefined']},n);emit('INIT',name,n);}
      const top=instructions.length;
      emit('GET',kind,n);emit('CONST',{value:['str','next']},n);emit('BINARY','===',n);
      const abrupt=emit('JUMP_IF_FALSE',null,n);
      emit('GET',next,n);emit('GET',sent,n);emit('CALL',1,n);emit('REQUIRE_OBJECT',null,n);emit('SET',step,n);emit('POP',null,n);
      const nextResult=emit('JUMP',null,n);
      instructions[abrupt].arg=instructions.length;
      emit('GET',iterator,n);emit('GET',kind,n);emit('GET_METHOD',null,n);
      const provided=emit('LOGICAL_JUMP',{operator:'??',to:null},n);emit('POP',null,n);
      emit('GET',kind,n);emit('CONST',{value:['str','return']},n);emit('BINARY','===',n);
      const missingThrow=emit('JUMP_IF_FALSE',null,n);
      emit('GET',sent,n);emit('RETURN',null,n);
      instructions[missingThrow].arg=instructions.length;
      // A missing throw method closes with a normal completion. A cleanup
      // failure wins; otherwise the missing-throw TypeError is raised.
      emit('GET',iterator,n);emit('CONST',{value:['str','return']},n);emit('GET_METHOD',null,n);
      const close=emit('LOGICAL_JUMP',{operator:'??',to:null},n);emit('POP',null,n);
      const noClose=emit('JUMP',null,n);instructions[close].arg.to=instructions.length;
      emit('CALL',0,n);emit('REQUIRE_OBJECT',null,n);emit('POP',null,n);
      instructions[noClose].arg=instructions.length;emit('ITERATOR_THROW_MISSING',null,n);
      instructions[provided].arg.to=instructions.length;
      emit('GET',sent,n);emit('CALL',1,n);emit('REQUIRE_OBJECT',null,n);emit('SET',step,n);emit('POP',null,n);
      instructions[nextResult].arg=instructions.length;
      emit('GET',step,n);emit('CONST',{value:['str','done']},n);emit('GET_PROP',null,n);
      const yielded=emit('JUMP_IF_FALSE',null,n);
      emit('GET',step,n);emit('CONST',{value:['str','value']},n);emit('GET_PROP',null,n);
      emit('GET',kind,n);emit('CONST',{value:['str','return']},n);emit('BINARY','===',n);
      const normal=emit('JUMP_IF_FALSE',null,n);emit('RETURN',null,n);
      instructions[normal].arg=instructions.length;emit('LEAVE_SCOPE',null,n);
      const end=emit('JUMP',null,n);
      instructions[yielded].arg=instructions.length;
      emit('GET',step,n);emit('DELEGATE_YIELD',null,n);
      emit('DELEGATE_RESUME_KIND',null,n);emit('SET',kind,n);emit('POP',null,n);
      emit('DELEGATE_RESUME_VALUE',null,n);emit('SET',sent,n);emit('POP',null,n);
      emit('JUMP',top,n);instructions[end].arg=instructions.length;
    }
    function emitClass(n,inferredName){
      const salt=++forOfIndex,klass='[[class '+salt+']]',proto='[[class prototype '+salt+']]',heritage='[[class heritage '+salt+']]',className='[[class name '+salt+']]';
      emit('ENTER_SCOPE',null,n);
      emit('DECLARE',{name:className,kind:'const'},n);
      if(!n.name&&inferredName?.stack)emit('DUP',null,n);else emit('CONST',{value:['str',n.name??(typeof inferredName==='string'?inferredName:'')]},n);
      emit('INIT',className,n);
      if(n.name)emit('DECLARE',{name:n.name,kind:'const'},n);
      emit('DECLARE',{name:klass,kind:'const'},n);emit('DECLARE',{name:proto,kind:'const'},n);
      if(n.superClass){emit('DECLARE',{name:heritage,kind:'const'},n);expr(n.superClass);emit('INIT',heritage,n);}
      const explicit=n.elements.find(element=>element.kind==='constructor');
      const ctor=explicit?.value??{...n,type:'FunctionExpr',params:[],defaults:[],parameterSites:[],parameterPatterns:[],restIndex:-1,async:false,arrow:false,
        body:{...n,type:'Block',body:n.superClass?[{...n,type:'DefaultSuper'}]:[]}};
      expr({...ctor,strict:true,classConstructor:true});emit('INIT',klass,n);emit('GET',klass,n);
      if(n.superClass)emit('GET',heritage,n);
      emit('GET',className,n);
      emit('CLASS_CREATE',{named:true,derived:!!n.superClass,privateNames:n.elements.filter(e=>e.privateName).map(e=>e.privateName)},n);emit('POP',null,n);
      emit('GET',klass,n);emit('CONST',{value:['str','prototype']},n);emit('GET_PROP',null,n);emit('INIT',proto,n);
      const instanceMethods=[],staticMethods=[],instanceFields=[],staticFields=[];
      for(const element of n.elements){
        if(element.kind==='constructor')continue;
        if(element.kind==='block'){staticFields.push({...element,type:'Block',body:element.body});continue;}
        let key=null;
        if(!element.privateName){
          const name='[[class key '+(++forOfIndex)+']]';emit('DECLARE',{name,kind:'const'},element);
          if(element.computedKey)expr(element.computedKey);else emit('CONST',{value:['str',element.key]},element);
          emit('PROPERTY_KEY',null,element);
          emit('INIT',name,element);key={...element,type:'Identifier',name};
        }
        if(element.kind==='field'){
          (element.static?staticFields:instanceFields).push({...element,type:'ClassField',key,value:element.value});continue;
        }
        if(element.privateName){
          const name='[[private method '+(++forOfIndex)+']]';emit('DECLARE',{name,kind:'const'},element);
          expr(element.value);emit('SET_HOME_OBJECT',{name:element.static?klass:proto,methodName:{privateName:'#'+element.privateName}},element);emit('INIT',name,element);
          (element.static?staticMethods:instanceMethods).push({...element,type:'ClassField',privateKind:'method',value:{...element,type:'Identifier',name}});
        }else{
          emit('GET',element.static?klass:proto,element);expr(key);expr(element.value);
          emit('SET_HOME_OBJECT',{name:element.static?klass:proto,methodName:{binding:key.name,prefix:['get','set'].includes(element.kind)?element.kind:null}},element);
          emit('DEFINE_LITERAL_PROP',{kind:element.kind==='method'?'init':element.kind,enumerable:false},element);emit('POP',null,element);
        }
      }
      for(const [isStatic,body] of [[false,[...instanceMethods,...instanceFields]],[true,[...staticMethods,...staticFields]]]){
        if(!body.length)continue;
        const codeId=bodyProgram(body,[],false,[],-1,true);
        emit('GET',klass,n);emit('MAKE_FUNCTION',{codeId,arrow:false,async:false,nonConstructible:true},n);
        emit('SET_HOME_OBJECT',{name:isStatic?klass:proto},n);
        emit('CLASS_INITIALIZER',{static:isStatic},n);emit('POP',null,n);
      }
      emit('GET',klass,n);emit('CLASS_FINISH',{name:n.name},n);emit('LEAVE_SCOPE',null,n);
    }
    function iteratorClose(iterator,node,{awaitResult=false,method=null}={}){
      const performClose=()=>{
        if(method)emit('GET',method,node);
        else {emit('GET',iterator,node);emit('CONST',{value:['str','return']},node);emit('GET_METHOD',null,node);}
        const present=emit('LOGICAL_JUMP',{operator:'??',to:null},node);
        emit('POP',null,node);const absent=emit('JUMP',null,node);
        instructions[present].arg.to=instructions.length;
        emit('CALL',0,node);if(awaitResult)emit('AWAIT',null,node);
        emit('REQUIRE_OBJECT',null,node);emit('POP',null,node);
        instructions[absent].arg=instructions.length;
      };
      emit('PENDING_THROW',null,node);const normal=emit('JUMP_IF_FALSE',null,node);
      // The incoming throw survives a return getter/call failure. A normal
      // completion, including early binding completion, is replaced by it.
      const suppress=emit('TRY_ENTER',null,node);performClose();emit('TRY_NORMAL',null,node);
      const catchPc=instructions.length;emit('BIND_CATCH',null,node);emit('TRY_NORMAL',null,node);
      instructions[suppress].arg={catchPc,finallyPc:null,afterPc:instructions.length};
      const closed=emit('JUMP',null,node);
      instructions[normal].arg=instructions.length;performClose();
      instructions[closed].arg=instructions.length;
    }
    function emitPattern(n,result=false){
          // Every nested initializer/get/default remains an owned bytecode
          // effect. Hidden generated names are inaccessible to guest syntax.
          // The temporary scope is distinct from the lexical declarations.
          emit('ENTER_SCOPE',null,n);
          const temporary=node=>{
            const name='[[pattern '+(++forOfIndex)+']]';
            emit('DECLARE',{name,kind:'let'},node);
            return name;
          };
          const preparedTargets=new Map();
          function prepareTarget(pattern){
            while(pattern.type==='PatternDefault')pattern=pattern.target;
            if(pattern.type!=='PatternMember')return;
            const object=temporary(pattern),key=temporary(pattern);
            expr(pattern.target.object);emit('INIT',object,pattern);
            expr(pattern.target.property);emit('INIT',key,pattern);
            // Destructuring evaluates the assignment reference before the
            // iterator is advanced; PutValue itself still follows the value.
            preparedTargets.set(pattern,{object,key});
          }
          function bindPattern(pattern,variable){
            if(pattern.type==='PatternName'){
              emit('GET',variable,pattern);
              emit(['var','assignment'].includes(n.kind)?'SET':'INIT',pattern.name,pattern);
              if(['var','assignment'].includes(n.kind))emit('POP',null,pattern);
              return;
            }
            if(pattern.type==='PatternSkip')return;
            if(pattern.type==='PatternMember'){
              const prepared=preparedTargets.get(pattern);
              if(prepared){emit('GET',prepared.object,pattern);emit('GET',prepared.key,pattern);}
              else{expr(pattern.target.object);expr(pattern.target.property);}
              emit('GET',variable,pattern);
              emit('PUT_PROP',null,pattern);emit('POP',null,pattern);return;
            }
            if(pattern.type==='PatternDefault'){
              emit('GET',variable,pattern);
              emit('CONST',{value:['undefined']},pattern);
              emit('BINARY','===',pattern);
              const skip=emit('JUMP_IF_FALSE',null,pattern);
              expr(pattern.fallback,pattern.target.type==='PatternName'?pattern.target.name:null);
              emit('SET',variable,pattern);
              emit('POP',null,pattern);
              instructions[skip].arg=instructions.length;
              bindPattern(pattern.target,variable);
              return;
            }
            if(pattern.type==='PatternArray'){
              emit('GET',variable,pattern);emit('ITERATOR_ARRAY_GUARD',null,pattern);
              const general=emit('JUMP_IF_FALSE',null,pattern);
              function elements(fast){
                const done=temporary(pattern),index=fast?temporary(pattern):null,
                  iterator=fast?null:temporary(pattern),next=fast?null:temporary(pattern),
                  step=fast?null:temporary(pattern),close=fast?null:temporary(pattern);
                emit('CONST',{value:['bool',false]},pattern);emit('INIT',done,pattern);
                if(fast){emit('CONST',{value:['num',0]},pattern);emit('INIT',index,pattern);}
                else{
                  emit('GET',variable,pattern);emit('CONST',{value:['symbol','well-known:iterator']},pattern);
                  emit('GET_METHOD',null,pattern);emit('CALL',0,pattern);emit('REQUIRE_OBJECT',null,pattern);emit('INIT',iterator,pattern);
                  emit('GET',iterator,pattern);emit('CONST',{value:['str','next']},pattern);emit('GET_METHOD',null,pattern);emit('INIT',next,pattern);
                  emit('CONST',{value:['undefined']},pattern);emit('INIT',step,pattern);
                  emit('CONST',{value:['bool',true]},pattern);emit('INIT',close,pattern);
                }
                const handler=fast?null:emit('TRY_ENTER',null,pattern);
                const advance=(child,skip=false)=>{
                  emit('GET',done,pattern);const active=emit('JUMP_IF_FALSE',null,pattern),alreadyDone=emit('JUMP',null,pattern);
                  instructions[active].arg=instructions.length;
                  if(fast){
                    emit('GET',variable,pattern);emit('CONST',{value:['str','length']},pattern);emit('GET_PROP',null,pattern);
                    emit('GET',index,pattern);emit('BINARY','>',pattern);const exhausted=emit('JUMP_IF_FALSE',null,pattern);
                    if(!skip){emit('GET',variable,pattern);emit('GET',index,pattern);emit('GET_PROP',null,pattern);emit('SET',child,pattern);emit('POP',null,pattern);}
                    emit('UPDATE_BINDING',{name:index,operator:'++',prefix:true},pattern);emit('POP',null,pattern);
                    const advanced=emit('JUMP',null,pattern);instructions[exhausted].arg=instructions.length;
                    emit('CONST',{value:['bool',true]},pattern);emit('SET',done,pattern);emit('POP',null,pattern);
                    instructions[advanced].arg=instructions.length;
                  }else{
                    // A next/done/value failure completes the iterator record
                    // without IteratorClose; a later binding failure closes.
                    emit('CONST',{value:['bool',false]},pattern);emit('SET',close,pattern);emit('POP',null,pattern);
                    emit('GET',next,pattern);emit('CALL',0,pattern);emit('REQUIRE_OBJECT',null,pattern);emit('SET',step,pattern);emit('POP',null,pattern);
                    emit('GET',step,pattern);emit('CONST',{value:['str','done']},pattern);emit('GET_PROP',null,pattern);
                    const available=emit('JUMP_IF_FALSE',null,pattern);
                    emit('CONST',{value:['bool',true]},pattern);emit('SET',done,pattern);emit('POP',null,pattern);
                    const exhausted=emit('JUMP',null,pattern);instructions[available].arg=instructions.length;
                    if(!skip){emit('GET',step,pattern);emit('CONST',{value:['str','value']},pattern);emit('GET_PROP',null,pattern);emit('SET',child,pattern);emit('POP',null,pattern);}
                    emit('CONST',{value:['bool',true]},pattern);emit('SET',close,pattern);emit('POP',null,pattern);
                    instructions[exhausted].arg=instructions.length;
                  }
                  instructions[alreadyDone].arg=instructions.length;
                };
                for(const entry of pattern.elements){
                  const child=temporary(entry);prepareTarget(entry.target);
                  if(entry.rest){
                    emit('NEW_ARRAY',null,entry);emit('INIT',child,entry);
                    const value=temporary(entry);emit('CONST',{value:['undefined']},entry);emit('INIT',value,entry);
                    const top=instructions.length;advance(value);
                    emit('GET',done,pattern);const available=emit('JUMP_IF_FALSE',null,pattern),end=emit('JUMP',null,pattern);
                    instructions[available].arg=instructions.length;
                    emit('GET',child,entry);emit('GET',value,entry);emit('APPEND_ARRAY',{spread:false},entry);emit('POP',null,entry);
                    emit('JUMP',top,entry);instructions[end].arg=instructions.length;bindPattern(entry.target,child);
                  }else{
                    emit('CONST',{value:['undefined']},entry);emit('INIT',child,entry);
                    advance(child,entry.target.type==='PatternSkip');bindPattern(entry.target,child);
                  }
                }
                if(!fast){
                  emit('TRY_NORMAL',null,pattern);const finallyPc=instructions.length;
                  emit('GET',close,pattern);const skipClose=emit('JUMP_IF_FALSE',null,pattern);
                  iteratorClose(iterator,pattern);instructions[skipClose].arg=instructions.length;emit('END_FINALLY',null,pattern);
                  instructions[handler].arg={catchPc:null,finallyPc,afterPc:instructions.length};
                }
              }
              elements(true);const end=emit('JUMP',null,pattern);instructions[general].arg=instructions.length;
              elements(false);instructions[end].arg=instructions.length;
              return;
            }
            if(pattern.type==='PatternObject'){
              emit('GET',variable,pattern);emit('REQUIRE_COERCIBLE',null,pattern);emit('POP',null,pattern);
              const excluded=[];
              for(const entry of pattern.entries){
                const child=temporary(entry);
                if(entry.rest){
                  emit('NEW_OBJECT',null,entry);emit('INIT',child,entry);
                  copyOwn(child,variable,excluded,entry,{required:true});
                }else{
                  const key=temporary(entry);excluded.push(key);
                  emit('GET',variable,entry);
                  if(entry.computedKey){expr(entry.computedKey);emit('PROPERTY_KEY',null,entry.computedKey);}
                  else emit('CONST',{value:['str',entry.key]},entry);
                  emit('DUP',null,entry);emit('INIT',key,entry);
                  emit('GET_PROP',null,entry);emit('INIT',child,entry);
                }
                bindPattern(entry.target,child);
              }
              return;
            }
            throw new SyntaxError('Unsupported pattern shape: '+pattern.type);
          }
          const root=temporary(n);
          expr(n.init);emit('INIT',root,n);
          bindPattern(n.pattern,root);
          if(result)emit('GET',root,n);
          emit('LEAVE_SCOPE',null,n);
    }
    function stmt(n){
      switch(n.type){
        case 'AsyncFromSyncMethod':{
          // This internal async function is compiled from the original loop,
          // never parsed from new host text. Its retained frame represents the
          // AsyncFromSyncIteratorContinuation Promise reaction and gives the
          // outer await its separate job, including synchronous failures.
          const result='[[async-from-sync result]]',done='[[async-from-sync done]]',
            value='[[async-from-sync value]]';
          for(const name of [result,done,value])emit('DECLARE',{name,kind:'let'},n);
          const returnResult=(empty=false)=>{
            emit('NEW_OBJECT',null,n);
            for(const [key,name]of [['value',value],['done',done]]){
              emit('DUP',null,n);emit('CONST',{value:['str',key]},n);
              if(empty)emit('CONST',{value:key==='value'?['undefined']:['bool',true]},n);
              else emit('GET',name,n);
              emit('DEFINE_LITERAL_PROP',{kind:'init'},n);emit('POP',null,n);
            }
            emit('RETURN',null,n);
          };
          if(n.method==='return'){
            emit('GET',n.iterator,n);emit('CONST',{value:['str','return']},n);emit('GET_METHOD',null,n);
            const present=emit('LOGICAL_JUMP',{operator:'??',to:null},n);
            emit('POP',null,n);returnResult(true);
            instructions[present].arg.to=instructions.length;
          }else emit('GET',n.next,n);
          emit('CALL',0,n);emit('REQUIRE_OBJECT',null,n);emit('INIT',result,n);
          emit('GET',result,n);emit('CONST',{value:['str','done']},n);emit('GET_PROP',null,n);
          emit('UNARY','!',n);emit('UNARY','!',n);emit('INIT',done,n);
          // A sync result's value is read and awaited even when done is true.
          emit('GET',result,n);emit('CONST',{value:['str','value']},n);emit('GET_PROP',null,n);emit('INIT',value,n);
          const handler=n.method==='next'?emit('TRY_ENTER',null,n):null;
          emit('GET',value,n);emit('AWAIT',null,n);emit('SET',value,n);emit('POP',null,n);
          if(handler!==null){
            emit('TRY_NORMAL',null,n);const finallyPc=instructions.length;
            emit('PENDING_THROW',null,n);const normal=emit('JUMP_IF_FALSE',null,n);
            emit('GET',done,n);emit('UNARY','!',n);const complete=emit('JUMP_IF_FALSE',null,n);
            // Current AsyncFromSyncIterator next closes on a rejected value.
            // The original rejection outranks a throwing return getter/call.
            iteratorClose(n.iterator,n);
            instructions[normal].arg=instructions[complete].arg=instructions.length;
            emit('END_FINALLY',null,n);
            instructions[handler].arg={catchPc:null,finallyPc,afterPc:instructions.length};
          }
          returnResult();break;
        }
        case 'Variable':{
          if(n.kind==='var'){
            if(n.init){expr(n.init,n.id);emit('SET',n.id,n);emit('POP',null,n);}
          }else{
            if(n.init)expr(n.init,n.id);else emit('CONST',{value:['undefined']},n);
            emit('INIT',n.id,n);
          }
          break;
        }
        case 'ClassBinding':expr(n.value);emit('INIT',n.id,n);break;
        case 'DefaultSuper':emit('SUPER_FORWARD_CALL',null,n);emit('SUPER_BIND',null,n);emit('POP',null,n);break;
        case 'ClassField':
          emit('THIS',null,n);
          if(!n.privateName)expr(n.key);
          expr(n.value,n.privateName?'#'+n.privateName:{stack:true});
          if(n.privateName)emit('PRIVATE_DEFINE',{name:n.privateName,kind:n.privateKind??'field'},n);
          else emit('DEFINE_LITERAL_PROP',{kind:'init',enumerable:true},n);
          emit('POP',null,n);break;
        case 'VariableGroup':for(const declaration of n.declarations)stmt(declaration);break;
        case 'PatternBinding':emitPattern(n);break;
        case 'Expression':expr(n.expr);emit('POP',null,n);break;
        case 'Return':if(n.argument)expr(n.argument);else emit('CONST',{value:['undefined']},n);emit('RETURN',null,n);break;
        case 'Throw':expr(n.argument);emit('THROW',null,n);break;
        case 'Block':statements(n.body,true);break;
        case 'Label':{
          const labels=[...(n.labels??[]),n.label];
          if(['For','ForIn','ForOf','While','DoWhile','Switch','Label'].includes(n.body.type)){
            stmt({...n.body,labels});break;
          }
          const entry=emit('LOOP_ENTER',null,n);
          loopDepth++;stmt(n.body);loopDepth--;
          const end=instructions.length;emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:null,labels};
          break;
        }
        case 'Switch':{
          // Evaluate the discriminant outside the CaseBlock lexical scope.
          // All cases share one scope; tests stop at the first match while
          // bodies then fall through without evaluating later case tests.
          expr(n.discriminant);emit('ENTER_SCOPE',null,n);
          const saved='[[switch '+(++forOfIndex)+']]';
          emit('DECLARE',{name:saved,kind:'const'},n);emit('INIT',saved,n);
          predeclare(n.cases.flatMap(c=>c.body));
          const entry=emit('LOOP_ENTER',null,n),jumps=new Map();
          for(const c of n.cases){
            if(!c.test)continue;
            emit('GET',saved,n);expr(c.test);emit('BINARY','===',n);
            const skip=emit('JUMP_IF_FALSE',null,n);
            jumps.set(c,emit('JUMP',null,n));
            instructions[skip].arg=instructions.length;
          }
          const noMatch=emit('JUMP',null,n);
          loopDepth++;
          for(const c of n.cases){
            if(c.test)instructions[jumps.get(c)].arg=instructions.length;
            else instructions[noMatch].arg=instructions.length;
            for(const node of c.body)if(node.type!=='Function')stmt(node);
          }
          loopDepth--;
          const end=instructions.length;emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:null,labels:n.labels??[]};
          if(instructions[noMatch].arg===null)instructions[noMatch].arg=end;
          emit('LEAVE_SCOPE',null,n);
          break;
        }
        case 'If':{expr(n.test);const no=emit('JUMP_IF_FALSE',null,n.test);stmt(n.consequent);if(n.alternate){const end=emit('JUMP',null,n);instructions[no].arg=instructions.length;stmt(n.alternate);instructions[end].arg=instructions.length;}else instructions[no].arg=instructions.length;break;}
        case 'While':{
          const entry=emit('LOOP_ENTER',null,n),top=instructions.length;
          expr(n.test);const no=emit('JUMP_IF_FALSE',null,n.test);
          loopDepth++;stmt(n.body);loopDepth--;
          emit('JUMP',top,n);
          const end=instructions.length;emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:top,labels:n.labels??[]};
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
          instructions[entry].arg={breakPc:end,continuePc:testPc,labels:n.labels??[]};
          instructions[no].arg=end;
          break;
        }
        case 'ForIn':{
          const salt=++forOfIndex,enumerator='[[for-in cursor '+salt+']]',step='[[for-in step '+salt+']]',
            item=n.bindings?'[[for-in item '+salt+']]':n.id;
          emit('ENTER_SCOPE',null,n);
          for(const name of [enumerator,step])emit('DECLARE',{name,kind:'let'},n);
          if(n.kind!=='var')for(const name of n.bindings?n.bindings.map(b=>b.name):[n.id])emit('DECLARE',{name,kind:n.kind},n);
          expr(n.iterable);emit('FOR_IN_CREATE',null,n);emit('INIT',enumerator,n);
          emit('CONST',{value:['undefined']},n);emit('INIT',step,n);
          const entry=emit('LOOP_ENTER',null,n),top=instructions.length;
          emit('GET',enumerator,n);emit('FOR_IN_NEXT',null,n);emit('SET',step,n);emit('POP',null,n);
          emit('GET',step,n);emit('CONST',{value:['str','done']},n);emit('GET_PROP',null,n);
          const body=emit('JUMP_IF_FALSE',null,n),done=emit('JUMP',null,n);
          instructions[body].arg=instructions.length;
          emit('ENTER_SCOPE',null,n);
          if(n.bindings)emit('DECLARE',{name:item,kind:'const'},n);
          if(n.kind!=='var')for(const name of n.bindings?n.bindings.map(b=>b.name):[n.id])emit('DECLARE',{name,kind:n.kind},n);
          emit('GET',step,n);emit('CONST',{value:['str','value']},n);emit('GET_PROP',null,n);
          emit(n.kind==='var'&&!n.bindings?'SET':'INIT',item,n);if(n.kind==='var'&&!n.bindings)emit('POP',null,n);
          if(n.pattern)emitPattern({...n,type:'PatternBinding',init:{...n,type:'Identifier',name:item}});
          loopDepth++;stmt(n.body);loopDepth--;emit('LEAVE_SCOPE',null,n);emit('JUMP',top,n);
          const end=instructions.length;emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:top,labels:n.labels??[]};instructions[done].arg=end;
          emit('LEAVE_SCOPE',null,n);break;
        }
        case 'ForOf':{
          const salt=++forOfIndex,iterable='[[for-of iterable '+salt+']]';
          const item=n.bindings?'[[for-of item '+salt+']]':n.id;
          const index='[[for-of index '+salt+']]';
          emit('ENTER_SCOPE',null,n);
          emit('DECLARE',{name:iterable,kind:'const'},n);
          // The lexical loop header shadows its own iterable expression.
          if(n.kind!=='var')for(const name of n.bindings?n.bindings.map(b=>b.name):[n.id])
            emit('DECLARE',{name,kind:n.kind},n);
          expr(n.iterable);emit('INIT',iterable,n);
          const bind=load=>{
            emit('ENTER_SCOPE',null,n);
            if(n.bindings)emit('DECLARE',{name:item,kind:'const'},n);
            if(n.kind!=='var')for(const name of n.bindings?n.bindings.map(b=>b.name):[n.id])
              emit('DECLARE',{name,kind:n.kind},n);
            load();emit(n.kind==='var'&&!n.bindings?'SET':'INIT',item,n);
            if(n.kind==='var'&&!n.bindings)emit('POP',null,n);
            if(n.pattern)emitPattern({...n,type:'PatternBinding',init:{...n,type:'Identifier',name:item}});
            loopDepth++;stmt(n.body);loopDepth--;
            emit('LEAVE_SCOPE',null,n);
          };
          if(n.await){
            const iterator='[[async iterator '+salt+']]',next='[[async iterator next '+salt+']]',
              step='[[async iterator step '+salt+']]',close='[[async iterator close '+salt+']]',
              syncNext='[[sync iterator next '+salt+']]',syncReturn='[[sync iterator return '+salt+']]',
              sync='[[async iterator sync '+salt+']]';
            for(const name of [iterator,next,step,close,syncNext,syncReturn,sync])emit('DECLARE',{name,kind:'let'},n);
            emit('GET',iterable,n);emit('CONST',{value:['symbol','well-known:asyncIterator']},n);emit('GET_METHOD',null,n);
            const asynchronous=emit('LOGICAL_JUMP',{operator:'??',to:null},n);
            emit('POP',null,n);
            emit('GET',iterable,n);emit('CONST',{value:['symbol','well-known:iterator']},n);emit('GET_METHOD',null,n);
            emit('CALL',0,n);emit('REQUIRE_OBJECT',null,n);emit('INIT',iterator,n);
            emit('GET',iterator,n);emit('CONST',{value:['str','next']},n);emit('GET_METHOD',null,n);emit('INIT',syncNext,n);
            for(const method of ['next','return']){
              const codeId=bodyProgram([{type:'AsyncFromSyncMethod',start:n.start,end:n.end,method,iterator,next:syncNext}],[],true,[],-1,true);
              emit('MAKE_FUNCTION',{codeId,arrow:false,async:true,nonConstructible:true},n);
              emit('INIT',method==='next'?next:syncReturn,n);
            }
            emit('CONST',{value:['bool',true]},n);emit('INIT',sync,n);
            const acquired=emit('JUMP',null,n);
            instructions[asynchronous].arg.to=instructions.length;
            emit('CALL',0,n);emit('REQUIRE_OBJECT',null,n);emit('INIT',iterator,n);
            emit('GET',iterator,n);emit('CONST',{value:['str','next']},n);emit('GET_METHOD',null,n);emit('INIT',next,n);
            emit('CONST',{value:['bool',false]},n);emit('INIT',sync,n);
            instructions[acquired].arg=instructions.length;
            emit('CONST',{value:['undefined']},n);emit('INIT',step,n);
            emit('CONST',{value:['bool',false]},n);emit('INIT',close,n);
            const handler=emit('TRY_ENTER',null,n),loop=emit('LOOP_ENTER',null,n),begin=instructions.length;
            emit('CONST',{value:['bool',false]},n);emit('SET',close,n);emit('POP',null,n);
            emit('GET',next,n);emit('CALL',0,n);emit('AWAIT',null,n);emit('REQUIRE_OBJECT',null,n);
            emit('SET',step,n);emit('POP',null,n);
            emit('GET',step,n);emit('CONST',{value:['str','done']},n);emit('GET_PROP',null,n);
            const body=emit('JUMP_IF_FALSE',null,n),finish=emit('JUMP',null,n);
            instructions[body].arg=instructions.length;
            bind(()=>{
              emit('GET',step,n);emit('CONST',{value:['str','value']},n);emit('GET_PROP',null,n);
              emit('CONST',{value:['bool',true]},n);emit('SET',close,n);emit('POP',null,n);
            });
            emit('JUMP',begin,n);
            const exit=instructions.length;emit('LOOP_EXIT',null,n);emit('TRY_NORMAL',null,n);
            instructions[loop].arg={breakPc:exit,continuePc:begin,labels:n.labels??[]};instructions[finish].arg=exit;
            const finallyPc=instructions.length;
            emit('GET',close,n);const skipClose=emit('JUMP_IF_FALSE',null,n);
            emit('GET',sync,n);const asyncClose=emit('JUMP_IF_FALSE',null,n);
            iteratorClose(iterator,n,{awaitResult:true,method:syncReturn});
            const closed=emit('JUMP',null,n);instructions[asyncClose].arg=instructions.length;
            iteratorClose(iterator,n,{awaitResult:true});
            instructions[skipClose].arg=instructions[closed].arg=instructions.length;
            emit('END_FINALLY',null,n);instructions[handler].arg={catchPc:null,finallyPc,afterPc:instructions.length};
            emit('LEAVE_SCOPE',null,n);break;
          }
          // Preserve the existing detailed array path only when the standard
          // iterator is actually selected. Custom/inherited hooks take the
          // owned protocol path below, with a cached next method and cleanup.
          emit('GET',iterable,n);emit('ITERATOR_ARRAY_GUARD',null,n);
          const general=emit('JUMP_IF_FALSE',null,n);
          emit('DECLARE',{name:index,kind:'let'},n);
          emit('CONST',{value:['num',0]},n);emit('INIT',index,n);
          const entry=emit('LOOP_ENTER',null,n),top=instructions.length;
          emit('GET',iterable,n);emit('CONST',{value:['str','length']},n);emit('GET_PROP',null,n);
          emit('GET',index,n);emit('BINARY','>',n);
          const no=emit('JUMP_IF_FALSE',null,n);
          bind(()=>{emit('GET',iterable,n);emit('GET',index,n);emit('GET_PROP',null,n);});
          const updatePc=instructions.length;
          emit('UPDATE_BINDING',{name:index,operator:'++',prefix:true},n);emit('POP',null,n);
          emit('JUMP',top,n);
          const end=instructions.length;emit('LOOP_EXIT',null,n);
          instructions[entry].arg={breakPc:end,continuePc:updatePc,labels:n.labels??[]};
          instructions[no].arg=end;
          const fastEnd=emit('JUMP',null,n);
          instructions[general].arg=instructions.length;
          const iterator='[[iterator '+salt+']]',next='[[iterator next '+salt+']]',
            step='[[iterator step '+salt+']]',close='[[iterator close '+salt+']]';
          for(const name of [iterator,next,step,close])emit('DECLARE',{name,kind:'let'},n);
          emit('GET',iterable,n);emit('CONST',{value:['symbol','well-known:iterator']},n);
          emit('GET_METHOD',null,n);emit('CALL',0,n);emit('REQUIRE_OBJECT',null,n);emit('INIT',iterator,n);
          emit('GET',iterator,n);emit('CONST',{value:['str','next']},n);emit('GET_METHOD',null,n);emit('INIT',next,n);
          emit('CONST',{value:['undefined']},n);emit('INIT',step,n);
          emit('CONST',{value:['bool',false]},n);emit('INIT',close,n);
          const handler=emit('TRY_ENTER',null,n),loop=emit('LOOP_ENTER',null,n),begin=instructions.length;
          emit('CONST',{value:['bool',false]},n);emit('SET',close,n);emit('POP',null,n);
          emit('GET',next,n);emit('CALL',0,n);emit('REQUIRE_OBJECT',null,n);emit('SET',step,n);emit('POP',null,n);
          emit('GET',step,n);emit('CONST',{value:['str','done']},n);emit('GET_PROP',null,n);
          const body=emit('JUMP_IF_FALSE',null,n),finish=emit('JUMP',null,n);
          instructions[body].arg=instructions.length;
          // Iterator next/done/value failures do not close. Binding and body
          // abrupt completions do, after the value has been obtained.
          bind(()=>{
            emit('GET',step,n);emit('CONST',{value:['str','value']},n);emit('GET_PROP',null,n);
            emit('CONST',{value:['bool',true]},n);emit('SET',close,n);emit('POP',null,n);
          });
          emit('JUMP',begin,n);
          const exit=instructions.length;emit('LOOP_EXIT',null,n);emit('TRY_NORMAL',null,n);
          instructions[loop].arg={breakPc:exit,continuePc:begin,labels:n.labels??[]};
          instructions[finish].arg=exit;
          const finallyPc=instructions.length;
          emit('GET',close,n);const skipClose=emit('JUMP_IF_FALSE',null,n);
          iteratorClose(iterator,n);
          instructions[skipClose].arg=instructions.length;
          emit('END_FINALLY',null,n);
          instructions[handler].arg={catchPc:null,finallyPc,afterPc:instructions.length};
          instructions[fastEnd].arg=instructions.length;
          emit('LEAVE_SCOPE',null,n);break;
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
          instructions[entry].arg={breakPc:end,continuePc:updatePc,labels:n.labels??[]};
          if(no!==null)instructions[no].arg=end;
          if(lexical)emit('LEAVE_SCOPE',null,n);
          break;
        }
        case 'Break':case 'Continue':
          if(!loopDepth)throw new SyntaxError(n.type.toLowerCase()+' outside loop');
          emit('LOOP_JUMP',n.label?{kind:n.type.toLowerCase(),label:n.label}:n.type.toLowerCase(),n);break;
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
    // A parameter expression has its own environment. All parameter names
    // exist in TDZ before initialization, then initialize left to right;
    // body var/function declarations are introduced only afterwards.
    const parameterExpressions=defaults.some(Boolean)||parameterPatterns.some(Boolean);
    if(classConstructor)emit('CLASS_CONSTRUCTOR_GUARD',null,body[0]??ast);
    if(parameterExpressions){
      params.forEach((name,i)=>{
        const initializer=defaults[i];
        const parameter=parameterSites[i];
        if(!parameter)throw new TypeError('Missing source location for parameter initialization');
        // Supplied arguments initialize at their parameter, never at the first
        // body declaration. A shared body span would invent a second source
        // declaration receipt for this implicit binding operation.
        if(!initializer)emit('PARAM_INIT',name,parameter);
        else {
        const guard=emit('DEFAULT_GUARD',{name,skipPc:null},initializer);
        expr(initializer,name.startsWith('[[')?null:name);
        emit('INIT',name,initializer);
        const done=emit('JUMP',null,initializer);
        instructions[guard].arg.skipPc=instructions.length;
        emit('PARAM_INIT',name,parameter);
        instructions[done].arg=instructions.length;
        }
        const parsed=parameterPatterns[i];
        if(parsed)emitPattern({...parameter,...parsed,kind:'parameter',
          init:{...parameter,type:'Identifier',name}});
      });
      emit('ENTER_BODY_ENV',null,body[0]);
    }
    if(generator)emit('GENERATOR_START',null,ast);
    statements(body);
    emit('CONST',{value:['undefined']},ast);emit('RETURN',null,ast);
    const firstDefault=defaults.findIndex(Boolean),functionLength=Math.min(params.length,restIndex<0?Infinity:restIndex,firstDefault<0?Infinity:firstDefault);
    programs[id]={id,params,restIndex,async,generator:generator===true,strict,parameterExpressions,functionLength,
      ...(body[0]?.type==='AsyncFromSyncMethod'?{sourceRole:'async-from-sync-'+body[0].method}:{}),
      patternNames:parameterPatterns.flatMap(p=>(p?.bindings??[]).map(b=>b.name)),varNames:collectVarBindings(body),instructions};return id;
  }
  const entry=bodyProgram(ast.body);
  return {entry,programs,sites:Object.values(programs).flatMap(x=>x.instructions.map(({siteId,start,end,op})=>({siteId,start,end,op,codeId:x.id})))};
}
