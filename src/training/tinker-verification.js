import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {prepareTinkerTask, readableMessagesFromJournal, createTinkerSession, encodeReadable, normalizedSourceHash, assistantVisibleText} from './tinker-execution.js';
import {seededRandom, sha256} from './tinker-benchmark.js';
import {independentNativeExecution, independentTranscriptMatches, independentConversationMatches, independentDecode, independentAction} from './tinker-independent.js';

export async function gradeTranscript(prepared, texts) {
  const session=createTinkerSession(prepared);
  let tokens=0;
  try {
    for(const text of texts){const len=typeof text==='string'?text.length:JSON.stringify(text).length;tokens+=Math.max(1,Math.ceil(len/4));const result=await session.step(text,tokens);if(result.done)break;}
    return session.grade(tokens);
  } finally {session.close();}
}

function changeFirst(value, predicate, transform) {
  const clone=structuredClone(value);
  function visit(item,parent,key){
    if(predicate(item,parent,key)){if(parent)parent[key]=transform(item);return true;}
    if(item&&typeof item==='object')for(const name of Object.keys(item))if(visit(item[name],item,name))return true;
    return false;
  }
  return visit(clone,null,null)?clone:null;
}

export function adversarialTranscripts(texts) {
  const actions=texts.map(independentAction),final=actions.at(-1),out=[];
  const add=(name,changed)=>out.push({name,texts:changed.map(a=>typeof a==='string'?a:JSON.stringify(a))});
  const modify=(name,update)=>{const changed=structuredClone(actions);update(changed.at(-1));add(name,changed);};
  modify('wrong-result',a=>{a.value={unexpected:'incorrect-completion'};});
  modify('wrong-completion-kind',a=>{a.kind=a.kind==='return'?'throw':'return';});
  if(final.arguments?.length)modify('wrong-input-mutation',a=>{a.arguments[0]='incorrect-final-input';});
  try {
    const decoded=independentDecode({arguments:final.arguments,value:final.value});
    if(decoded.value&&typeof decoded.value==='object'){
      const encoded=encodeReadable({arguments:decoded.arguments,value:structuredClone(decoded.value)});
      modify('alias-replaced-by-copy',a=>{a.arguments=encoded.arguments;a.value=encoded.value;});
    }
  }catch{}
  const zero=changeFirst(final,x=>x&&typeof x==='object'&&x.$js==='-0',()=>0);
  if(zero)add('negative-zero-conflated',[...actions.slice(0,-1),zero]);
  const sparse=changeFirst(final,x=>x&&typeof x==='object'&&x.$js==='array'&&x.length>Object.keys(x.entries??{}).length,
    x=>{for(let i=0;i<x.length;i++)if(!Object.hasOwn(x.entries,String(i))){x.entries[i]={$js:'undefined'};break;}return x;});
  if(sparse)add('hole-filled-with-undefined',[...actions.slice(0,-1),sparse]);
  const undefinedValue=changeFirst(final,x=>x&&typeof x==='object'&&x.$js==='undefined',()=>null);
  if(undefinedValue)add('undefined-conflated',[...actions.slice(0,-1),undefinedValue]);
  const calls=actions.slice(0,-1);
  if(calls.length){
    add('missing-effect',actions.slice(1));
    add('extra-effect',[calls[0],...actions]);
    const wrongArgs=structuredClone(actions);wrongArgs[0].arguments=['incorrect-external-argument'];add('wrong-call-arguments',wrongArgs);
    const wrongOperation=structuredClone(actions);wrongOperation[0].operation='unsupported.deliberateNegative';add('wrong-call-operation',wrongOperation);
  }
  if(calls.length>1){const swapped=structuredClone(actions);[swapped[0],swapped[1]]=[swapped[1],swapped[0]];add('reordered-effects',swapped);}
  add('incomplete-execution',actions.slice(0,-1));
  return out;
}

