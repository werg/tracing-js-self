// Derived views of one checked /2 core. These strings are experimental readings,
// never an alternative executable grammar or a source/dispatch authority.
import {stableAlgorithmJSON,assertAlgorithmValue,assertAlgorithmId,isAlgorithmDataRecord} from './ir.js';
import {validateAlgorithmV8,validateTermV8} from './algorithm-v8.js';
import {OPERATION_REGISTRY} from './operations.js';
import {encodeAlgorithmValue} from './value-render.js';

export const V8_NOTATION_STYLES=Object.freeze(['canonical','formal','hybrid','prose']);
const styleCheck=style=>{if(!V8_NOTATION_STYLES.includes(style))throw new TypeError('Unknown v8 notation style');};
function printer(style){
  let binder=0;
  const val=value=>{assertAlgorithmValue(value);return encodeAlgorithmValue(value);};
  function term(node,scopes=[]){
    if(style==='canonical')return stableAlgorithmJSON(node);
    const prose=style==='prose',sub=child=>term(child,scopes);
    if(node.op==='literal')return val(node.value);
    if(node.op==='input')return prose?'input '+node.id:'$'+node.id;
    if(node.op==='ref')return prose?'value '+node.id:'%'+node.id;
    if(node.op==='bound')return scopes[node.depth][node.index];
    if(node.op==='project'||node.op==='get'){
      const object=sub(node.object),key=node.op==='project'?JSON.stringify(node.key):sub(node.key);
      return prose?'the own data field '+key+' of '+object+' (undefined if absent)':object+'['+key+']';
    }
    if(node.op==='array'){
      const items=node.items.map(sub).join(', ');
      return prose?'a fresh array containing, in order, '+(items||'no elements'):
        (style==='hybrid'?'allocate ':'')+'['+items+']';
    }
    if(node.op==='object'){
      const properties=node.properties.map(p=>JSON.stringify(p.key)+(prose?' set to ':': ')+sub(p.value)).join(', ');
      return prose?'a fresh ordinary object with '+(properties||'no fields'):
        (style==='hybrid'?'allocate ':'')+'{'+properties+'}';
    }
    if(node.op==='let'){
      const ordinal=binder++,names=node.bindings.map((_,index)=>'local'+ordinal+'_'+index),nested=[names,...scopes];
      const bindings=node.bindings.map((binding,index)=>names[index]+(prose?' is ':' = ')+term(binding,nested));
      return prose?'evaluate once, in order: '+bindings.join('; ')+'; then '+term(node.body,nested):
        '(let '+bindings.join(', ')+'; '+term(node.body,nested)+')';
    }
    if(node.op==='traverse'){
      const ordinal=binder++,fold=['fold','scan'].includes(node.mode),names=(fold?
        ['acc','item','index','items']:['item','index','items']).map(name=>name+ordinal),
        body=term(node.callback.body,[names,...scopes]),input=sub(node.input),initial=fold?sub(node.initial):null;
      const name={fold:'fold_left',scan:'scan_left',map:'map',filter:'filter',find:'find',find_index:'find_index',some:'some',every:'every'}[node.mode];
      if(!prose)return name+'('+input+(fold?', '+initial:'')+', ('+names.join(', ')+') => '+body+
        '; dense-primitive-array/1, ascending)';
      const prefix='Traverse '+input+' in ascending index order under dense-primitive-array/1, binding '+names.join(', ')+'. ';
      if(fold)return prefix+'Start with '+initial+'; replace the accumulator with '+body+' for each item; '+
        (node.mode==='fold'?'return the final accumulator (the initial value when empty).':'return a fresh array of successive accumulators (empty when input is empty).');
      if(node.mode==='map')return prefix+'Return a fresh array of '+body+' for each item.';
      if(node.mode==='filter')return prefix+'Return a fresh array of the original items for which '+body+' is truthy.';
      if(node.mode==='find')return prefix+'Stop at the first truthy '+body+' and return that original item; otherwise return undefined.';
      if(node.mode==='find_index')return prefix+'Stop at the first truthy '+body+' and return its index; otherwise return -1.';
      if(node.mode==='some')return prefix+'Stop at the first truthy '+body+' and return true; otherwise return false.';
      return prefix+'Stop at the first falsy '+body+' and return false; otherwise return true.';
    }
    if(node.op==='fold_left')return prose?'Starting at '+sub(node.initial)+', add each finite Number in '+sub(node.input)+
      ' in ascending order under dense-number-array/1':'fold_left('+sub(node.input)+', '+sub(node.initial)+', add; dense-number-array/1, ascending)';
    if(node.op==='default_undefined')return prose?'use '+sub(node.args[1])+' only if '+sub(node.args[0])+' is undefined; otherwise keep the original value':
      'default_undefined('+node.args.map(sub).join(', ')+')';
    const spec=OPERATION_REGISTRY[node.op];
    if(!spec)return stableAlgorithmJSON(node);
    const args=node.args.map(sub);
    if(prose)return spec.reading.replace(/\{([0-9]+)\}/g,(_,index)=>'('+args[Number(index)]+')');
    if(node.op==='select')return '('+args[0]+' ? '+args[1]+' : '+args[2]+')';
    if(spec.arity===1)return '('+spec.operator+(/^[a-z]/.test(spec.operator)?' ':'')+args[0]+')';
    return '('+args[0]+' '+spec.operator+' '+args[1]+')';
  }
  return {term,val};
}
export function renderAlgorithmV8Term(term,{style='hybrid',scopeArities=[]}={}){
  styleCheck(style);validateTermV8(term,{scopes:scopeArities});
  const scopes=scopeArities.map((arity,depth)=>Array.from({length:arity},(_,index)=>'bound'+depth+'_'+index));
  return printer(style).term(term,scopes);
}
export function renderAlgorithmV8Record(record,{style='hybrid'}={}){
  styleCheck(style);
  if(style==='canonical')return stableAlgorithmJSON(record);
  const render=printer(style);
  const exact=keys=>isAlgorithmDataRecord(record)&&Object.keys(record).length===keys.length&&keys.every(key=>Object.hasOwn(record,key));
  if(record?.kind==='compute'&&exact(['kind','id','term','result'])){
    assertAlgorithmId(record.id);validateTermV8(record.term);assertAlgorithmValue(record.result);
    return style==='prose'?'Compute '+record.id+' as '+render.term(record.term)+'. The result is '+render.val(record.result)+'.':
      record.id+' = '+render.term(record.term)+' => '+render.val(record.result);
  }
  if(['return','throw'].includes(record?.kind)&&exact(['kind','value'])){
    assertAlgorithmValue(record.value);return (style==='prose'?record.kind[0].toUpperCase()+record.kind.slice(1):record.kind)+' '+
      render.val(record.value)+(style==='prose'?'.':'');
  }
  // A new region envelope has a lossless explicit reading until its prose is
  // reviewed. Omitting unknown context/claim fields would change information.
  return stableAlgorithmJSON(record);
}
export function renderAlgorithmV8(core,{style='hybrid'}={}){
  styleCheck(style);validateAlgorithmV8(core);
  if(style==='canonical')return stableAlgorithmJSON(core);
  const render=printer(style),header='Profile '+core.profile+'; inputs '+core.inputs.map(input=>input.id+': '+input.type).join(', ')+'.';
  return header+'\n'+core.steps.map(step=>step.kind==='compute'?
    (style==='prose'?'Compute '+step.id+' as '+render.term(step.term)+'.':step.id+' = '+render.term(step.term)):
    (style==='prose'?step.kind[0].toUpperCase()+step.kind.slice(1):step.kind)+' '+render.term(step.value)+(style==='prose'?'.':'')).join('\n');
}
