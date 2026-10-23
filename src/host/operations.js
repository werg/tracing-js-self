// Versioned, fail-closed declarations for the prototype's external boundary.
// The codec is a transport contract, not an ECMAScript ToJSON evaluation.
import {materializeJson, JSON_CODEC} from './materialize.js';

export const HOST_OPERATIONS=Object.freeze({
  'platform.dateNow':Object.freeze({kind:'synchronous',signature:'platform.dateNow/1',arity:0,key:null,codec:JSON_CODEC}),
  'platform.console.log':Object.freeze({kind:'synchronous',signature:'platform.console.log/1',arity:1,key:0,codec:JSON_CODEC}),
  'platform.console.info':Object.freeze({kind:'synchronous',signature:'platform.console.info/1',arity:1,key:0,codec:JSON_CODEC}),
  'platform.console.warn':Object.freeze({kind:'synchronous',signature:'platform.console.warn/1',arity:1,key:0,codec:JSON_CODEC}),
  'platform.console.error':Object.freeze({kind:'synchronous',signature:'platform.console.error/1',arity:1,key:0,codec:JSON_CODEC}),
  'demo.readAsync':Object.freeze({kind:'promise',signature:'demo.readAsync/1',arity:1,key:0,codec:JSON_CODEC}),
  'demo.readNumber':Object.freeze({kind:'synchronous',signature:'demo.readNumber/1',arity:1,key:0,codec:JSON_CODEC}),
  'demo.store':Object.freeze({kind:'synchronous',signature:'demo.store/1',arity:2,key:0,codec:JSON_CODEC})
});

export function hostOperation(name) {
  if(!Object.hasOwn(HOST_OPERATIONS,name))
    throw new TypeError(`Unregistered host operation ${name}`);
  return HOST_OPERATIONS[name];
}

export function prepareHostRequest(heap,operation,args,limits={}) {
  const spec=hostOperation(operation);
  if(!Array.isArray(args)||args.length!==spec.arity)
    throw new TypeError(`${operation} expects ${spec.arity} argument(s)`);
  if(spec.key!==null&&(!Array.isArray(args[spec.key])||
     args[spec.key][0]!=='str'||typeof args[spec.key][1]!=='string'))
    throw new TypeError(`${operation} expects a string operation key`);
  const data=materializeJson(heap,args,limits);
  if(data.codec!==spec.codec)throw new Error('Unregistered host codec');
  return Object.freeze({schema:'host-request/1',operation,signature:spec.signature,
    codec:spec.codec,payload:data.payload,byteLength:data.byteLength,
    graphVersions:data.graphVersions});
}
