// Independent V8 observation only. This module does not import the owned runtime,
// source projector, or public evaluator. It observes exactly selected builtin calls.
import {parse} from 'acorn';
import {types} from 'node:util';

const hook='__tracingProtocolIteratorCallee';
const profile='builtin-iterator/1';
const apply=Reflect.apply,ownDescriptors=Object.getOwnPropertyDescriptors,getPrototype=Object.getPrototypeOf;
const own=Object.getOwnPropertyDescriptor;
function instrument(source){
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'}),edits=[];
  function visit(node,inChain=false){
    if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(child=>visit(child,inChain));return;}
    inChain||=node.type==='ChainExpression';
    if(!inChain&&node.type==='CallExpression'&&!node.optional&&node.callee.type==='MemberExpression'&&!node.callee.optional&&
      node.callee.object.type!=='Super'&&node.callee.property.type!=='PrivateIdentifier'){
      const member=node.callee;
      if(member.computed||['values','keys','entries','next','add','delete','clear','set'].includes(member.property.name)){
        // A curried helper performs lookup before arguments, preserving exceptions and order.
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
  return {kind:'iterator',prototype:node.iterationKind==='string'?'StringIterator.prototype':
    node.iterationKind.startsWith('set-')?'SetIterator.prototype':node.iterationKind.startsWith('map-')?'MapIterator.prototype':'ArrayIterator.prototype',
    extensible:true,properties:[],annotations:[{name:profile,values:[node.iterated],
      data:{iterationKind:node.iterationKind,nextIndex:node.nextIndex,done:node.done}}]};
}
export function createIteratorObservationAdapterV8({side}={}){
  if(side==='owned')return {id:profile,metadataAdapter:{ownedNode}};
  const cursors=new WeakMap(),factories=new Map(),iteratorPrototypes=new Map(),nextMethods=new Set(),identityMethods=new Set(),
    mutators=new Map();let lookup=null,collectionReader=null;
  let invoke=call=>observeCall(call,()=>apply(call.callee,call.receiver,call.arguments));
  function require(condition,message){if(!condition)throw new TypeError('Independent iterator observation: '+message);}
  function readCursor(value){
    require(value!==null&&['object','function'].includes(typeof value)&&!types.isProxy(value),'ordinary iterator receiver');
    const cursor=cursors.get(value);require(cursor,'builtin next receiver has no independently observed allocation');return cursor;
  }
  function selected(receiver,key){
    require(lookup,'guest-realm lookup has not been initialized');
    const method=apply(lookup,undefined,[receiver,key]);
    return (...args)=>invoke({callee:method,receiver,arguments:args});
  }
  function collectionSnapshot(receiver,kind){
    const cursorIterator=collectionReader.create(kind,receiver),rows=[];
    for(let count=0;count<=10000;count++){
      const step=collectionReader.next(kind,cursorIterator),done=own(step,'done'),value=own(step,'value');
      require(done&&Object.hasOwn(done,'value')&&typeof done.value==='boolean','collection iterator result done field');
      if(done.value)return rows;
      require(value&&Object.hasOwn(value,'value'),'collection iterator result value field');
      if(kind==='map'){
        const pair=value.value,d0=Array.isArray(pair)&&own(pair,'0'),d1=Array.isArray(pair)&&own(pair,'1');
        require(d0&&d1&&Object.hasOwn(d0,'value')&&Object.hasOwn(d1,'value'),'Map iteration pair shape');
        rows.push([d0.value,d1.value]);
      }else rows.push(value.value);
    }
    require(false,'collection iteration bound');return rows;
  }
  function sameValueZero(a,b){return a===b||a!==a&&b!==b;}
  function updateCollections(receiver,method,args,result){
    const mutator=mutators.get(method);if(!mutator)return;
    require(mutator.kind==='set'?types.isSet(receiver):types.isMap(receiver),'collection mutator receiver');
    const live=cursors;
    // WeakMap cannot be iterated. Active cursors are retained separately below.
    for(const cursor of activeCursors){
      if(cursor.iterated!==receiver||cursor.done||!cursor.iterationKind.startsWith(mutator.kind+'-'))continue;
      const rows=cursor.rows,key=args[0];
      if(mutator.op==='clear'){for(let i=0;i<rows.length;i++)rows[i]=null;continue;}
      const index=rows.findIndex(row=>row!==null&&sameValueZero(mutator.kind==='set'?row:row[0],key));
      if(mutator.op==='delete'){if(result&&index>=0)rows[index]=null;continue;}
      if(mutator.kind==='set'&&mutator.op==='add'){if(index<0)rows.push(key===0?0:key);continue;}
      if(mutator.kind==='map'&&mutator.op==='set'){
        if(index<0)rows.push([key===0?0:key,args[1]]);else rows[index]=[rows[index][0],args[1]];
      }
    }
  }
  const activeCursors=new Set();
  function advanceCollection(cursor,result){
    const rows=cursor.rows;let position=cursor.nextIndex;
    while(position<rows.length&&rows[position]===null)position++;
    let expected,done=false;
    if(position>=rows.length){cursor.nextIndex=position;cursor.done=true;done=true;expected=undefined;}
    else{
      const row=rows[position];cursor.nextIndex=position+1;
      if(cursor.iterationKind==='set-values'||cursor.iterationKind==='set-keys')expected=row;
      else if(cursor.iterationKind==='set-entries')expected=[row,row];
      else if(cursor.iterationKind==='map-keys')expected=row[0];
      else if(cursor.iterationKind==='map-values')expected=row[1];
      else expected=[row[0],row[1]];
    }
    const actualDone=own(result,'done'),actualValue=own(result,'value');
    require(actualDone&&Object.hasOwn(actualDone,'value')&&actualDone.value===done,'collection iterator completion differs');
    require(actualValue&&Object.hasOwn(actualValue,'value'),'collection iterator value field');
    const actual=actualValue.value;
    if(!done&&Array.isArray(expected)){
      require(Array.isArray(actual)&&Object.is(actual[0],expected[0])&&Object.is(actual[1],expected[1]),'collection iterator entry value differs');
    }else require(done||sameValueZero(actual,expected),'collection iterator yielded a different value');
  }
  function observeCall(call,next){
    const {callee:method,receiver}=call,kind=factories.get(method);
    if(kind){
      const string=kind==='string',collection=kind.startsWith('set-')||kind.startsWith('map-');
      require(string?typeof receiver==='string':collection?
        (kind.startsWith('set-')?types.isSet(receiver):types.isMap(receiver)):
        Array.isArray(receiver)&&!types.isProxy(receiver),'declared iterator source');
      const result=next();require(result!==null&&typeof result==='object'&&!types.isProxy(result),'builtin iterator result');
      if(collection){
        const type=kind.startsWith('set-')?'set':'map';
        const rows=collectionSnapshot(receiver,type),cursor={iterated:receiver,iterationKind:kind,nextIndex:0,done:false,rows};
        cursors.set(result,cursor);activeCursors.add(cursor);
      }else{
        const cursor={iterated:receiver,iterationKind:kind,nextIndex:0,done:false};
        cursors.set(result,cursor);activeCursors.add(cursor);
      }
      return result;
    }
    if(nextMethods.has(method)){
      const cursor=readCursor(receiver);
      if(!cursor.done){
        if(cursor.iterationKind==='string'){
          const index=cursor.nextIndex;
          if(index>=cursor.iterated.length)cursor.done=true;
          else{const first=cursor.iterated.charCodeAt(index),second=cursor.iterated.charCodeAt(index+1);
            cursor.nextIndex+=first>=0xd800&&first<=0xdbff&&second>=0xdc00&&second<=0xdfff?2:1;}
          const result=next();
          const stepDone=own(result,'done'),stepValue=own(result,'value');
          require(stepDone&&stepValue&&Object.hasOwn(stepDone,'value')&&Object.hasOwn(stepValue,'value'),'string iterator result shape');
          require(stepDone.value===cursor.done,'string iterator completion differs');return result;
        }
        if(cursor.iterationKind==='values'||cursor.iterationKind==='keys'||cursor.iterationKind==='entries'){
          const length=own(cursor.iterated,'length');
          require(length&&Object.hasOwn(length,'value')&&Number.isSafeInteger(length.value),'ordinary array length');
          if(cursor.nextIndex>=length.value)cursor.done=true;else cursor.nextIndex++;
          const result=next();const stepDone=own(result,'done');
          require(stepDone&&Object.hasOwn(stepDone,'value')&&stepDone.value===cursor.done,'array iterator completion differs');return result;
        }
        const result=next();advanceCollection(cursor,result);return result;
      }
      const result=next();
      if(cursor.rows)advanceCollection(cursor,result);
      return result;
    }
    if(mutators.has(method)){
      const result=next();updateCollections(receiver,method,call.arguments,result);return result;
    }
    // Iterator.prototype's identity method is inherited by custom iterators too.
    if(identityMethods.has(method)&&cursors.has(receiver))readCursor(receiver);
    return next();
  }
  return {id:profile,instrument,observeCall,globals:{[hook]:selected},setCallObserver(value){invoke=value;},
    initializeRealm(evaluate){
      const captured=evaluate('(()=>{const a=[][Symbol.iterator](),s=""[Symbol.iterator](),si=new Set()[Symbol.iterator](),mi=new Map()[Symbol.iterator]();return {'+
        'values:Array.prototype.values,keys:Array.prototype.keys,entries:Array.prototype.entries,'+
        'string:String.prototype[Symbol.iterator],arrayPrototype:Object.getPrototypeOf(a),stringPrototype:Object.getPrototypeOf(s),'+
        'setPrototype:Set.prototype,mapPrototype:Map.prototype,setValues:Set.prototype.values,setKeys:Set.prototype.keys,setEntries:Set.prototype.entries,'+
        'mapKeys:Map.prototype.keys,mapValues:Map.prototype.values,mapEntries:Map.prototype.entries,'+
        'arrayNext:a.next,stringNext:s.next,setNext:si.next,mapNext:mi.next,'+
        'identity:a[Symbol.iterator],lookup:(receiver,key)=>receiver[key],'+
        'setAdd:Set.prototype.add,setDelete:Set.prototype.delete,setClear:Set.prototype.clear,'+
        'mapSet:Map.prototype.set,mapDelete:Map.prototype.delete,mapClear:Map.prototype.clear};})()');
      for(const kind of ['values','keys','entries'])factories.set(captured[kind],kind);
      factories.set(captured.string,'string');
      for(const [method,kind]of [[captured.setValues,'set-values'],[captured.setEntries,'set-entries'],
        [captured.mapKeys,'map-keys'],[captured.mapValues,'map-values'],[captured.mapEntries,'map-entries']])factories.set(method,kind);
      iteratorPrototypes.set(captured.arrayPrototype,'ArrayIterator.prototype');iteratorPrototypes.set(captured.stringPrototype,'StringIterator.prototype');
      identityMethods.add(captured.identity);lookup=captured.lookup;
      nextMethods.add(captured.arrayNext);nextMethods.add(captured.stringNext);nextMethods.add(captured.setNext);nextMethods.add(captured.mapNext);
      mutators.set(captured.setAdd,{kind:'set',op:'add'});mutators.set(captured.setDelete,{kind:'set',op:'delete'});
      mutators.set(captured.setClear,{kind:'set',op:'clear'});mutators.set(captured.mapSet,{kind:'map',op:'set'});
      mutators.set(captured.mapDelete,{kind:'map',op:'delete'});mutators.set(captured.mapClear,{kind:'map',op:'clear'});
      iteratorPrototypes.set(getPrototype(captured.setValues.call(new Set())),'SetIterator.prototype');
      iteratorPrototypes.set(getPrototype(captured.mapEntries.call(new Map())),'MapIterator.prototype');
      const setNext=captured.setNext,mapNext=captured.mapNext,setValues=captured.setValues,mapEntries=captured.mapEntries;
      collectionReader={create(kind,receiver){return kind==='set'?apply(setValues,receiver,[]):apply(mapEntries,receiver,[]);},
        next(kind,iterator){return apply(kind==='set'?setNext:mapNext,iterator,[]);}};
      // Boundary input graphs may come from the outer realm.
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
