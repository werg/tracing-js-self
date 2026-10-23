// Observe trusted real-world JS/TS using an explicitly native V8 execution path.
// NOT an owned interpreter trace, deterministic replay, or admitted training data.
// Node vm is not a security sandbox for hostile inputs.
import vm from 'node:vm';
import {types} from 'node:util';
import ts from 'typescript';

const primitive=x=>{
  if(x===undefined)return ['undefined'];
  if(x===null)return ['null'];
  if(typeof x==='boolean')return ['bool',x];
  if(typeof x==='string')return ['str',x];
  if(typeof x==='bigint')return ['bigint',String(x)];
  if(typeof x==='number')return ['num',Object.is(x,-0)?'-0':
    Number.isNaN(x)?'NaN':x===Infinity?'+Infinity':x===-Infinity?'-Infinity':x];
  if(typeof x==='symbol')return ['symbol',String(x.description??'')];
  return null;
};
const reference=x=>x!==null&&(typeof x==='object'||typeof x==='function');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const keyName=k=>typeof k==='symbol'?'@@'+String(k.description??''):String(k);

function portableArguments(args){
  const ids=new WeakMap(),objects=[];
  function encode(v){
    const scalar=primitive(v);if(scalar)return scalar;
    if(!reference(v)||typeof v==='function'||types.isProxy(v))
      throw new TypeError('Only portable data arguments can cross the V8 realm; use setupSource for exotic fixtures');
    if(ids.has(v))return ['ref',ids.get(v)];
    if(objects.length>=256)throw new RangeError('Input graph too large');
    const isArray=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if(!(proto===null||proto===(isArray?Array.prototype:Object.prototype)))
      throw new TypeError('Construct custom prototypes inside setupSource');
    const id='i'+objects.length;ids.set(v,id);
    const row={id,array:isArray,nullPrototype:proto===null,properties:[]};
    objects.push(row);
    for(const key of Reflect.ownKeys(v)){
      if(typeof key!=='string'||key==='__proto__')
        throw new TypeError('Non-data input key');
      const d=Object.getOwnPropertyDescriptor(v,key);
      if(!d||!Object.hasOwn(d,'value'))
        throw new TypeError('Construct accessors inside setupSource');
      row.properties.push([key,encode(d.value)]);
      if(row.properties.length>4096)throw new RangeError('Too many input properties');
    }
    return ['ref',id];
  }
  return {roots:args.map(encode),objects};
}
function hydrate(g){
  const objects=new Map();
  function value(v){
    switch(v[0]){
      case 'undefined':return undefined;
      case 'null':return null;
      case 'bool':case 'str':return v[1];
      case 'bigint':return BigInt(v[1]);
      case 'num':return v[1]==='-0'?-0:v[1]==='NaN'?NaN:
        v[1]==='+Infinity'?Infinity:v[1]==='-Infinity'?-Infinity:v[1];
      case 'ref':return objects.get(v[1]);
      default:throw new TypeError('Unsupported input scalar');
    }
  }
  for(const row of g.objects)objects.set(row.id,row.array?[]:
    row.nullPrototype?Object.create(null):{});
  for(const row of g.objects){
    const target=objects.get(row.id);
    for(const [key,tag] of row.properties)Object.defineProperty(target,key,{
      value:value(tag),writable:true,enumerable:key!=='length',configurable:key!=='length'});
  }
  return g.roots.map(value);
}
function observableGraph(roots){
  const ids=new WeakMap(),objects=[];
  function visit(v){
    const scalar=primitive(v);if(scalar)return scalar;
    if(!reference(v))return ['unknown',typeof v];
    if(ids.has(v))return ['ref',ids.get(v)];
    const id='g'+objects.length;ids.set(v,id);
    const row={id,kind:typeof v==='function'?'function':
      types.isProxy(v)?'proxy':Array.isArray(v)?'array':'object',properties:[]};
    objects.push(row);
    if(row.kind==='proxy')return ['ref',id];
    if(row.kind==='function'){row.properties.push(['name',['str',v.name]]);return ['ref',id];}
    for(const key of Reflect.ownKeys(v)){
      const d=Object.getOwnPropertyDescriptor(v,key);
      row.properties.push([keyName(key),d&&Object.hasOwn(d,'value')?
        visit(d.value):['accessor']]);
      if(row.properties.length>12000)throw new RangeError('Output object too large');
    }
    return ['ref',id];
  }
  return {roots:roots.map(visit),objects};
}
class Capture {
  constructor({maxEvents,maxNodes}){
    this.events=[];this.ids=new WeakMap();this.known=new Map();this.prior=new Map();
    this.maxEvents=maxEvents;this.maxNodes=maxNodes;this.limitations=new Set();
  }
  encode(v){
    const scalar=primitive(v);if(scalar)return scalar;
    if(!reference(v))return ['unknown',typeof v];
    if(!this.ids.has(v)){
      if(this.known.size>=this.maxNodes)throw new RangeError('Trace node budget exhausted');
      const id='o'+this.known.size;
      this.ids.set(v,id);this.known.set(id,v);
    }
    return ['ref',this.ids.get(v)];
  }
  snapshot(){
    const result=new Map();let count=0;
    for(const [id,v] of this.known){
      const props=[];
      if(typeof v==='function'){
        result.set(id,{kind:'function',props:[['name',['str',v.name]] ]});
        continue;
      }
      if(types.isProxy(v)){
        this.limitations.add('Proxy internals are opaque; source-level reads and calls remain observed');
        result.set(id,{kind:'proxy',props});continue;
      }
      let desc;
      try{desc=Object.getOwnPropertyDescriptors(v);}
      catch{this.limitations.add('Some native object properties cannot be inspected');
        result.set(id,{kind:'opaque',props});continue;}
      for(const key of Reflect.ownKeys(desc)){
        if(++count>12000)throw new RangeError('Trace property budget exhausted');
        const d=desc[key];
        props.push([keyName(key),Object.hasOwn(d,'value')?this.encode(d.value):['accessor']]);
      }
      result.set(id,{kind:Array.isArray(v)?'array':'object',props});
    }
    return result;
  }
  initialize(args){
    for(const arg of args)this.encode(arg);
    this.prior=this.snapshot();
  }
  record(kind,start,end,result,meta={}){
    if(this.events.length>=this.maxEvents)throw new RangeError('Trace event budget exhausted');
    const value=this.encode(result),next=this.snapshot();
    const effects=[],allocations=[];
    for(const [id,obj] of next){
      const prior=this.prior.get(id);
      if(!prior)allocations.push({identity:id,kind:obj.kind,properties:obj.props});
      const before=new Map(prior?.props??[]),after=new Map(obj.props);
      for(const key of new Set([...before.keys(),...after.keys()])){
        if(!equal(before.get(key),after.get(key)))effects.push({
          identity:id,key,before:before.has(key)?before.get(key):['absent'],
          after:after.has(key)?after.get(key):['absent']
        });
      }
    }
    this.prior=next;
    const event={id:'e'+(this.events.length+1),kind,site:{start,end},result:value,...meta};
    if(effects.length)event.effects=effects;
    if(allocations.length)event.allocations=allocations;
    this.events.push(event);
    return result;
  }
  hooks(){
    return Object.freeze({
      enter:(a,b,name)=>this.record('enter',a,b,undefined,{name}),
      value:(a,b,v)=>this.record('value',a,b,v),
      read:(a,b,v)=>this.record('read',a,b,v),
      write:(a,b,v)=>this.record('write',a,b,v),
      binding:(a,b,n,v)=>this.record('write',a,b,v,{binding:n}),
      call:(a,b,v)=>this.record('call',a,b,v),
      ret:(a,b,v)=>this.record('return',a,b,v),
      raise:(a,b,v)=>this.record('throw',a,b,v),
      test:(a,b,v,c)=>this.record('branch',a,b,v,{context:c,path:v?'then':'else'}),
      logical:(a,b,op,v)=>this.record('branch',a,b,v,{
        context:op,path:(op==='&&'?!v:op==='||'?!!v:v!==null&&v!==undefined)?
          'use-left':'evaluate-right'
      })
    });
  }
}
function instrument(source,filename,language){
  const sf=ts.createSourceFile(filename,source,ts.ScriptTarget.ES2022,true,
    language==='ts'?ts.ScriptKind.TS:language==='tsx'?ts.ScriptKind.TSX:ts.ScriptKind.JS);
  if(sf.parseDiagnostics.length)throw new SyntaxError(
    ts.flattenDiagnosticMessageText(sf.parseDiagnostics[0].messageText,'\n'));
  const transform=ctx=>{
    const f=ctx.factory;
    const call=(name,node,args)=>f.createCallExpression(f.createPropertyAccessExpression(
      f.createIdentifier('__trace'),name),undefined,[
      f.createNumericLiteral(node.getStart(sf)),f.createNumericLiteral(node.getEnd()),...args
    ]);
    const assign=kind=>kind>=ts.SyntaxKind.FirstAssignment&&kind<=ts.SyntaxKind.LastAssignment;
    const updating=n=>(ts.isPrefixUnaryExpression(n)||ts.isPostfixUnaryExpression(n))&&
      [ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(n.operator);
    function visit(node,parent=null){
      const v=ts.visitEachChild(node,child=>visit(child,node),ctx);
      if(ts.isArrowFunction(v)){
        const name='[callback]';
        const body=ts.isBlock(v.body)?
          f.updateBlock(v.body,[f.createExpressionStatement(call('enter',node,
            [f.createStringLiteral(name)])),...v.body.statements]):
          f.createBlock([
            f.createExpressionStatement(call('enter',node,[f.createStringLiteral(name)])),
            f.createReturnStatement(call('ret',node,[v.body]))
          ],true);
        return f.updateArrowFunction(v,v.modifiers,v.typeParameters,v.parameters,
          v.type,v.equalsGreaterThanToken,body);
      }
      if(ts.isFunctionDeclaration(v)&&v.body){
        const body=f.updateBlock(v.body,[f.createExpressionStatement(call('enter',node,
          [f.createStringLiteral(v.name?.text??'[anonymous]')])),...v.body.statements]);
        return f.updateFunctionDeclaration(v,v.modifiers,v.asteriskToken,v.name,
          v.typeParameters,v.parameters,v.type,body);
      }
      if(ts.isIfStatement(v))return f.updateIfStatement(v,call('test',node,
        [v.expression,f.createStringLiteral('if')]),v.thenStatement,v.elseStatement);
      if(ts.isWhileStatement(v))return f.updateWhileStatement(v,call('test',node,
        [v.expression,f.createStringLiteral('while')]),v.statement);
      if(ts.isDoStatement(v))return f.updateDoStatement(v,v.statement,call('test',node,
        [v.expression,f.createStringLiteral('do-while')]));
      if(ts.isForStatement(v))return f.updateForStatement(v,v.initializer,
        v.condition?call('test',node,[v.condition,f.createStringLiteral('for')]):undefined,
        v.incrementor,v.statement);
      if(ts.isReturnStatement(v))return f.updateReturnStatement(v,
        call('ret',node,[v.expression??f.createVoidZero()]));
      if(ts.isThrowStatement(v))return f.updateThrowStatement(v,
        call('raise',node,[v.expression]));
      if(ts.isVariableDeclaration(v)&&v.initializer)return f.updateVariableDeclaration(
        v,v.name,v.exclamationToken,v.type,call('binding',node,[
          f.createStringLiteral(ts.isIdentifier(node.name)?node.name.text:'[pattern]'),
          v.initializer]));
      if(ts.isBinaryExpression(v)){
        if([ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken].includes(v.operatorToken.kind)){
          const op=ts.tokenToString(v.operatorToken.kind);
          const left=call('logical',node,[f.createStringLiteral(op),v.left]);
          return call('value',node,[f.updateBinaryExpression(v,left,v.operatorToken,v.right)]);
        }
        return call(assign(v.operatorToken.kind)?'write':'value',node,[v]);
      }
      if(ts.isConditionalExpression(v))return call('value',node,[
        f.updateConditionalExpression(v,call('test',node,[
          v.condition,f.createStringLiteral('ternary')]),v.questionToken,
          v.whenTrue,v.colonToken,v.whenFalse)]);
      if(ts.isCallExpression(v)||ts.isNewExpression(v))
        return call(ts.isCallExpression(v)?'call':'value',node,[v]);
      if(ts.isPrefixUnaryExpression(v)||ts.isPostfixUnaryExpression(v))
        return call(updating(v)?'write':'value',node,[v]);
      if(ts.isTemplateExpression(v)||ts.isAwaitExpression(v))
        return call('value',node,[v]);
      if(ts.isPropertyAccessExpression(v)||ts.isElementAccessExpression(v)){
        const lhs=parent&&(ts.isBinaryExpression(parent)&&parent.left===node&&
            assign(parent.operatorToken.kind)||
          updating(parent)&&parent.operand===node||
          ts.isPrefixUnaryExpression(parent)&&parent.operator===ts.SyntaxKind.DeleteKeyword);
        const callee=parent&&((ts.isCallExpression(parent)||ts.isNewExpression(parent))&&
          parent.expression===node||ts.isTaggedTemplateExpression(parent)&&parent.tag===node);
        return lhs||callee?v:call('read',node,[v]);
      }
      return v;
    }
    return root=>visit(root);
  };
  const transformed=ts.transform(sf,[transform]);
  const printed=ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  return transpile(printed,filename);
}
function transpile(code,filename){
  const result=ts.transpileModule(code,{fileName:filename,compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
    jsx:ts.JsxEmit.React,esModuleInterop:true
  },reportDiagnostics:true});
  const errors=(result.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errors.length)throw new SyntaxError(ts.flattenDiagnosticMessageText(errors[0].messageText,'\n'));
  return result.outputText;
}
async function execute(code,{filename,entry,args,setupSource,timeoutMs,capture}){
  const events=capture?new Capture(capture):null;
  const trace=events?events.hooks():null;
  const output={};
  const sandbox={module:{exports:output},exports:output,__trace:trace};
  const ctx=vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false}});
  let inputs;
  if(setupSource){
    // Instrument guest-defined callbacks as well as the entry function.
    // Initialization itself is fixture setup, not an execution target.
    const setupCode=events?instrument(setupSource,filename+'.setup.js','js'):
      transpile(setupSource,filename+'.setup.js');
    vm.runInContext(setupCode,ctx,{filename:filename+'.setup.js',timeout:timeoutMs});
    inputs=vm.runInContext('globalThis.__testArgs',ctx,{timeout:timeoutMs});
    if(!Array.isArray(inputs))throw new TypeError('setupSource must assign globalThis.__testArgs');
  }else{
    ctx.__graph=portableArguments(args);
    inputs=vm.runInContext('('+hydrate.toString()+')(__graph)',ctx,{timeout:timeoutMs});
  }
  if(events)events.events.length=0;
  events?.initialize(inputs);
  let value=null,completion;
  try{
    new vm.Script(code,{filename}).runInContext(ctx,{timeout:timeoutMs});
    const name=JSON.stringify(entry);
    ctx.__entry=ctx.module.exports?.[entry]??vm.runInContext(
      'typeof '+entry+'==="function"?'+entry+':module.exports['+name+']',ctx,
      {timeout:timeoutMs});
    if(typeof ctx.__entry!=='function')throw new TypeError('Missing callable entry '+entry);
    ctx.__entryArgs=inputs;
    value=vm.runInContext('__entry.apply(undefined,__entryArgs)',ctx,{timeout:timeoutMs});
    if(value&&typeof value.then==='function')
      value=await Promise.race([value,new Promise((_,reject)=>setTimeout(
        ()=>reject(new RangeError('Async observation timeout')),timeoutMs))]);
    completion={kind:'return',value:primitive(value)??['ref']};
    events?.record('end',0,0,value);
  }catch(error){
    completion={kind:'throw',name:error?.name??'Error',message:String(error?.message??error)};
  }
  return {completion,graph:observableGraph([
    ...inputs,...(completion.kind==='return'?[value]:[])]),
    events:events?.events??[],limitations:[...(events?.limitations??[])],
    input:setupSource?null:portableArguments(args)};
}
/** Native V8 observation on trusted pinned code, independently checked against
 * a second uninstrumented V8 run. Not a serving-controller trajectory. */
