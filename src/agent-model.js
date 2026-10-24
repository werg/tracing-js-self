// Deterministic virtual Int32 Atomics across scripted agents.
// This is not a worker runtime or a native SharedArrayBuffer implementation.
import {isDeepStrictEqual, types} from 'node:util';
const ops=new Set(['load','store','add','sub','and','or','xor','exchange','compareExchange','wait','notify']);
function ownData(x,depth=0) {
  if(depth>12)throw new TypeError('Agent nesting limit');
  if(x===null||typeof x==='string'||typeof x==='boolean')return x;
  if(typeof x==='number'&&Number.isFinite(x))return x;
  if(!x||typeof x!=='object'||types.isProxy(x))throw new TypeError('Expected plain agent data');
  if(Array.isArray(x)){
    if(x.length>2048||Reflect.ownKeys(x).some(k=>typeof k==='symbol'))
      throw new TypeError('Invalid agent array');
    return Array.from({length:x.length},(_,i)=>{
      const d=Object.getOwnPropertyDescriptor(x,i);
      if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Sparse or accessor agent data');
      return ownData(d.value,depth+1);
    });
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(x)))
    throw new TypeError('Expected plain agent records');
  const o=Object.create(null);
  for(const key of Reflect.ownKeys(x)){
    const d=Object.getOwnPropertyDescriptor(x,key);
    if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||
       !d||!Object.hasOwn(d,'value'))throw new TypeError('Unsafe agent field');
    o[key]=ownData(d.value,depth+1);
  }
  return o;
}
const idOk=s=>typeof s==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s);
const int=n=>Number.isSafeInteger(n);
function prepare(description){
  const input=ownData(description);
  if(!Array.isArray(input?.buffers)||!Array.isArray(input?.agents)||
     input.buffers.length<1||input.buffers.length>4||
     input.agents.length<1||input.agents.length>8)
    throw new TypeError('Expected 1-4 buffers and 1-8 agents');
  const buffers=new Map(),agents=new Map();let steps=0;
  for(const b of input.buffers){
    if(!idOk(b.id)||buffers.has(b.id)||!int(b.length)||b.length<1||b.length>64||
       (b.initial!==undefined&&(!Array.isArray(b.initial)||b.initial.length!==b.length)))
      throw new TypeError('Invalid Int32 shared buffer declaration');
    const initial=b.initial??Array(b.length).fill(0);
    if(initial.some(n=>!int(n)))throw new TypeError('Invalid Int32 initial value');
    buffers.set(b.id,initial.map(n=>n|0));
  }
  for(const a of input.agents){
    if(!idOk(a.id)||agents.has(a.id)||!Array.isArray(a.steps))
      throw new TypeError('Invalid virtual agent');
    steps+=a.steps.length;
    for(const step of a.steps){
      const buf=buffers.get(step?.buffer);
      if(!ops.has(step?.op)||!buf||!int(step.index)||step.index<0||step.index>=buf.length)
        throw new TypeError('Invalid owned atomic operation/target');
      for(const field of ['value','expected','replacement','timeout','count'])
        if(step[field]!==undefined&&!int(step[field]))
          throw new TypeError('Atomic integer argument required');
      if((['store','add','sub','and','or','xor','exchange'].includes(step.op)&&step.value===undefined)||
         (['compareExchange','wait'].includes(step.op)&&step.expected===undefined)||
         (step.op==='compareExchange'&&step.replacement===undefined)||
         (step.op==='wait'&&step.timeout!==undefined&&(step.timeout<0||step.timeout>100000))||
         (step.op==='notify'&&step.count!==undefined&&step.count<0))
        throw new TypeError('Invalid atomic arguments');
    }
    agents.set(a.id,{id:a.id,steps:a.steps,pc:0,
      status:a.steps.length?'runnable':'done',lastResult:null,waiting:null});
  }
  if(steps>1024)throw new RangeError('Too many atomic steps');
  if(input.schedule!==undefined&&(!Array.isArray(input.schedule)||
     input.schedule.length>1024||input.schedule.some(id=>!agents.has(id))))
    throw new TypeError('Invalid scheduling prefix');
  return {input,buffers,agents};
}

