// Versioned, fail-closed declarations for the prototype's external boundary.
// The codec is a transport contract, not an ECMAScript ToJSON evaluation.
import {materializeHostArguments, JSON_CODEC} from './materialize.js';

export const HOST_METHODS=Object.freeze({"natlangCall":"natlang.call","natlangCallSync":"natlang.callSync","natlangReadCell":"natlang.readCell","natlangWriteCell":"natlang.writeCell","httpGet":"http.get","httpPost":"http.post","httpRequest":"http.request","httpHeaders":"http.responseHeaders","httpReadChunk":"http.responseReadChunk","httpState":"http.responseState","httpStatus":"http.responseStatus","httpRead":"http.responseRead","httpClose":"http.responseClose","httpAbort":"http.abort","readText":"fs.readText","writeText":"fs.writeText","listFiles":"fs.list","openRead":"fs.openRead","readChunk":"fs.readChunk","closeStream":"fs.close","openWrite":"fs.openWrite","writeChunk":"fs.writeChunk","closeWrite":"fs.closeWrite","socketConnect":"net.connect","socketWrite":"net.write","socketRead":"net.read","socketClose":"net.close","domQuery":"dom.query","domGetText":"dom.getText","domSetText":"dom.setText","domSetAttribute":"dom.setAttribute","domGetAttribute":"dom.getAttribute","domRemove":"dom.remove","domRelease":"dom.release","domOn":"dom.on","domOff":"dom.off","domStartTimer":"dom.startTimer","domStopTimer":"dom.stopTimer"});

export const SUBSCRIPTION_CLOSERS=Object.freeze({
  'demo.unlisten':'demo.listen','dom.off':'dom.on','dom.stopTimer':'dom.startTimer'
});