export async function verifyTaskBoundary(task,{independent=true,negativeControls=true}={}) {
  const prepared=await prepareTinkerTask(task),messages=readableMessagesFromJournal(prepared.bundle,prepared);
  const assistantMessages=messages.filter(m=>m.role==='assistant');
  const actions=assistantMessages.map(independentAction).map(a=>JSON.stringify(a));
  const original=await gradeTranscript(prepared,assistantMessages),short=await gradeTranscript(prepared,actions);
  const changed=await gradeTranscript(prepared,actions.map(a=>'A different concise derivation.\n```json\n'+a+'\n```'));
  if(!original.success||!short.success||!changed.success)throw Object.assign(Error('Positive teacher/narration control rejected'),{code:'positive-control-rejected'});
  const native=independent?await independentNativeExecution(prepared.task):null;
  if(native&&!independentTranscriptMatches(native,assistantMessages,prepared.task))throw Object.assign(Error('Independent boundary oracle disagrees with admitted teacher'),{code:'independent-boundary-disagreement'});
  if(native&&!independentConversationMatches(native,messages,prepared.task))throw Object.assign(Error('Independent observed values disagree with exported conversation'),{code:'independent-observation-disagreement'});
  const negatives=[],equivalent=[];
  if(negativeControls)for(const control of adversarialTranscripts(actions)){
    // An equal copy of an unaliased object, or swapping identical requests, is
    // semantically equivalent. It is never mislabeled as an observable negative.
    const same=native?independentTranscriptMatches(native,control.texts,prepared.task):
      control.name==='alias-replaced-by-copy'||control.name==='reordered-effects';
    if(same){equivalent.push(control.name);continue;}
    const grade=await gradeTranscript(prepared,control.texts);
    if(grade.success||grade.reward!==0)throw Object.assign(Error('Accepted observable corruption: '+control.name),{code:'accepted-negative-control',control});
    negatives.push(control.name);
  }
  return {id:task.id,sourceHash:prepared.sourceHash,positiveControls:3,negativeControls:negatives,equivalentControls:equivalent,
    independentChecked:!!native,externalCalls:prepared.fixture.calls.length,
    traceCharacters:assistantMessages.reduce((n,m)=>n+assistantVisibleText(m).length+(m.tool_calls?JSON.stringify(m.tool_calls).length:0),0),
    completeKind:prepared.outcome.kind,sourceVerified:true};
}

