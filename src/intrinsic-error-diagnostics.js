// Pinned V8 diagnostic formatting reads owned tags, never guest conversion hooks.
// The ECMAScript exception identity is independent of this engine text.
import {decode} from './values.js';
export function invalidInMessage(key,target,{node,symbolDescription}){
  function display(value){
    if(value[0]==='symbol'){
      const description=value[1].startsWith('well-known:')?['str','Symbol.'+value[1].slice(11)]:symbolDescription(value[1]);
      if(!description||!['str','undefined'].includes(description[0]))throw new TypeError('Invalid-in diagnostic requires a declared Symbol');
      return 'Symbol('+(description[0]==='str'?description[1]:'')+')';
    }
    if(value[0]==='ref'){
      const object=node(value[1]);
      if(object?.kind==='array')return '[object Array]';
      if(object?.kind==='object'&&[undefined,'ordinary','Object.prototype',null].includes(object.prototype)&&!object.declaredError)
        return object.prototype===null?'[object Object]':'#<Object>';
      throw new TypeError('Invalid-in diagnostic requires its owned object display profile');
    }
    if(!['undefined','null','bool','num','str','bigint'].includes(value[0]))
      throw new TypeError('Invalid-in diagnostic value is outside the scalar profile');
    return String(decode(value));
  }
  return "Cannot use 'in' operator to search for '"+display(key)+"' in "+display(target);
}
