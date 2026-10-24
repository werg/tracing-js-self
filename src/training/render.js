// Deterministic inspection over a complete public witness prefix.
// The renderer never looks at teacher source-execution futures or private heap.
import {decodeWitness} from './format.js';
import {SemanticController} from './controller.js';

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
  if(node.op==='literal')return show(node.value);
  if(node.op==='local')return node.name;
  if(node.op==='read')return '&'+node.object+'['+JSON.stringify(node.key)+']';
  if(node.op==='unary')return node.operator+'('+expr(node.arg)+')';
  if(node.op==='binary')return '('+expr(node.left)+' '+node.operator+' '+expr(node.right)+')';
  throw new TypeError('Unrenderable public primitive');
}
function renderOne(kind,f) {
  switch(kind){
    case 'code':return 'source '+f.entry+' ('+f.sites.length+' static semantic sites)';
    case 'input':return 'initial graph '+f.graph.objects.length+' identities; '+
      f.graph.roots.map(show).join(', ');
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
      f.arguments.map(show).join(', ')+')';
    case 'observe':return 'observe '+f.effect+' '+f.status+' '+show(f.result);
    case 'job':return 'job '+f.action+' '+f.job+' owner '+f.owner;
    case 'end':return 'end '+f.kind;
    default:throw new TypeError('Unsupported semantic renderer record '+kind);
  }
}
export function renderWitness(record) {
  const {kind,fields}=decodeWitness(record);
  return renderOne(kind,fields);
}
export function inspectWitnessPrefix(context,generated,options={}) {
  if(!Array.isArray(context)||!Array.isArray(generated))
    throw new TypeError('Semantic inspection requires explicit public context and trajectory');
  const selected=new SemanticController(context,options);
  const rendered=context.map(renderWitness);
  for(const record of generated){
    // No future record is inspected before the current step commits.
    selected.commit(record);
    rendered.push(renderWitness(record));
  }
  return {rendered,completion:selected.completion,
    firstWitnessViolation:selected.firstWitnessViolation,
    observableGraph:selected.completion?selected.observedGraph():null};
}
