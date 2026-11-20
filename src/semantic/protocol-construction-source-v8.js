// Teacher-only lowering of owned class transitions to explicit public records.
// The serving machine receives no owned frames, bytecode, patches or journal.
import {propertyKeyValue,stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
import {decode,encode} from '../values.js';
import {constructionSourceInventoryV8} from './protocol-construction-source-inventory-v8.js';
import {describeConstructionObjectV8} from './protocol-construction-v8.js';

export const CONSTRUCTION_SOURCE_PROFILE_V8='class-private-source/1';
const U=['undefined'],ref=id=>['ref',id],literal=value=>({op:'literal',value});
const heapFields=['prototypeInitialized','classConstructor','derivedConstructor','homeObject','instanceInitializer','staticInitializer',
  'privateSlots','privateKinds','privateVersions'];
const frameFields=['constructReceiver','newTarget','constructorId','constructKind','thisInitialized','constructorArguments',
  'afterInstanceInitialization','classStaticResult','superInitializedResult'];
const specialFrames=new Set(frameFields);
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','ref','symbol'].includes(value[0]);
const finished=frame=>['completed','thrown'].includes(frame.status);

export function createConstructionSourceAdapterV8({bundle,source}){
  const inventory=constructionSourceInventoryV8(source);if(!inventory.classes.length)return null;
  const classes=new Map(inventory.classes.map(item=>[item.node.start,item])),definitions=new Map(),roles=new Map();
  for(const program of Object.values(bundle.programs))for(let index=0;index<program.instructions.length;index++){
    const instruction=program.instructions[index];if(instruction.op!=='MAKE_FUNCTION')continue;
    const code=instruction.arg.codeId,method=inventory.methods.get(instruction.start),item=classes.get(instruction.start);
    if(method){definitions.set(code,{classNode:method.classNode,placement:method.element.kind==='constructor'?'constructor':'method',node:method.element.value});continue;}
    if(!item)continue;
    const target=bundle.programs[code],isConstructor=target.instructions.some(row=>row.op==='CLASS_CONSTRUCTOR_GUARD'),
      init=program.instructions[index+2];
    const placement=isConstructor?'constructor':init?.op==='CLASS_INITIALIZER'?(init.arg.static?'static':'instance'):null;
    if(!placement||!inventory.synthetic.has('class:'+item.node.start+':'+placement))continue;
    const body=placement==='constructor'?[]:inventory.synthetic.get('class:'+item.node.start+':'+placement).body.flatMap(element=>
      element.type==='StaticBlock'?element.body:element.type==='PropertyDefinition'&&element.value?[element.value]:[]);
    definitions.set(code,{classNode:item.node,placement,code:'class:'+item.node.start+':'+placement,
      node:{type:'FunctionExpression',params:[],body:{type:'BlockStatement',body},start:item.node.start,end:item.node.end}});
  }
  function instruction(ctx,event){
    const frame=ctx.state.frames[event.invocationId],candidate=bundle.programs[event.codeId]?.instructions[frame?.pc];
    return candidate?.siteId===event.siteId?candidate:null;
  }
  const after=(ctx,event,table,id)=>event.stateChanges.find(change=>change.table===table&&change.id===id)?.after??ctx.state[table]?.[id];
  const addedFrame=event=>event.stateChanges.find(change=>change.table==='frames'&&change.before===null)?.after;
  const construction=(ctx,id)=>ctx.controller.protocol?.construction?.frames.find(row=>row.id===id);
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('construction: '+message);};
  function emit(ctx,record,event){ctx.emit(record,event,'owned-class-protocol/1');}
  function bindWrites(ctx,event,row){for(const write of row?.writes??[])if(write.kind==='cell')ctx.bind(ctx.cell(write.env,write.key),write.value,event);}
  function bindFrame(ctx,event,frame){
    const environment=after(ctx,event,'envs',frame.envId);
    for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized&&scalar(binding.token?.value))
      ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
  }
  function privateIdentity(ctx,event,name){
    for(let env=ctx.state.frames[event.invocationId]?.envId;env;env=ctx.state.envs[env]?.parent){
      const binding=ctx.state.envs[env]?.bindings?.['[[private '+name+']]'];
      if(binding){require(ctx,binding.initialized&&binding.token?.value?.[0]==='str','missing lexical private identity');return binding.token.value[1];}
    }
    ctx.refuse('construction: private identity is outside the lexical source environment');
  }
  function defineFunctionProperties(ctx,event,node){
    for(const key of ctx.orderedKeys(node))if(['name','length'].includes(key))
      emit(ctx,{kind:'property.define',object:node.id,key:propertyKeyValue(key),descriptor:ctx.descriptor(node,key),success:true},event);
  }
  function capability(node){const definition=definitions.get(node.codeId),isClass=definition?.placement==='constructor';
    return {constructorKind:isClass?(definition.classNode.superClass?'derived':'base'):
      node.arrow||node.nonConstructible?null:'base',classConstructor:isClass};
  }
  function enter(ctx,event,{mode='ordinary',owner=null}={}){
    const child=addedFrame(event),callee=event.operands[0];
    require(ctx,child&&callee?.[0]==='ref','constructor must enter an owned invocation');
    const fn=ctx.state.heap[callee[1]];
    require(ctx,definitions.get(fn?.codeId)?.placement==='constructor','ordinary and exotic constructor metadata needs its separate source profile');
    const retained=child.afterInstanceInitialization,receiver=retained?.receiver??child.constructReceiver??child.thisValue,
      newTarget=retained?.newTarget??child.newTarget,id='construction:'+child.id;
    require(ctx,newTarget?.[0]==='ref','constructor newTarget is missing');
    emit(ctx,{kind:'construct.enter',id,child:ctx.frame(child.id),callee:ctx.tag(callee,event),newTarget:ctx.tag(newTarget,event),
      arguments:event.operands.slice(1).map(value=>ctx.tag(value,event)),receiver:ctx.copy(receiver),mode,owner},event);
    if(receiver[0]==='ref')ctx.markPublished(receiver[1]);
    roles.set(child.id,{kind:retained?'base-initializer':'body',id});bindFrame(ctx,event,child);
  }
  function checkFrame(ctx,node){
    require(ctx,!node.handlers?.length&&!node.awaiting&&!node.asyncPromiseId,'exception handler or asynchronous continuation needs its own profile');
    const role=roles.get(node.id);require(ctx,role,'retained constructor frame has no public invocation');
    const expectedFields=role.kind==='body'?new Set(['constructReceiver','newTarget','constructorId','constructKind','thisInitialized','constructorArguments']):
      new Set([role.kind==='static-initializer'?'classStaticResult':role.kind==='base-initializer'?'afterInstanceInitialization':'superInitializedResult']);
    require(ctx,Object.keys(node).every(key=>!specialFrames.has(key)||expectedFields.has(key)),'unexpected retained construction frame fields');
    require(ctx,ctx.controller.frameFunctions.get(ctx.frame(node.id))===ctx.functionCodes.get(node.codeId),'retained callable source identity');
    if(role.kind==='static-initializer'){
      require(ctx,ctx.eq(node.classStaticResult,role.owner)&&ctx.eq(node.thisValue,role.owner),'static initializer owner/receiver');return true;
    }
    const entry=construction(ctx,role.id);require(ctx,entry,'retained construction identity is absent');
    if(role.kind==='base-initializer'){
      const retained=node.afterInstanceInitialization;
      require(ctx,retained&&retained.constructorId===entry.callee[1]&&ctx.eq(retained.newTarget,entry.newTarget)&&
        ctx.eq(retained.receiver,entry.receiver)&&ctx.eq(retained.args.map(token=>token.value),entry.arguments),
        'base initializer target, receiver or retained arguments changed');
      require(ctx,finished(node)||entry.phase==='initialize-base'&&entry.activeChild===ctx.frame(node.id),'base initializer phase');
    }else if(role.kind==='derived-initializer'){
      require(ctx,ctx.eq(node.superInitializedResult,entry.receiver),'derived initializer receiver changed');
      require(ctx,finished(node)||entry.phase==='initialize-derived'&&entry.activeChild===ctx.frame(node.id),'derived initializer phase');
    }else{
      const fn=ctx.controller.heap.get(entry.callee[1]);
      require(ctx,node.constructorId===entry.callee[1]&&node.constructKind===fn.callable.constructorKind&&
        ctx.eq(node.newTarget,entry.newTarget)&&node.thisInitialized===entry.initialized,'constructor target or initialization state changed');
      require(ctx,node.constructKind==='derived'?Array.isArray(node.constructorArguments)&&!Object.hasOwn(node,'constructReceiver'):
        Array.isArray(node.constructReceiver)&&!Object.hasOwn(node,'constructorArguments'),'base/derived retained field distinction');
      if(node.constructorArguments)require(ctx,ctx.eq(node.constructorArguments.map(token=>token.value),entry.arguments),'retained derived arguments changed');
      if(node.constructReceiver)require(ctx,ctx.eq(node.constructReceiver,entry.receiver),'base construction receiver changed');
      require(ctx,entry.bodyInvocation===ctx.frame(node.id),'constructor body invocation differs');
    }
    require(ctx,ctx.eq(node.thisValue,entry.receiver),'retained receiver differs from shared construction state');return true;
  }
  return {id:CONSTRUCTION_SOURCE_PROFILE_V8,
    syntax(node){
      if(['ClassDeclaration','ClassExpression'].includes(node.type)){
        for(const element of node.body.body)if(element.key?.type==='PrivateIdentifier'&&['get','set'].includes(element.kind))
          throw new TypeError('Private accessor source requires its own protocol');
        return true;
      }
      return node.type==='NewExpression';
    },
    functionDefinition(instruction){const definition=definitions.get(instruction.arg.codeId);return definition?.code?{code:definition.code,node:definition.node}:null;},
    heapFields(node){return node.kind==='function'||Object.keys(node).some(key=>heapFields.includes(key))?heapFields:null;},
    frameFields(node){return Object.keys(node).some(key=>specialFrames.has(key))?frameFields:null;},
    allocate(ctx,node,event){
      if(node.kind!=='function')return false;
      require(ctx,!node.lexicalThisFrameId,'lexical constructor arrow context needs its public continuation');
      ctx.baseAllocate(node,event);emit(ctx,{kind:'callable.define',object:node.id,...capability(node)},event);return true;
    },
    event(ctx,event,row){
      const inst=instruction(ctx,event);if(!inst)return false;const op=inst.op;
      if(['CLASS_CREATE','SET_HOME_OBJECT','CLASS_INITIALIZER','CLASS_FINISH','CLASS_CONSTRUCTOR_GUARD','CONSTRUCT',
        'SUPER_CONSTRUCTOR','SUPER_CALL','SUPER_FORWARD_CALL','SUPER_BIND','THIS','NEW_TARGET','PROPERTY_KEY',
        'PRIVATE_DEFINE','PRIVATE_GET','PRIVATE_GET_METHOD','PRIVATE_SET','PRIVATE_HAS','PRIVATE_UPDATE'].includes(op))
        require(ctx,event.completion?.type!=='throw','guest abrupt construction/private operation requires its own public record');
      if(op==='CLASS_CREATE'){
        const id=event.operands[0]?.[1],node=after(ctx,event,'heap',id),definition=definitions.get(node?.codeId),prototype=node?.properties?.prototype?.value;
        require(ctx,definition?.placement==='constructor'&&prototype?.[0]==='ref','class constructor/prototype identities');
        require(ctx,inst.arg.derived===!!definition.classNode.superClass,'class heritage differs from source');
        defineFunctionProperties(ctx,event,node);
        const protoNode=after(ctx,event,'heap',prototype[1]);ctx.publish(protoNode,event);
        emit(ctx,{kind:'class.link',object:id,prototype,heritage:inst.arg.derived?ctx.tag(event.operands[1],event):U},event);
        const item=classes.get(definition.classNode.start);
        const environment=after(ctx,event,'envs',ctx.state.frames[event.invocationId].envId);
        item.privateNames.forEach((entry,index)=>{
          const privateId='private:'+id+':'+index,binding=environment?.bindings?.['[[private '+entry.name+']]'];
          require(ctx,binding?.initialized&&ctx.eq(binding.token.value,['str',privateId]),'private lexical identity differs from its class declaration');
          emit(ctx,{kind:'private.declare',id:privateId,owner:id,name:entry.name},event);
        });
      }else if(op==='SET_HOME_OBJECT'){
        const node=after(ctx,event,'heap',event.operands[0][1]);defineFunctionProperties(ctx,event,node);
        emit(ctx,{kind:'callable.home',object:node.id,home:ctx.tag(event.operands[1],event)},event);
      }else if(op==='CLASS_INITIALIZER'){
        const owner=ctx.state.heap[event.operands[0][1]],fn=ctx.state.heap[event.operands[1][1]],definition=definitions.get(fn.codeId),
          placement=inst.arg.static?'static':'instance';
        require(ctx,definition?.placement===placement&&definition.classNode===definitions.get(owner.codeId)?.classNode,'initializer source ownership');
        emit(ctx,{kind:'class.initializer',object:owner.id,placement,initializer:ctx.tag(event.operands[1],event)},event);
      }
      else if(op==='CLASS_FINISH'){
        const owner=event.operands[0],child=addedFrame(event),node=ctx.state.heap[owner[1]];
        if(inst.arg.name){
          const environment=after(ctx,event,'envs',ctx.state.frames[event.invocationId].envId),binding=environment?.bindings?.[inst.arg.name];
          require(ctx,binding?.initialized&&ctx.eq(binding.token.value,owner),'class inner name initialization');
          ctx.bind(ctx.cell(environment.id,inst.arg.name),owner,event);
        }
        if(child){
          require(ctx,node.staticInitializer&&ctx.eq(child.classStaticResult,owner),'static initializer invocation');
          emit(ctx,{kind:'call',child:ctx.frame(child.id),callee:ctx.tag(node.staticInitializer,event),receiver:ctx.tag(owner,event),arguments:[]},event);
          roles.set(child.id,{kind:'static-initializer',owner:ctx.copy(owner)});bindFrame(ctx,event,child);
        }else require(ctx,!node.staticInitializer,'static initializer call was omitted');
      }else if(op==='CLASS_CONSTRUCTOR_GUARD'){
        const role=roles.get(event.invocationId),entry=role&&construction(ctx,role.id);
        require(ctx,role?.kind==='body'&&entry?.bodyInvocation===ctx.publicInvocation,'class body must be entered by construction');
      }else if(op==='CONSTRUCT')enter(ctx,event);
      else if(op==='SUPER_CONSTRUCTOR'){
        const role=roles.get(event.invocationId);require(ctx,role?.kind==='body','super requires its direct constructor context');
        emit(ctx,{kind:'super.select',owner:role.id,callee:ctx.tag(event.result,event)},event);
      }else if(op==='SUPER_CALL'||op==='SUPER_FORWARD_CALL'){
        const role=roles.get(event.invocationId);require(ctx,role?.kind==='body','super requires its direct constructor context');
        if(op==='SUPER_FORWARD_CALL')emit(ctx,{kind:'super.select',owner:role.id,callee:ctx.tag(event.operands[0],event)},event);
        enter(ctx,event,{mode:'super',owner:role.id});
      }else if(op==='SUPER_BIND'){
        const role=roles.get(event.invocationId),child=addedFrame(event);require(ctx,role?.kind==='body','super binding owner');
        emit(ctx,{kind:'super.bind',owner:role.id,receiver:ctx.tag(event.operands[0],event),child:child?ctx.frame(child.id):null},event);
        if(child){roles.set(child.id,{kind:'derived-initializer',id:role.id});bindFrame(ctx,event,child);}
      }else if(op==='THIS'||op==='NEW_TARGET')emit(ctx,{kind:op==='THIS'?'construct.this':'construct.target',invocation:ctx.publicInvocation,result:ctx.tag(event.result,event)},event);
      else if(op==='PROPERTY_KEY'){
        const key=ctx.key(event.operands[0]);require(ctx,ctx.eq(key,event.result),'primitive property key conversion');
        emit(ctx,{kind:'compute',expr:literal(key),result:ctx.tag(event.result,event),bind:null},event);
      }else if(op.startsWith('PRIVATE_')){
        const object=event.operands[0],privateId=privateIdentity(ctx,event,inst.arg.name);
        require(ctx,object?.[0]==='ref','private receiver must be an ordinary public reference');
        if(op==='PRIVATE_DEFINE')emit(ctx,{kind:'private.define',object:object[1],privateId,elementKind:inst.arg.kind,value:ctx.tag(event.operands[1],event)},event);
        else if(op==='PRIVATE_SET')emit(ctx,{kind:'private.set',object:object[1],privateId,value:ctx.tag(event.operands[1],event)},event);
        else if(op==='PRIVATE_HAS')emit(ctx,{kind:'private.has',object:object[1],privateId,result:event.result[1]},event);
        else if(op==='PRIVATE_GET'||op==='PRIVATE_GET_METHOD')emit(ctx,{kind:'private.get',object:object[1],privateId,
          result:ctx.tag(event.result[0]==='method'?event.result[1]:event.result,event)},event);
        else{
          const old=ctx.state.heap[object[1]]?.privateSlots?.[privateId]?.value,
            next=after(ctx,event,'heap',object[1])?.privateSlots?.[privateId]?.value;
          require(ctx,old&&['undefined','null','bool','str','num','bigint'].includes(old[0]),'private update object conversion requires its public operation');
          emit(ctx,{kind:'private.get',object:object[1],privateId,result:ctx.tag(old,event)},event);
          const numeric=old[0]==='bigint'?old:encode(Number(decode(old)));
          if(old[0]!=='bigint')emit(ctx,{kind:'compute',expr:{op:'unary',operator:'+',arg:literal(old)},result:numeric,bind:null},event);
          emit(ctx,{kind:'compute',expr:{op:'binary',operator:inst.arg.operator==='++'?'+':'-',left:literal(numeric),
            right:literal(old[0]==='bigint'?['bigint','1']:['num',1])},result:ctx.tag(next,event),bind:null},event);
          emit(ctx,{kind:'private.set',object:object[1],privateId,value:ctx.tag(next,event)},event);
          require(ctx,ctx.eq(event.result,inst.arg.prefix?next:numeric),'private update expression completion');
        }
      }else if(op==='DEFINE_LITERAL_PROP'){
        const object=event.operands[0],node=after(ctx,event,'heap',object[1]);
        require(ctx,node.kind!=='array','ArraySetLength descriptor protocol is separate');
        if(inst.arg.kind==='prototype')emit(ctx,{kind:'property.prototype',object:object[1],prototype:ctx.prototype(node),success:true},event);
        else{
          const key=ctx.key(event.operands[1]),storage=key[0]==='str'?stringPropertyKey(key[1]):symbolPropertyKey(key[1]);
          emit(ctx,{kind:'property.define',object:object[1],key,descriptor:ctx.descriptor(node,storage),success:true},event);
        }
      }else if(op.startsWith('SUPER_'))ctx.refuse('construction: super property references require their own public record');
      else return false;
      bindWrites(ctx,event,row);return true;
    },
    completeFrame(ctx,change,event){
      const role=roles.get(change.id);if(!role)return false;
      const completion=change.after.completion,invocation=ctx.frame(change.id),value=completion?.value?.value,
        kind=completion?.type==='throw'?'throw':'return';
      require(ctx,scalar(value)&&ctx.publicInvocation===invocation,'constructor completion invocation/value');
      if(role.kind!=='body')require(ctx,kind==='throw'||value[0]==='undefined','initializer must return undefined or throw');
      emit(ctx,{kind,invocation,value:ctx.tag(value,event)},event);
      if(role.kind==='base-initializer'){
        if(kind==='throw')emit(ctx,{kind:'construct.finish',id:role.id,completion:{kind:'throw',value:ctx.tag(value,event)}},event);
        else{
          const child=addedFrame(event);require(ctx,child?.constructorId===construction(ctx,role.id).callee[1],'base initializer must enter its retained constructor body');
          emit(ctx,{kind:'construct.body',id:role.id,child:ctx.frame(child.id)},event);
          roles.set(child.id,{kind:'body',id:role.id});bindFrame(ctx,event,child);
        }
      }else if(role.kind==='derived-initializer')emit(ctx,{kind:'super.finish',owner:role.id,
        completion:{kind:kind==='throw'?'throw':'normal',value:ctx.tag(kind==='throw'?value:change.after.superInitializedResult,event)}},event);
      else if(role.kind==='body'){
        const parent=after(ctx,event,'frames',change.after.callerFrameId),delivered=kind==='throw'?value:parent?.stack.at(-1)?.value;
        require(ctx,scalar(delivered),'constructor completion delivered no owned result');
        emit(ctx,{kind:'construct.finish',id:role.id,completion:{kind:kind==='throw'?'throw':'normal',value:ctx.tag(delivered,event)}},event);
      }
      return true;
    },
    checkHeap(ctx,node){
      const publicNode=ctx.controller.heap.get(node.id);require(ctx,publicNode,'missing shared construction heap node');
      const described=describeConstructionObjectV8(publicNode);
      if(node.kind==='function'){
        const expected={...capability(node),homeObject:node.homeObject??null,instanceInitializer:node.instanceInitializer??null,staticInitializer:node.staticInitializer??null};
        require(ctx,ctx.eq(described.callable,expected),'callable capability, home or initializer state differs');
        if(Object.hasOwn(node,'classConstructor'))require(ctx,node.classConstructor===expected.classConstructor,'owned class capability differs from source');
        if(expected.classConstructor&&node.homeObject)require(ctx,node.classConstructor===true&&node.prototypeInitialized===true,
          'linked class constructor metadata is incomplete');
        if(node.prototypeInitialized)require(ctx,expected.classConstructor&&node.properties?.prototype?.value?.[0]==='ref','initialized function prototype requires the declared class profile');
        if(Object.hasOwn(node,'derivedConstructor')||node.classConstructor&&expected.constructorKind==='derived')
          require(ctx,node.derivedConstructor===true&&expected.classConstructor&&expected.constructorKind==='derived','derived constructor metadata disagrees with source');
      }
      const privateKeys=Object.keys(node.privateSlots??{}),kinds=Object.keys(node.privateKinds??{}),versions=Object.keys(node.privateVersions??{});
      require(ctx,ctx.eq(privateKeys.slice().sort(),kinds.slice().sort())&&ctx.eq(privateKeys.slice().sort(),versions.slice().sort()),'private metadata key sets differ');
      const expectedPrivate=privateKeys.map(id=>({id,kind:node.privateKinds[id],value:node.privateSlots[id].value,version:node.privateVersions[id]}));
      require(ctx,ctx.eq(described.privateElements??[],expectedPrivate),'private brands, values or versions differ');return true;
    },
    checkFrame
  };
}