/** Replays a declared ordering of atomic operations on owned Int32 cells. */
export function executeBoundedAgents(description){
  const {input,buffers,agents}=prepare(description);
  const list=[...agents.values()],queue=new Map(),events=[],schedule=input.schedule??[];
  let clock=0,cursor=0,position=0;
  const emit=e=>events.push({sequence:events.length+1,clock,...e});
  const key=(b,i)=>b+'#'+i;
  function wake(a,result){
    const ids=queue.get(key(a.waiting.buffer,a.waiting.index)),i=ids.indexOf(a.id);
    if(i<0)throw new Error('Corrupt virtual waiter queue');
    ids.splice(i,1);
    if(!ids.length)queue.delete(key(a.waiting.buffer,a.waiting.index));
    a.waiting=null;a.lastResult=result;
    a.status=a.pc===a.steps.length?'done':'runnable';
  }
  while(true){
    if(events.length>=2048)throw new RangeError('Virtual scheduling event limit');
    let agent=null;
    if(position<schedule.length){
      agent=agents.get(schedule[position++]);
      if(agent.status!=='runnable')throw new Error('Scheduled agent not runnable');
    }else{
      for(let n=0;n<list.length;n++){
        const i=(cursor+n)%list.length;
        if(list[i].status==='runnable'){agent=list[i];cursor=(i+1)%list.length;break;}
      }
    }
    if(!agent){
      const deadlines=list.filter(a=>a.status==='waiting'&&a.waiting.until!==null)
        .map(a=>a.waiting.until);
      if(deadlines.length){
        clock=Math.max(clock,Math.min(...deadlines));
        for(const a of list)if(a.status==='waiting'&&
            a.waiting.until!==null&&a.waiting.until<=clock){
          const {buffer,index}=a.waiting;
          wake(a,'timed-out');
          emit({agentId:a.id,op:'wait.timeout',buffer,index,result:'timed-out'});
        }
        continue;
      }
      break;
    }
    const step=agent.steps[agent.pc++],cells=buffers.get(step.buffer);
    const old=cells[step.index],value=(step.value??0)|0;
    let result=old,wakes=[];
    switch(step.op){
      case 'load':break;
      case 'store':cells[step.index]=value;result=value;break;
      case 'add':cells[step.index]=(old+value)|0;break;
      case 'sub':cells[step.index]=(old-value)|0;break;
      case 'and':cells[step.index]=old&value;break;
      case 'or':cells[step.index]=old|value;break;
      case 'xor':cells[step.index]=old^value;break;
      case 'exchange':cells[step.index]=value;break;
      case 'compareExchange':
        if(old===(step.expected|0))cells[step.index]=step.replacement|0;
        break;
      case 'wait':{
        if(old!==(step.expected|0))result='not-equal';
        else if(step.timeout===0)result='timed-out';
        else{
          result='suspended';agent.status='waiting';
          agent.waiting={buffer:step.buffer,index:step.index,
            until:step.timeout===undefined?null:clock+step.timeout};
          const k=key(step.buffer,step.index);
          if(!queue.has(k))queue.set(k,[]);
          queue.get(k).push(agent.id);
        }
        break;
      }
      case 'notify':{
        result=0;const q=queue.get(key(step.buffer,step.index));
        const limit=step.count===undefined?Number.MAX_SAFE_INTEGER:step.count;
        while(q?.length&&result<limit){
          const target=agents.get(q[0]);
          wake(target,'ok');wakes.push(target.id);result++;
        }
        break;
      }
    }
    if(agent.status==='runnable'&&agent.pc===agent.steps.length)agent.status='done';
    agent.lastResult=result;
    emit({agentId:agent.id,pc:agent.pc-1,op:step.op,buffer:step.buffer,
      index:step.index,before:old,after:cells[step.index],result,wakes});
  }
  return JSON.parse(JSON.stringify({schema:'bounded-agents/1',input,events,
    buffers:Object.fromEntries(buffers),
    agents:Object.fromEntries(list.map(a=>[a.id,{pc:a.pc,status:a.status,
      lastResult:a.lastResult,waiting:a.waiting}])),
    virtualTime:clock,status:list.some(a=>a.status==='waiting')?'blocked':'terminated'}));
}

/** Exact input-based transcript verification, not a cross-engine oracle. */
export function verifyBoundedAgents(record){
  const expected=executeBoundedAgents(record?.input);
  if(!isDeepStrictEqual(ownData(record),ownData(expected)))
    throw new Error('Virtual agent transcript diverges from replay');
  return {valid:true,events:expected.events.length};
}
