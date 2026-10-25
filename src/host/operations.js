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
  // Callback slots are explicit operation capabilities, never encoded as
  // plain object data or executed in the native host's JS realm.
  'demo.withCallback':Object.freeze({kind:'promise',signature:'demo.withCallback/1',
    arity:2,key:0,callbackIndices:Object.freeze([1]),codec:JSON_CODEC}),
  'demo.listen':Object.freeze({kind:'promise',signature:'demo.listen/1',arity:2,
    key:0,callbackIndices:Object.freeze([1]),callbackLifetime:'subscription',
    codec:JSON_CODEC}),
  'demo.unlisten':Object.freeze({kind:'promise',signature:'demo.unlisten/1',
    arity:1,key:0,codec:JSON_CODEC}),
  'demo.readNumber':Object.freeze({kind:'synchronous',signature:'demo.readNumber/1',arity:1,key:0,codec:JSON_CODEC}),
  'demo.store':Object.freeze({kind:'synchronous',signature:'demo.store/1',arity:2,key:0,codec:JSON_CODEC}),
  'http.get':Object.freeze({kind:'promise',signature:'http.get/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.post':Object.freeze({kind:'promise',signature:'http.post/1',arity:2,key:0,codec:JSON_CODEC}),
  'http.responseStatus':Object.freeze({kind:'promise',signature:'http.responseStatus/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseRead':Object.freeze({kind:'promise',signature:'http.responseRead/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseClose':Object.freeze({kind:'promise',signature:'http.responseClose/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.abort':Object.freeze({kind:'promise',signature:'http.abort/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.readText':Object.freeze({kind:'promise',signature:'fs.readText/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.writeText':Object.freeze({kind:'promise',signature:'fs.writeText/1',arity:2,key:0,codec:JSON_CODEC}),
  'fs.list':Object.freeze({kind:'promise',signature:'fs.list/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.openRead':Object.freeze({kind:'promise',signature:'fs.openRead/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.readChunk':Object.freeze({kind:'promise',signature:'fs.readChunk/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.close':Object.freeze({kind:'promise',signature:'fs.close/1',arity:1,key:0,codec:JSON_CODEC}),
  'net.connect':Object.freeze({kind:'promise',signature:'net.connect/1',arity:2,key:0,codec:JSON_CODEC}),
  'net.write':Object.freeze({kind:'promise',signature:'net.write/1',arity:2,key:0,codec:JSON_CODEC}),
  'net.read':Object.freeze({kind:'promise',signature:'net.read/1',arity:1,key:0,codec:JSON_CODEC}),
  'net.close':Object.freeze({kind:'promise',signature:'net.close/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.query':Object.freeze({kind:'promise',signature:'dom.query/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.getText':Object.freeze({kind:'promise',signature:'dom.getText/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.setText':Object.freeze({kind:'promise',signature:'dom.setText/1',arity:2,key:0,codec:JSON_CODEC}),
  'dom.setAttribute':Object.freeze({kind:'promise',signature:'dom.setAttribute/1',arity:3,key:0,codec:JSON_CODEC}),
  'dom.getAttribute':Object.freeze({kind:'promise',signature:'dom.getAttribute/1',arity:2,key:0,codec:JSON_CODEC}),
  'dom.remove':Object.freeze({kind:'promise',signature:'dom.remove/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.on':Object.freeze({kind:'promise',signature:'dom.on/1',arity:3,key:0,callbackIndices:Object.freeze([2]),callbackLifetime:'subscription',codec:JSON_CODEC}),
  'dom.off':Object.freeze({kind:'promise',signature:'dom.off/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.startTimer':Object.freeze({kind:'promise',signature:'dom.startTimer/1',arity:2,key:null,callbackIndices:Object.freeze([1]),callbackLifetime:'subscription',codec:JSON_CODEC}),
  'dom.stopTimer':Object.freeze({kind:'promise',signature:'dom.stopTimer/1',arity:1,key:0,codec:JSON_CODEC})
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
  const data=materializeJson(heap,args,{...limits,callbackIndices:spec.callbackIndices??[]});
  if(data.codec!==spec.codec)throw new Error('Unregistered host codec');
  return Object.freeze({schema:'host-request/1',operation,signature:spec.signature,
    codec:spec.codec,payload:data.payload,byteLength:data.byteLength,
    graphVersions:data.graphVersions});
}
