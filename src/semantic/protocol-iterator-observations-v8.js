// Independent V8 observation only. This module does not import the owned runtime,
// source projector, or public evaluator. It never advances an iterator to inspect
// it; it observes exactly the builtin calls already selected by the source.
import {parse} from 'acorn';
import {types} from 'node:util';

const hook='__tracingProtocolIteratorCallee';
const profile='builtin-iterator/1';
const apply=Reflect.apply,ownDescriptors=Object.getOwnPropertyDescriptors,getPrototype=Object.getPrototypeOf;
function instrument(source){
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'}),edits=[];
  function visit(node,inChain=false){
    if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(child=>visit(child,inChain));return;}
    inChain||=node.type==='ChainExpression';
    if(!inChain&&node.type==='CallExpression'&&!node.optional&&node.callee.type==='MemberExpression'&&!node.callee.optional&&
      node.callee.object.type!=='Super'&&node.callee.property.type!=='PrivateIdentifier'){
      const member=node.callee;
      if(member.computed||['values','keys','entries','next'].includes(member.property.name)){
        // A curried helper performs the property lookup before argument
        // evaluation, preserving receiver/key/argument order and exceptions.
        edits.push({start:member.start,end:member.object.start,text:hook+'(('});
        edits.push({start:member.object.end,end:member.property.start,text:'),'+(member.computed?'(':JSON.stringify(member.property.name))});
        if(member.computed)edits.push({start:member.property.end,end:member.end,text:'))'});
        else edits.push({start:member.property.start,end:member.end,text:')'});
      }
    }
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value,inChain);
  }
  visit(ast);edits.sort((a,b)=>b.start-a.start||b.end-a.end);
  let end=source.length;
  for(const edit of edits){if(edit.end>end)throw new TypeError('Overlapping iterator observation edits');
    source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);end=edit.start;}
  return source;
}
function ownedNode(tag,ctx){
  const node=tag[0]==='ref'?ctx.state.heap[tag[1]]:null;if(node?.kind!=='iterator')return null;
  if(Object.keys(node.properties??{}).length||Object.keys(node.accessors??{}).length||node.prototype!==undefined||
    node.extensible===false||Object.keys(node.dataAttributes??{}).length)ctx.fail('iterator own-state extension is outside the observation profile');
  return {kind:'iterator',prototype:node.iterationKind==='string'?'StringIterator.prototype':'ArrayIterator.prototype',extensible:true,properties:[],
    annotations:[{name:profile,values:[node.iterated],data:{iterationKind:node.iterationKind,nextIndex:node.nextIndex,done:node.done}}]};
}
export function createIteratorObservationAdapterV8({side}={}){
  if(side==='owned')return {id:profile,metadataAdapter:{ownedNode}};
  const cursors=new WeakMap(),factories=new Map(),iteratorPrototypes=new Map(),nextMethods=new Set(),identityMethods=new Set();let lookup=null;
  let invoke=call=>observeCall(call,()=>apply(call.callee,call.receiver,call.arguments));
  function require(condition,message){if(!condition)throw new TypeError('Independent iterator observation: '+message);}
  function readCursor(value){
    require(value!==null&&['object','function'].includes(typeof value)&&!types.isProxy(value),'ordinary iterator receiver');
    const cursor=cursors.get(value);require(cursor,'builtin next receiver has no independently observed allocation');return cursor;
  }
  function selected(receiver,key){
    require(lookup,'guest-realm lookup has not been initialized');
    // Primitive boxing must use the guest realm's intrinsic prototypes.
    const method=apply(lookup,undefined,[receiver,key]);
    return (...args)=>invoke({callee:method,receiver,arguments:args});
  }
  function observeCall(call,next){
      const {callee:method,receiver}=call,kind=factories.get(method);
      if(kind){
        require(kind==='string'?typeof receiver==='string':Array.isArray(receiver)&&!types.isProxy(receiver),'declared iterator source');
        const result=next();require(result!==null&&typeof result==='object'&&!types.isProxy(result),'builtin iterator result');
        cursors.set(result,{iterated:receiver,iterationKind:kind,nextIndex:0,done:false});return result;
      }
      if(nextMethods.has(method)){
        const cursor=readCursor(receiver);
        if(!cursor.done){
          const index=cursor.nextIndex;
          if(cursor.iterationKind==='string'){
            if(index>=cursor.iterated.length)cursor.done=true;
            else{const first=cursor.iterated.charCodeAt(index),second=cursor.iterated.charCodeAt(index+1);
              cursor.nextIndex+=first>=0xd800&&first<=0xdbff&&second>=0xdc00&&second<=0xdfff?2:1;}
          }else{
            const length=Object.getOwnPropertyDescriptor(cursor.iterated,'length');
            require(length&&Object.hasOwn(length,'value')&&Number.isSafeInteger(length.value),'ordinary array length');
            if(index>=length.value)cursor.done=true;else cursor.nextIndex++;
          }
        }
        return next();
      }
      // Iterator.prototype's identity method is also inherited by generators
      // and custom iterators; their registered observer owns hidden state.
      if(identityMethods.has(method)&&cursors.has(receiver))readCursor(receiver);
      return next();
  }
  return {id:profile,instrument,observeCall,globals:{[hook]:selected},setCallObserver(value){invoke=value;},
    initializeRealm(evaluate){
      const captured=evaluate('(()=>{const a=[][Symbol.iterator](),s=""[Symbol.iterator]();return '+
        '{values:Array.prototype.values,keys:Array.prototype.keys,entries:Array.prototype.entries,'+
        'string:String.prototype[Symbol.iterator],arrayPrototype:Object.getPrototypeOf(a),stringPrototype:Object.getPrototypeOf(s),'+
        'next:a.next,stringNext:s.next,identity:a[Symbol.iterator],lookup:(receiver,key)=>receiver[key]};})()');
      for(const kind of ['values','keys','entries'])factories.set(captured[kind],kind);factories.set(captured.string,'string');
      iteratorPrototypes.set(captured.arrayPrototype,'ArrayIterator.prototype');iteratorPrototypes.set(captured.stringPrototype,'StringIterator.prototype');
      // String and array iterators have distinct next functions.
      identityMethods.add(captured.identity);lookup=captured.lookup;
      nextMethods.add(captured.next);nextMethods.add(captured.stringNext);
      // Boundary input graphs are allocated in the worker's outer realm.
      // Their real prototype methods are captured before guest execution too.
      for(const kind of ['values','keys','entries'])factories.set(Array.prototype[kind],kind);
      factories.set(String.prototype[Symbol.iterator],'string');
      const outerArray=[][Symbol.iterator](),outerString=''[Symbol.iterator]();
      iteratorPrototypes.set(getPrototype(outerArray),'ArrayIterator.prototype');iteratorPrototypes.set(getPrototype(outerString),'StringIterator.prototype');
      nextMethods.add(outerArray.next);nextMethods.add(outerString.next);identityMethods.add(outerArray[Symbol.iterator]);
    },
    metadataAdapter:{ownedNode,nativeNode(value,ctx){
      const prototype=getPrototype(value),intrinsic=iteratorPrototypes.get(prototype),cursor=cursors.get(value);
      if(!intrinsic&&!cursor)return null;
      require(cursor&&intrinsic,'iterator internal state lacks its independently observed creation');
      const descriptors=ownDescriptors(value);require(Reflect.ownKeys(descriptors).length===0&&Object.isExtensible(value),'iterator own-state extension');
      return {kind:'iterator',prototype:intrinsic,extensible:true,properties:[],annotations:[{
        name:profile,values:[cursor.iterated],data:{iterationKind:cursor.iterationKind,nextIndex:cursor.nextIndex,done:cursor.done}}]};
    }}
  };
}
