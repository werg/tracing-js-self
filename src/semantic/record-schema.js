// Version-neutral typed semantic records. This module has no wire codec,
// harness, source interpreter, or representation-version dependency.
export const COMPLETION_POLICIES=Object.freeze([
  'call-return','await-returned-promise','owned-quiescence'
]);
export function canonicalCompletionPolicy(policy){
  if(!COMPLETION_POLICIES.includes(policy))throw new TypeError('Invalid completion policy');
  return policy;
}

const schema=Object.freeze({
  code:['entry','source','sites','randomSeed'],
  input:['graph','retained'],
  compute:['expr','result','bind','invocation','site'],
  choose:['expr','decision','path','invocation','site'],
  allocate:['name','kind','length','properties','code','captures','invocation'],
  read:['object','key','value','present','invocation'],
  write:['object','key','value','present','invocation'],
  bind:['name','value','from','invocation'],
  call:['child','callee','receiver','arguments','invocation'],
  transfer:['kind','value','handler','invocation'],
  return:['value','invocation'],
  throw:['value','invocation'],
  request:['effect','operation','arguments','invocation','site','payload','promise'],
  observe:['effect','result','status','graph'],
  job:['action','job','owner','result','closure'],
  promise:['action','promise','value','target','job','reaction','closure','rejectionClosure','invocation'],
  await:['promise','continuation','invocation','returnPromise'],
  resume:['continuation','invocation','result','status'],
  end:['kind'],
  summarize:['entry','arguments','result','profile','decisions','iterations','accumulator','invocation'],
  'value-open':['id','type'],
  'value-part':['id','data'],
  'value-close':['id']
});
export const SEMANTIC_RECORD_KINDS=Object.freeze(Object.keys(schema));
export const SEMANTIC_RECORD_SCHEMA=Object.freeze(Object.fromEntries(
  Object.entries(schema).map(([kind,fields])=>[kind,Object.freeze([...fields])])));