const DECLARED_OPERATIONS={
  'natlang.call':Object.freeze({kind:'promise',signature:'natlang.call/1',arity:3,key:0,codec:'owned-graph/1',callbackGraph:true}),
  'natlang.callSync':Object.freeze({kind:'synchronous',signature:'natlang.callSync/1',arity:3,key:0,codec:'owned-graph/1',callbackGraph:true}),
  'natlang.readCell':Object.freeze({kind:'synchronous',signature:'natlang.readCell/1',arity:1,key:0,codec:'owned-graph/1'}),
  'natlang.writeCell':Object.freeze({kind:'synchronous',signature:'natlang.writeCell/1',arity:2,key:0,codec:'owned-graph/1'}),
  'platform.dateNow':Object.freeze({kind:'synchronous',signature:'platform.dateNow/1',arity:0,key:null,codec:JSON_CODEC}),
  'platform.console.log':Object.freeze({kind:'synchronous',signature:'platform.console.log/1',arity:1,key:null,codec:JSON_CODEC}),
  'platform.console.info':Object.freeze({kind:'synchronous',signature:'platform.console.info/1',arity:1,key:null,codec:JSON_CODEC}),
  'platform.console.warn':Object.freeze({kind:'synchronous',signature:'platform.console.warn/1',arity:1,key:null,codec:JSON_CODEC}),
  'platform.console.error':Object.freeze({kind:'synchronous',signature:'platform.console.error/1',arity:1,key:null,codec:JSON_CODEC}),
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
  'http.request':Object.freeze({kind:'promise',signature:'http.request/1',arity:4,key:0,codec:JSON_CODEC}),
  'http.responseStatus':Object.freeze({kind:'promise',signature:'http.responseStatus/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseHeaders':Object.freeze({kind:'promise',signature:'http.responseHeaders/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseRead':Object.freeze({kind:'promise',signature:'http.responseRead/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseReadChunk':Object.freeze({kind:'promise',signature:'http.responseReadChunk/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseState':Object.freeze({kind:'promise',signature:'http.responseState/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.responseClose':Object.freeze({kind:'promise',signature:'http.responseClose/1',arity:1,key:0,codec:JSON_CODEC}),
  'http.abort':Object.freeze({kind:'promise',signature:'http.abort/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.readText':Object.freeze({kind:'promise',signature:'fs.readText/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.writeText':Object.freeze({kind:'promise',signature:'fs.writeText/1',arity:2,key:0,codec:JSON_CODEC}),
  'fs.list':Object.freeze({kind:'promise',signature:'fs.list/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.openRead':Object.freeze({kind:'promise',signature:'fs.openRead/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.readChunk':Object.freeze({kind:'promise',signature:'fs.readChunk/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.close':Object.freeze({kind:'promise',signature:'fs.close/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.openWrite':Object.freeze({kind:'promise',signature:'fs.openWrite/1',arity:1,key:0,codec:JSON_CODEC}),
  'fs.writeChunk':Object.freeze({kind:'promise',signature:'fs.writeChunk/1',arity:2,key:0,codec:JSON_CODEC}),
  'fs.closeWrite':Object.freeze({kind:'promise',signature:'fs.closeWrite/1',arity:1,key:0,codec:JSON_CODEC}),
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
  'dom.release':Object.freeze({kind:'promise',signature:'dom.release/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.on':Object.freeze({kind:'promise',signature:'dom.on/1',arity:3,key:0,callbackIndices:Object.freeze([2]),callbackLifetime:'subscription',codec:JSON_CODEC}),
  'dom.off':Object.freeze({kind:'promise',signature:'dom.off/1',arity:1,key:0,codec:JSON_CODEC}),
  'dom.startTimer':Object.freeze({kind:'promise',signature:'dom.startTimer/1',arity:2,key:null,callbackIndices:Object.freeze([1]),callbackLifetime:'subscription',codec:JSON_CODEC}),
  'dom.stopTimer':Object.freeze({kind:'promise',signature:'dom.stopTimer/1',arity:1,key:0,codec:JSON_CODEC})
};

// One public descriptor supplies collection, serving, emission and the native
// Python consumer. Host embeddings can narrow grants, never widen them through
// request data. Replay always consumes observations without calling services.
const scopes={platform:'embedding',demo:'fixture',http:'origin',fs:'filesystem-root',
  net:'endpoint',dom:'dom-root',natlang:'registered-resource'};
const readers=new Set(['platform.dateNow','demo.readAsync','demo.readNumber',
  'http.get','http.responseStatus','http.responseHeaders','http.responseState',
  'fs.readText','fs.list','dom.query','dom.getText','dom.getAttribute','natlang.readCell']);
const resources=new Set(['http.get','http.post','http.request','fs.openRead','fs.openWrite',
  'net.connect','dom.query','demo.listen','dom.on','dom.startTimer']);
export const HOST_OPERATION_SCHEMA='host-operations/4';
export const HOST_OPERATIONS=Object.freeze(Object.fromEntries(Object.entries(DECLARED_OPERATIONS)
  .map(([name,spec])=>[name,Object.freeze({...spec,
    callbackIndices:Object.freeze([...(spec.callbackIndices??[])]),
    callbackLifetime:spec.callbackLifetime??(spec.callbackIndices?.length?'call':'none'),
    callbackReturn:spec.callbackGraph?'promise':'void',
    callbackProfile:spec.callbackGraph?'owned-async-reentry':'owned-deferred-job',
    resultCodec:name.startsWith('natlang.')?'owned-graph/1':'canonical-scalar/1',
    authority:Object.freeze({scope:scopes[name.split('.')[0]],grant:'host-established',
      ownership:'session-and-realm'}),
    replay:'recorded-observations-only',
    retry:readers.has(name)?'host-policy':'reconcile-before-retry',
    cancellation:spec.kind==='promise'?'abort-signal-and-resource-close':'receipt-only',
    lifetime:resources.has(name)?'explicit-owner-and-close':'invocation',
    limits:Object.freeze({arguments:spec.arity,graphNodes:256,graphProperties:4096,
      payloadBytes:65536,callbackArguments:32})
  })])));

export function hostOperationContract(){
  return {schema:HOST_OPERATION_SCHEMA,operations:Object.entries(HOST_OPERATIONS)
    .sort(([a],[b])=>a.localeCompare(b)).map(([operation,spec])=>({operation,...spec}))};
}

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
  const data=materializeHostArguments(heap,args,{...limits,codec:spec.codec,
    callbackIndices:spec.callbackIndices??[],callbackGraph:spec.callbackGraph??false});
  if(data.codec!==spec.codec)throw new Error('Unregistered host codec');
  return Object.freeze({schema:'host-request/1',operation,signature:spec.signature,
    codec:spec.codec,payload:data.payload,byteLength:data.byteLength,
    graphVersions:data.graphVersions});
}
