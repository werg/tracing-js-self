// The existing name/message exception boundary has an explicit projection;
// it never changes the live Error object or admits descriptor observations.
import {ERROR_CONSTRUCTORS} from '../owned-error-objects.js';
export function ownedExceptionFields(node){
  if(!node?.declaredError)return null;
  if(node.kind!=='object'||!ERROR_CONSTRUCTORS.includes(node.declaredError)||
    node.prototype!==node.declaredError+'.prototype'||node.extensible===false||
    Object.keys(node.accessors??{}).length||Object.keys(node.properties??{}).some(key=>key!=='message')||
    Object.keys(node.dataAttributes??{}).some(key=>key!=='message'))
    throw new TypeError('Unsupported exception boundary: altered owned Error shape');
  const message=node.properties.message?.value??['str',''],d=node.dataAttributes?.message;
  if(message[0]!=='str'||node.properties.message&&(!d||d.enumerable||!d.writable||!d.configurable))
    throw new TypeError('Unsupported exception boundary: owned Error message descriptor');
  return [{key:'name',value:['str',node.declaredError]},{key:'message',value:structuredClone(message)}];
}