export async function observeProgram({source,entry,args=[],language='js',
  filename=language==='ts'?'observed.ts':'observed.js',setupSource=null,
  timeoutMs=2000,maxEvents=6000,maxNodes=512}={}){
  if(typeof source!=='string'||!source.trim()||typeof entry!=='string'||
     !/^[$A-Za-z_][$\w]*$/.test(entry)||!Array.isArray(args)||
     !['js','ts','tsx'].includes(language)||!Number.isInteger(timeoutMs)||
     timeoutMs<1||timeoutMs>30000)
    throw new TypeError('Invalid trusted V8 observation request');
  const observed=await execute(instrument(source,filename,language),
    {filename,entry,args,setupSource,timeoutMs,capture:{maxEvents,maxNodes}});
  const reference=await execute(transpile(source,filename),
    {filename,entry,args,setupSource,timeoutMs,capture:null});
  const sameResult=observed.completion.kind===reference.completion.kind&&
    (observed.completion.kind==='return'||equal(observed.completion,reference.completion))&&
    equal(observed.graph,reference.graph);
  return {schema:'effective-observation/1',profile:'trusted-v8-observation',
    source:{filename,language,text:source},entry,input:observed.input,
    events:observed.events.map(row=>({...row,
      source:source.slice(row.site.start,row.site.end)})),
    completion:observed.completion,observableGraph:observed.graph,
    evidence:{independentUninstrumentedV8:sameResult,
      referenceCompletion:reference.completion},
    limitations:[...new Set([...observed.limitations,
      'Native V8 observation is not owned replay or admitted semantic-execution/2 training data',
      'Native modules and unobserved host effects require explicit provenance and boundary tracing'])]};
}