export function boundedFuzzTask(seed,index) {
  if(!Number.isSafeInteger(index)||index<0)throw TypeError('Invalid fuzz index');
  const random=seededRandom((seed+Math.imul(index+1,2654435761))>>>0),integer=(n=21)=>Math.floor(random()*n)-Math.floor(n/2);
  const xs=Array.from({length:Math.floor(random()*9)},()=>integer()),a=integer(),b=integer()||1,k=index%13+1;
  let source,args,fixture={calls:[]},nativeBindings=[],features=[];
  switch(index%16){
    case 0: source='function run(xs,k){let total=0;for(let i=0;i<xs.length;i++){if(xs[i]>k)total+=xs[i]*'+k+';else total-=xs[i];}return total;}';args=[xs,a];features=['loop','branch','array'];break;
    case 1: source='function run(box,n){box.count+=n;box.last=n;return box;}';args=[{count:a},b];features=['mutation','alias'];break;
    case 2: {const sparse=new Array(k%5+1);sparse[1]=undefined;source='function run(xs,n){xs[2]=n;delete xs[0];return xs;}';args=[sparse,a];features=['sparse','mutation','alias','undefined'];break;}
    case 3: source='function run(box,n){try{if(n<0)throw n;return n*2;}catch(e){return e-1;}finally{box.count++;}}';args=[{count:a},b];features=['exception','finally','mutation'];break;
    case 4: source='async function run(limit){const a=await host.readAsync("first");const b=await host.readAsync(a>limit?"high":"low");host.store("sum",a+b);return a-b;}';args=[k];fixture={calls:[{operation:'demo.readAsync',arguments:['first'],result:a},{operation:'demo.readAsync',arguments:[a>k?'high':'low'],result:b},{operation:'demo.store',arguments:['sum',a+b]}]};features=['external','sequential','branch'];break;
    case 5: source='async function run(n){try{return (await host.readAsync("value"))+n;}catch(e){return [e,n];}}';args=[a];fixture={calls:[{operation:'demo.readAsync',arguments:['value'],result:b,status:index%32<16?'rejected':'fulfilled'}]};features=['external','exception'];break;
    case 6: source='function run(a,b){return [a,1/a,a/b,b%b];}';args=[index%32<16?-0:0,index%3?b:0];features=['exceptional-scalar'];break;
    case 7: {const box={n:a};source='function run(a,b,n){a.n+=n;return [a===b,a,b];}';args=[box,index%32<16?box:{n:a},b];features=['alias','mutation'];break;}
    case 8: source='function run(box,n){box.self=box;box.n+=n;return box;}';args=[{n:a},b];features=['cycle','mutation','alias'];break;
    case 9: source='function run(a,b){return [a/b,a%b,a*b];}';args=[BigInt(a*k),BigInt(b)];features=['bigint'];break;
    case 10: source='function run(text,i){return [text.length,text.charCodeAt(i),text.codePointAt(i),text.charAt(i)];}';args=[['A😀B','éZ','abc',''][Math.floor(index/16)%4]+String(a),Math.floor(random()*6)];features=['string','unicode-codepoints'];break;
    case 11: source='function run(a,b){while(b!==0){const r=a%b;a=b;b=r;}return a;}';args=[Math.abs(a*k),Math.abs(b)];features=['loop','arithmetic'];break;
    case 12: source='function run(xs){let i=0;let j=xs.length-1;while(i<j){const x=xs[i];xs[i]=xs[j];xs[j]=x;i++;j--;}return xs;}';args=[xs];features=['array','mutation','alias'];break;
    case 13: source='function run(n){const v=freshRandom();return v+n;}';args=[a];nativeBindings=[{name:'freshRandom',kind:'synchronous'}];fixture={calls:[{operation:'natlang.callSync',arguments:['freshRandom',undefined,[]],result:random()}]};features=['external','native','fresh-randomness'];break;
    case 14: source='function run(value){const box=Object.create(null);box.value=value;return box;}';args=[{x:a}];features=['null-prototype','object'];break;
    case 15: source='function run(a){if(a<0)throw new TypeError("negative input");return a;}';args=[a];features=['exception','standard-error','branch'];break;
  }
  return {id:'fuzz-'+seed+'-'+index,family:'bounded-fuzz-'+index%16,source,entry:'run',args:encodeReadable(args),
    fixture:{calls:fixture.calls.map(call=>({...call,arguments:encodeReadable(call.arguments),result:encodeReadable(call.result)}))},
    nativeBindings,randomSeed:(seed+index)>>>0,maxSteps:20000,timeoutMs:5000,
    metadata:{sourceOrigin:'bounded-fuzz-generator',features,tier:3,template:'bounded-fuzz-'+index%16,lineage:['bounded-fuzz-'+index%16]}};
}

/** Delta-debug a failure using the caller's exact mismatch predicate. A parse
 * error/refusal is not accepted as a smaller oracle disagreement. */
export async function minimizeCounterexample(task,stillFails,{maxAttempts=40}={}) {
  let current=structuredClone(task),attempts=0,changed=true;
  const tryCandidate=async candidate=>{if(attempts>=maxAttempts||JSON.stringify(candidate).length>=JSON.stringify(current).length)return false;attempts++;try{if(await stillFails(candidate)){current=candidate;return true;}}catch{}return false;};
  while(changed&&attempts<maxAttempts){
    changed=false;
    for(let i=0;i<(current.args??[]).length&&attempts<maxAttempts;i++)for(const simple of (
      typeof current.args[i]==='number'?[0,1]:typeof current.args[i]==='string'?['','a']:
      Array.isArray(current.args[i])?[[],current.args[i].slice(0,1)]:
      current.args[i]&&typeof current.args[i]==='object'&&!current.args[i].$js?[{}]:[])){
      const candidate=structuredClone(current);candidate.args[i]=simple;
      if(JSON.stringify(candidate.args)===JSON.stringify(current.args))continue;
      if(await tryCandidate(candidate)){changed=true;break;}
    }
  }
  try {
    const tree=parse(current.source,{ecmaVersion:'latest'}),fn=tree.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===(current.entry??'run'));
    for(const statement of [...(fn?.body.body??[])].reverse()){
      if(attempts>=maxAttempts)break;
      const candidate={...current,source:current.source.slice(0,statement.start)+current.source.slice(statement.end)};
      if(await tryCandidate(candidate))break; // Offsets belong to this source; reparse on a later invocation.
    }
  } catch {}
  return {task:current,attempts,originalBytes:JSON.stringify(task).length,minimizedBytes:JSON.stringify(current).length};
}