export const SEMANTIC_RECORD_REQUIRED=Object.freeze(Object.fromEntries(Object.entries({
  code:['entry','source','sites'],input:['graph'],compute:['expr','result'],
  choose:['expr','decision','path'],allocate:['name','kind','properties'],
  read:['object','key','value','present'],write:['object','key','value','present'],
  bind:['name','value'],call:['child','callee','receiver','arguments'],
  transfer:['kind','value','handler'],return:['value'],throw:['value'],
  request:['effect','operation','arguments','invocation','site','payload'],observe:['effect','result','status'],
  job:['action','job','owner'],end:['kind'],promise:['action','promise'],
  summarize:['entry','arguments','result','profile'],
  await:['promise','continuation','invocation'],resume:['continuation','invocation','result','status'],
  'value-open':['id','type'],'value-part':['id','data'],'value-close':['id']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const has=(object,key)=>Object.hasOwn(object,key);
const scalarSpecial=new Set(['NaN','-0','+Infinity','-Infinity']);
const decimal=/^(?:0|-?[1-9][0-9]*)$/;
const identity=/^[a-z][a-z0-9]*$/;
// Guest source identifiers use ECMAScript spelling; witness identities do not.
const sourceIdentifier=/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u;
function fail(message){throw new TypeError('Invalid semantic record: '+message);}
function assertSite(site){
  if(!object(site)||Object.keys(site).sort().join(',')!=='end,start'||
     !Number.isSafeInteger(site.start)||Object.is(site.start,-0)||site.start<0||
     !Number.isSafeInteger(site.end)||site.end<=site.start)fail('source site');
}
// Structured observed context and opaque host metadata must survive the JSON
// portion of the wire without dropping fields or silently changing scalars.
function assertJSONData(value,ancestors=new Set(),depth=0){
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return;
  if(typeof value!=='object'||depth>256||ancestors.has(value)||
     (!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))))
    fail('noncanonical structured data');
  ancestors.add(value);
  if(Array.isArray(value)){
    if(Object.keys(value).length!==value.length)fail('noncanonical structured array');
    for(let i=0;i<value.length;i++){
      if(!has(value,i))fail('sparse structured array');
      assertJSONData(value[i],ancestors,depth+1);
    }
  }else for(const child of Object.values(value))assertJSONData(child,ancestors,depth+1);
  ancestors.delete(value);
}
export function assertValue(v){
  if(!Array.isArray(v))fail('untagged value');
  const [tag,arg]=v;
  if(['undefined','null'].includes(tag)&&v.length===1)return v;
  if(v.length!==2)fail('tag arity');
  if(tag==='bool'&&typeof arg==='boolean')return v;
  if(tag==='str'&&typeof arg==='string')return v;
  if(tag==='bigint'&&typeof arg==='string'&&decimal.test(arg))return v;
  if(tag==='num'&&((typeof arg==='number'&&Number.isFinite(arg)&&!Object.is(arg,-0))||
    scalarSpecial.has(arg)))return v;
  if(tag==='ref'&&typeof arg==='string'&&identity.test(arg))return v;
  fail('noncanonical scalar or reference');
}
export function validateExpression(expr,{maxOperators=8}={}){
  let nodes=0,operators=0,operands=0;
  function visit(node){
    if(!object(node)||++nodes>32)fail('expression node budget exceeded');
    if(node.op==='random'&&Object.keys(node).length===1){
      if(node!==expr)fail('random transition requires a standalone computation');
      operators++;return;
    }
    if(node.op==='literal'&&Object.keys(node).length===2){
      assertValue(node.value);operands++;return;
    }
    if(node.op==='local'&&Object.keys(node).length===2&&
       typeof node.name==='string'&&sourceIdentifier.test(node.name)){operands++;return;}
    if(node.op==='read'&&Object.keys(node).length===3 &&
       typeof node.object==='string'&&identity.test(node.object) &&
       typeof node.key==='string'){operands++;return;}
    if(node.op==='unary'&&Object.keys(node).length===3&&
       ['!','+','-','~','typeof','void'].includes(node.operator)){
      operators++;visit(node.arg);return;
    }
    if(node.op==='binary'&&Object.keys(node).length===4&&
       ['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=',
        '&','|','^','<<','>>','>>>'].includes(node.operator)){
      operators++;visit(node.left);visit(node.right);return;
    }
    fail('unknown expression operation or fields');
  }
  visit(expr);
  if(operators>maxOperators)fail('expression operator budget exceeded');
  return {operatorCount:operators,operandCount:operands,nodeCount:nodes};
}
export function validateGraph(graph,{externalReferences=[]}={}){
  if(!object(graph)||Object.keys(graph).sort().join(',')!=='objects,roots'||
     !Array.isArray(graph.roots)||!Array.isArray(graph.objects)||graph.objects.length>256)
    fail('input graph');
  const known=new Set(externalReferences),declared=new Set(),properties={};
  for(const node of graph.objects){
    if(!object(node)||!['array','object'].includes(node.kind)||
       typeof node.id!=='string'||!identity.test(node.id)||declared.has(node.id)||
       !Array.isArray(node.properties)||
       Object.keys(node).some(key=>!['id','kind','prototype','properties'].includes(key))||
       (has(node,'prototype')&&(node.kind!=='object'||node.prototype!==null)))
      fail('input graph identity or prototype');
    known.add(node.id);declared.add(node.id);properties[node.id]=node.properties;
  }
  for(const node of graph.objects){
    const keys=new Set();
    for(const prop of node.properties){
      if(!object(prop)||Object.keys(prop).sort().join(',')!=='key,value'||
         typeof prop.key!=='string'||prop.key==='__proto__'||keys.has(prop.key))
        fail('input property');
      keys.add(prop.key);assertValue(prop.value);
    }
    if(node.kind==='array'){
      const length=node.properties.find(p=>p.key==='length');
      if(!length||length.value?.[0]!=='num'||!Number.isInteger(length.value[1])||
         length.value[1]<0||length.value[1]>4096)fail('array length');
      for(const p of node.properties){
        if(/^(0|[1-9][0-9]*)$/.test(p.key) && Number(p.key)>=length.value[1])
          fail('array index outside length');
      }
    }
  }
  for(const root of [...graph.roots,...graph.objects.flatMap(n=>n.properties.map(p=>p.value))]){
    assertValue(root);
    if(root[0]==='ref'&&!known.has(root[1]))fail('dangling graph reference');
  }
}
export function validateSemanticRecord(kind,fields){
  if(!has(schema,kind)||!object(fields))fail('record kind or payload');
  if(Object.keys(fields).some(key=>!schema[kind].includes(key)||fields[key]===undefined))
    fail('unknown or undefined record field');
  const required=SEMANTIC_RECORD_REQUIRED;
  if(required[kind].some(key=>!has(fields,key)))fail('missing required '+kind+' field');
  if(kind==='input'){
    const retained=fields.retained??[];
    if(!Array.isArray(retained)||new Set(retained).size!==retained.length||
       retained.some(value=>typeof value!=='string'||!identity.test(value)))
      fail('retained graph references');
    validateGraph(fields.graph,{externalReferences:retained});
  }
  if(kind==='code' && (typeof fields.entry!=='string'||
     (!sourceIdentifier.test(fields.entry)&&!/^function:[0-9]+$/.test(fields.entry))||
     typeof fields.source!=='string'||!fields.source.length||!Array.isArray(fields.sites)))
    fail('source context');
  if(kind==='code'&&fields.randomSeed!==undefined&&
     (!Number.isInteger(fields.randomSeed)||Object.is(fields.randomSeed,-0)||fields.randomSeed<0||
      fields.randomSeed>0xffffffff))fail('unsupported deterministic seed');
  if(kind==='code')assertJSONData(fields.sites);
  if(kind==='compute'||kind==='choose'){
    validateExpression(fields.expr);
    assertValue(kind==='compute'?fields.result:fields.decision);
    if(kind==='choose'&&!['then','else','use-left','evaluate-right'].includes(fields.path))
      fail('choice continuation');
  }
  if(['bind','read','write'].includes(kind))assertValue(fields.value);
  if(['return','throw','transfer'].includes(kind))assertValue(fields.value);
  if(kind==='allocate' && (!identity.test(fields.name) ||
      !['array','object','closure','set','regexp'].includes(fields.kind)||!Array.isArray(fields.properties)))
    fail('allocation identity');
  if(kind==='allocate'){
    const keys=new Set();
    for(const property of fields.properties){
      if(!object(property)||Object.keys(property).sort().join(',')!=='key,value'||
         typeof property.key!=='string'||keys.has(property.key))fail('allocation property');
      keys.add(property.key);assertValue(property.value);
    }
    if(has(fields,'length')&&(fields.kind!=='array'||!Number.isSafeInteger(fields.length)||Object.is(fields.length,-0)||
       fields.length<0||fields.length>4096))fail('allocation length');
    if(has(fields,'code')&&(fields.kind!=='closure'||typeof fields.code!=='string'||!fields.code))
      fail('allocation source code');
    if(has(fields,'captures')&&fields.kind!=='closure')fail('captures require a closure');
  }
  if(kind==='allocate'&&fields.kind==='closure'){
    if(!Array.isArray(fields.captures??[]))fail('closure capture contract');
    const bindings=new Set();
    for(const relation of fields.captures??[]){
      if(!object(relation)||Object.keys(relation).sort().join(',')!=='binding,cell'||
         typeof relation.binding!=='string'||!sourceIdentifier.test(relation.binding)||
         typeof relation.cell!=='string'||
         !sourceIdentifier.test(relation.cell)||bindings.has(relation.binding))
        fail('malformed captured cell relation');
      bindings.add(relation.binding);
    }
  }
  if(kind==='bind'&&fields.from!==undefined&&
     (typeof fields.from!=='string'||!sourceIdentifier.test(fields.from)||
      fields.from===fields.name))fail('invalid source cell relation');
  if(kind==='transfer'){
    if(!['return','throw','cleanup'].includes(fields.kind))fail('completion transfer');
    assertJSONData(fields.handler);
  }
  if(kind==='summarize'){
    if(typeof fields.entry!=='string'||!sourceIdentifier.test(fields.entry)||
       !Array.isArray(fields.arguments)||fields.arguments.length>32||
       !['pure-helper/1','pure-control-helper/1','dense-array-sum/1'].includes(fields.profile))
      fail('semantic region');
    for(const value of fields.arguments)assertValue(value);
    assertValue(fields.result);
    const allowed={
      'pure-helper/1':[],
      'pure-control-helper/1':['decisions'],
      'dense-array-sum/1':['iterations','accumulator']
    }[fields.profile];
    for(const field of ['decisions','iterations','accumulator'])
      if(has(fields,field)!==allowed.includes(field))fail('semantic region profile fields');
    if(fields.profile==='pure-control-helper/1'){
      if(!Array.isArray(fields.decisions)||!fields.decisions.length||fields.decisions.length>32)
        fail('semantic region decisions');
      // Calls to the same helper may visit one source span more than once.
      // Preserve the exact execution sequence; source proof checks its truth.
      for(const decision of fields.decisions){
        if(!object(decision)||Object.keys(decision).sort().join(',')!=='selected,site'||
           !['consequent','alternate','left','right'].includes(decision.selected))
          fail('semantic region decision');
        assertSite(decision.site);
      }
    }
    if(fields.profile==='dense-array-sum/1'&&
       (!Number.isSafeInteger(fields.iterations)||Object.is(fields.iterations,-0)||fields.iterations<0||fields.iterations>1024||
        typeof fields.accumulator!=='string'||!sourceIdentifier.test(fields.accumulator)))
      fail('semantic region loop');
  }
  if(kind==='request'){
    const site=fields.site;
    if(typeof fields.operation!=='string'||!fields.operation||
       typeof fields.effect!=='string'||!identity.test(fields.effect)||
       !Array.isArray(fields.arguments)||fields.arguments.length>32||
       !object(site)||Object.keys(site).sort().join(',')!=='end,start'||
       !Number.isSafeInteger(site.start)||site.start<0||
       !Number.isSafeInteger(site.end)||site.end<=site.start||
       typeof fields.payload!=='string'||
       Buffer.byteLength(fields.payload,'utf8')>65536)
      fail('grounded external invocation');
    for(const argument of fields.arguments)assertValue(argument);
    let parsed;
    try {parsed=JSON.parse(fields.payload);}catch{fail('invalid external payload');}
    if((!Array.isArray(parsed)&&parsed?.schema!=='owned-graph/1')||JSON.stringify(parsed)!==fields.payload)
      fail('noncanonical external payload');
  }
  if(kind==='call' && (typeof fields.callee!=='string' ||
      !Array.isArray(fields.arguments)))fail('call arguments or source code');
  if(kind==='call'){
    assertValue(fields.receiver);
    for(const arg of fields.arguments)assertValue(arg);
  }
  if(['read','write'].includes(kind) && (typeof fields.key!=='string'||
      typeof fields.object!=='string'||typeof fields.present!=='boolean'))
    fail('location');
  if(kind==='end'&&!['return','throw'].includes(fields.kind))fail('completion kind');
  if(kind==='observe'){
    assertValue(fields.result);
    if(!['fulfilled','rejected'].includes(fields.status))fail('observation status');
    if(fields.graph!==undefined){
      validateGraph(fields.graph);
      if(fields.graph.roots.length!==1||
         JSON.stringify(fields.graph.roots[0])!==JSON.stringify(fields.result))
        fail('observed result graph root mismatch');
    }
  }
  if(kind==='promise'){
    const action=fields.action;
    if(!['create','resolve','reject','adopt','react'].includes(action))fail('promise action');
    const requiredFields={create:[],resolve:['value'],reject:['value'],
      adopt:['target'],react:['job','reaction']}[action];
    if(requiredFields.some(key=>!has(fields,key)))fail('missing promise action field');
    const allowed=['action','promise','invocation',...requiredFields,
      ...(action==='react'?['closure','rejectionClosure','target']:[])];
    if(Object.keys(fields).some(key=>!allowed.includes(key)))fail('extraneous promise action field');
    if(has(fields,'value'))assertValue(fields.value);
    if(action==='react'&&!['then','catch','finally'].includes(fields.reaction))
      fail('promise reaction');
    if(has(fields,'rejectionClosure')&&fields.reaction!=='then')fail('rejection closure requires then reaction');
  }
  if(kind==='resume'){
    assertValue(fields.result);
    if(!['fulfilled','rejected'].includes(fields.status))fail('resume status');
  }
  if(kind==='job'&&!['enqueue','dispatch','complete'].includes(fields.action))fail('job action');
  if(kind==='job'&&fields.closure!==undefined&&fields.action!=='enqueue')fail('closure belongs to job registration');
  if(kind==='job'&&has(fields,'result'))assertJSONData(fields.result);
  if(kind==='value-open'&&(typeof fields.type!=='string'||!fields.type))fail('fragment type');
  if(kind==='value-part'&&typeof fields.data!=='string')fail('fragment data');
  if(has(fields,'site'))assertSite(fields.site);
  for(const key of ['object','effect','promise','target','continuation','closure','rejectionClosure','returnPromise','job','id']){
    if(has(fields,key)&&(typeof fields[key]!=='string'||!identity.test(fields[key])))
      fail('malformed witness identity '+key);
  }
  for(const key of ['name','bind'])
    if(has(fields,key)&&(typeof fields[key]!=='string'||
       !(kind==='allocate'?identity:sourceIdentifier).test(fields[key])))
      fail('malformed witness binding '+key);
  for(const key of ['invocation','child','owner'])
    if(has(fields,key)&&(typeof fields[key]!=='string'||
       !/^[a-z][a-z0-9:_-]*$/.test(fields[key])))fail('malformed invocation identity');
  return true;
}
