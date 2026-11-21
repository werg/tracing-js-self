// Deterministic presentation of neutral typed records. No wire codec is loaded.
function show(tag){
  if(tag===undefined)return '?';
  if(!Array.isArray(tag))throw new TypeError('Unrenderable public scalar');
  switch(tag[0]){
    case 'undefined':return 'undefined';
    case 'null':return 'null';
    case 'str':return JSON.stringify(tag[1]);
    case 'bool':return String(tag[1]);
    case 'bigint':return tag[1]+'n';
    case 'num':return String(tag[1]);
    case 'ref':return '&'+tag[1];
    default:throw new TypeError('Unrepresentable witness value '+tag[0]);
  }
}
function expr(node){
  if(node.op==='random')return 'declared random()';
  if(node.op==='literal')return show(node.value);
  if(node.op==='local')return node.name;
  if(node.op==='read')return '&'+node.object+'['+JSON.stringify(node.key)+']';
  if(node.op==='unary')return node.operator+'('+expr(node.arg)+')';
  if(node.op==='binary')return '('+expr(node.left)+' '+node.operator+' '+expr(node.right)+')';
  throw new TypeError('Unrenderable public primitive');
}
export function renderSemanticRecord({kind,fields:f}) {
  switch(kind){
    case 'code':return 'source '+f.entry+' ('+f.sites.length+' static semantic sites)';
    case 'input':return 'initial graph '+f.graph.objects.length+' identities; '+
      f.graph.roots.map(show).join(', ');
    case 'summarize':return 'evaluate '+f.entry+'('+f.arguments.map(show).join(', ')+') => '+show(f.result)+
      (f.profile==='dense-array-sum/1'?' over '+f.iterations+' items into '+f.accumulator:'')+
      (f.decisions?' choosing '+f.decisions.map(row=>row.site.start+'..'+row.site.end+':'+row.selected).join(', '):'');
    case 'compute':return (f.bind?f.bind+' = ':'compute ')+
      expr(f.expr)+' -> '+show(f.result);
    case 'choose':return 'choose '+expr(f.expr)+' = '+show(f.decision)+' -> '+f.path;
    case 'bind':return 'bind '+f.name+' = '+show(f.value);
    case 'allocate':
      return 'allocate &'+f.name+' '+f.kind+
        (f.kind==='array'?' length '+f.length:'')+
        ' {'+f.properties.map(x=>JSON.stringify(x.key)+': '+show(x.value)).join(', ')+'}';
    case 'read':return 'read &'+f.object+'['+JSON.stringify(f.key)+'] -> '+
      (f.present?show(f.value):'absent');
    case 'write':return 'write &'+f.object+'['+JSON.stringify(f.key)+'] '+
      (f.present?'= '+show(f.value):'deleted');
    case 'call':return 'call '+f.callee+'('+f.arguments.map(show).join(', ')+') -> '+f.child;
    case 'transfer':return 'transfer '+f.kind+' '+show(f.value)+' via '+f.handler;
    case 'return':return 'return '+show(f.value);
    case 'throw':return 'throw '+show(f.value);
    case 'request':return 'request '+f.effect+' '+f.operation+'('+
      f.arguments.map(show).join(', ')+') in '+f.invocation+
      ' @'+f.site.start+':'+f.site.end+(f.promise?' -> Promise &'+f.promise:'');
    case 'observe':return 'observe '+f.effect+' '+f.status+' '+show(f.result);
    case 'job':return 'job '+f.action+' '+f.job+' owner '+f.owner;
    case 'promise':return f.action==='create'?'create owned Promise &'+f.promise:
      f.action==='react'?'when &'+f.promise+' settles, '+f.reaction+' '+
        (f.closure?'&'+f.closure:'propagation')+' as '+f.job+(f.target?' -> &'+f.target:''):
      f.action+' Promise &'+f.promise+' '+(f.target?'from &'+f.target:show(f.value));
    case 'await':return 'await Promise &'+f.promise+'; suspend '+f.invocation+
      ' as '+f.continuation+(f.returnPromise?'; call returns owned Promise &'+f.returnPromise:'');
    case 'resume':return 'resume '+f.invocation+' via '+f.continuation+' with '+f.status+' '+show(f.result);
    case 'end':return 'end '+f.kind;
    default:throw new TypeError('Unsupported semantic renderer record '+kind);
  }
}