export function failureCategory(error) {
  const text=String(error?.message??error);
  if(error?.code)return error.code;
  if(/Callback fixtures/.test(text))return 'callback-profile';
  if(/Subscription/.test(text))return 'subscription-profile';
  if(/Concurrent|concurrent|Out-of-order/.test(text))return 'concurrent-observation-profile';
  if(/differ|disagree|mismatch/i.test(text))return 'oracle-or-fixture-disagreement';
  if(/time.?out|timed out|maxSteps|step limit/i.test(text))return 'resource-limit';
  if(/fixture|Unregistered|External|operation|observation/i.test(text))return 'observation-profile';
  if(/prototype|accessor|graph|function|symbol|exotic|data/i.test(text))return 'data-profile';
  return 'source-or-runtime-profile';
}

export async function verifyFuzzCase(seed,index) {
  const task=boundedFuzzTask(seed,index);
  try{return {index,taskDigest:sha256(task),ok:true,...await verifyTaskBoundary(task)};}
  catch(error){
    const category=failureCategory(error);
    const minimized=await minimizeCounterexample(task,async candidate=>{
      try{await verifyTaskBoundary(candidate);return false;}catch(e){return failureCategory(e)===category;}
    });
    return {index,taskDigest:sha256(task),ok:false,category,message:String(error.message),control:error.control??null,task,minimized};
  }
}

export function validateFuzzResumeRecord(record,{seed,count}) {
  if(!record||!Number.isSafeInteger(record.index)||record.index<0||record.index>=count||typeof record.ok!=='boolean')
    throw Error('Invalid fuzz record index or verdict');
  const task=boundedFuzzTask(seed,record.index),expected=sha256(task);
  if(record.taskDigest!==expected)throw Error('Fuzz record task digest does not match seed/index/current generator');
  if(!record.ok){
    if(sha256(record.task)!==expected||typeof record.category!=='string'||typeof record.message!=='string'||!record.minimized)
      throw Error('Invalid bound fuzz failure record');
    return record;
  }
  const known=new Set(['wrong-result','wrong-completion-kind','wrong-input-mutation','alias-replaced-by-copy',
    'negative-zero-conflated','hole-filled-with-undefined','undefined-conflated','missing-effect','extra-effect',
    'wrong-call-arguments','wrong-call-operation','reordered-effects','incomplete-execution']);
  const negatives=record.negativeControls,equivalent=record.equivalentControls;
  if(record.id!==task.id||record.sourceHash!==normalizedSourceHash('"use strict";\n'+task.source)||
    record.sourceVerified!==true||record.independentChecked!==true||record.positiveControls!==3||
    !['return','throw'].includes(record.completeKind)||record.externalCalls!==task.fixture.calls.length||
    !Number.isSafeInteger(record.traceCharacters)||record.traceCharacters<=0||
    !Array.isArray(negatives)||new Set(negatives).size!==negatives.length||negatives.some(name=>!known.has(name))||
    ['wrong-result','wrong-completion-kind','wrong-input-mutation','incomplete-execution'].some(name=>!negatives.includes(name))||
    !Array.isArray(equivalent)||new Set(equivalent).size!==equivalent.length||
    equivalent.some(name=>!['alias-replaced-by-copy','reordered-effects'].includes(name)||negatives.includes(name)))
    throw Error('Invalid or incomplete verified fuzz verdict/control schema');
  return record;
}

export function aggregateVerification(records) {
  const counts={};for(const record of records)for(const name of record.negativeControls??[])counts[name]=(counts[name]??0)+1;
  return {schema:'tinker-adversarial-verification/1',cases:records.length,passed:records.filter(r=>r.ok!==false).length,
    failures:records.filter(r=>r.ok===false).length,independentChecks:records.filter(r=>r.independentChecked).length,
    positiveControls:records.reduce((n,r)=>n+(r.positiveControls??0),0),negativeControls:counts,
    uniqueTaskDigests:new Set(records.map(r=>r.taskDigest).filter(Boolean)).size,
    actualModelSamples:0,scope:'bounded data graphs and sequential demo/platform/native observations; not arbitrary JavaScript'};
}
