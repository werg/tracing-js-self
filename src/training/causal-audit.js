// Public-only causal-order audit. Does not consult private archive or oracle.
// Proves declared dependency availability, NOT complete implicit data flow.
import {isDeepStrictEqual} from 'node:util';
import {decodeRecord,restoreLines} from './format.js';
import {verifyVisibleExport} from './visibility.js';
import {validatePublishedGraph} from './public-graph.js';
const generatedKinds=new Set(['enter','value','branch','loop','carry','alloc','read','write',
  'delete','call','return','throw','end']);
const allowedSemanticFields=new Set(['id','invocation','site','dependsOn','control',
  'result','update','reads','writes','test','path','from','to','copies','reason',
  'child','code','receiver','arguments','captures',
  'allocations','destination','effect','operation','promise','codec',
  'signature','payload','entry','kind','rest']);
const exactKeys=(value,names)=>value!==null&&typeof value==='object'&&
  !Array.isArray(value)&&Object.keys(value).length===names.length&&
  names.every(name=>Object.hasOwn(value,name));
export function auditPublicCausality(episode,{maxBytes=512}={}) {
  verifyVisibleExport({public:episode});
  if(!Number.isSafeInteger(maxBytes)||maxBytes<64||maxBytes>1024)
    throw new RangeError('Invalid causal audit limit');
  const producers=new Set(),codes=new Set(),sites=new Set();
  // The bounded synchronous profile runs one invocation stack. An announced
  // child must enter before further execution; no unentered frame may emit
  // events, and the terminal marker must follow the root's actual return.
  const entered=new Set(),frames=[];
  let pendingEnter=null,rootReturned=false;
  let stage=0,source=null,input=null,root=null,ended=false,open=null,logical=0,generated=0;
  function accept(kind,fields,mode,track) {
    logical++;
    if(stage===0) {
      if(mode!=='observed'||track!=='t0'||kind!=='code'||
         !exactKeys(fields,['sourceId','text','codes','sites','staticFunctions'])||
         typeof fields.sourceId!=='string'||typeof fields.text!=='string'||
         !Array.isArray(fields.codes)||!Array.isArray(fields.sites)||
         !Array.isArray(fields.staticFunctions))
        throw new Error('First visible record must be an observed source bundle');
      source=fields;
      for(const code of fields.codes) {
        if(!exactKeys(code,['id','params','async','restIndex'])||
           !Number.isInteger(code.restIndex)||code.restIndex<-1||
           code.restIndex>=code.params.length||
           !Array.isArray(code.params)||typeof code.async!=='boolean'||
           typeof code.id!=='string'||codes.has(code.id))
          throw new Error('Duplicate or malformed visible code identity');
        codes.add(code.id);
      }
      for(const site of fields.sites) {
        if(!exactKeys(site,['id','code','start','end'])||
           typeof site.id!=='string'||sites.has(site.id)||!codes.has(site.code))
          throw new Error('Unpublished or duplicate visible source site');
        sites.add(site.id);
      }
      for(const fn of fields.staticFunctions)
        if(!['name','identity','code','captures'].includes(Object.keys(fn)[0]) ||
           Object.keys(fn).some(key=>!['name','identity','code','captures'].includes(key)) ||
           typeof fn.name!=='string'||typeof fn.identity!=='string'||!codes.has(fn.code))
          throw new Error('Unexpected static function context payload');
      stage=1;return;
    }
    if(stage===1){
      if(mode!=='observed'||track!=='t0'||kind!=='value'||
         !exactKeys(fields,['entry','invocation','graph'])||
         !exactKeys(fields.graph,['roots','objects'])||
         typeof fields.entry!=='string'||!Array.isArray(fields.graph.roots)||
         !Array.isArray(fields.graph.objects))
        throw new Error('Second visible record must be an observed input graph');
      for(const obj of fields.graph.objects) {
        if(!exactKeys(obj,['id','kind','shapeVersion','properties'])||
           !['object','array'].includes(obj.kind)||!Array.isArray(obj.properties))
          throw new Error('Unexpected input graph object payload');
        for(const property of obj.properties)
          if(!exactKeys(property,['key','value','version']))
            throw new Error('Unexpected input graph property payload');
      }
      validatePublishedGraph(fields.graph);
      input=fields;stage=2;return;
    }
    if(ended)throw new Error('Records after terminal end');
    if(mode!=='generated'||!generatedKinds.has(kind))
      throw new Error('Unjustified observed or unsupported event');
    generated++;
    if(Object.keys(fields).some(key=>!allowedSemanticFields.has(key)))
      throw new Error('Unrecognized generated semantic payload field');
    if(root===null){
      if(kind!=='enter'||track!=='t0'||fields.entry!==input.entry||
         typeof fields.invocation!=='string'||fields.invocation!==input.invocation||
         !isDeepStrictEqual(fields.arguments,input.graph.roots))
        throw new Error('Root entered without published source/input');
      root=fields.invocation;
      entered.add(root);frames.push(root);
    }else if(kind==='enter'){
      if(!pendingEnter||fields.invocation!==pendingEnter.child||
         fields.code!==pendingEnter.code||entered.has(fields.invocation)||
         !isDeepStrictEqual(fields.receiver,pendingEnter.receiver)||
         !isDeepStrictEqual(fields.arguments,pendingEnter.arguments)||
         !isDeepStrictEqual(fields.captures,pendingEnter.captures)||
         !isDeepStrictEqual(fields.dependsOn,[pendingEnter.id]))
        throw new Error('Unjustified child invocation entry');
      entered.add(fields.invocation);frames.push(fields.invocation);
      pendingEnter=null;
    }else{
      if(pendingEnter)throw new Error('Call child not entered before later events');
      if(kind!=='end'&&fields.invocation!==frames.at(-1))
        throw new Error('Event outside active invocation');
    }
    if(fields.site!==undefined&&fields.site!==null&&!sites.has(fields.site))
      throw new Error('Unpublished source site');
    if(kind==='enter'&&!codes.has(fields.code))
      throw new Error('Unpublished entered code');
    if(kind==='call'&&fields.child&&!codes.has(fields.code))
      throw new Error('Unpublished called code');
    if(fields.dependsOn!==undefined&&!Array.isArray(fields.dependsOn))
      throw new Error('Non-array dependencies');
    const deps=[...(fields.dependsOn??[])];
    if(fields.control!==undefined&&fields.control!==null)deps.push(fields.control);
    if(fields.reads!==undefined&&!Array.isArray(fields.reads))
      throw new Error('Non-array read observations');
    for(const read of fields.reads??[])
      if(read.supplyingSemantic!==undefined&&read.supplyingSemantic!==null)
        deps.push(read.supplyingSemantic);
    for(const dep of deps)
      if(!producers.has(dep))throw new Error('Future or unpublished dependency '+dep);
    if(fields.id!==undefined){
      if(fields.id!=='e'+(producers.size+1)||producers.has(fields.id))
        throw new Error('Nonchronological or duplicate semantic identity');
      producers.add(fields.id);
    }
    if(kind==='call'&&fields.child){
      if(typeof fields.child!=='string'||entered.has(fields.child)||
         !fields.id||!Array.isArray(fields.arguments))
        throw new Error('Invalid declared child invocation');
      pendingEnter={id:fields.id,child:fields.child,code:fields.code,
        arguments:fields.arguments,receiver:fields.receiver,captures:fields.captures};
    }
    if(kind==='return'){
      const caller=frames.at(-2)??null;
      if((fields.destination??null)!==caller)
        throw new Error('Return destination disagrees with invocation stack');
      if(fields.invocation===root)rootReturned=true;
      frames.pop();
    }
    if(kind==='end'){
      if(fields.invocation!==root||fields.kind!=='return'||
         !rootReturned||frames.length!==0||pendingEnter)
        throw new Error('Terminal record lacks completed root return');
      ended=true;
    }
  }
  let physicalGenerated=0;
  for(const [i,group] of episode.groups.entries()){
    if(group.id!=='m'+(i+1)||!['observed','generated'].includes(group.mode)||
       group.loss!==(group.mode==='generated'?'semantic':'none')||
       !Array.isArray(group.events)||group.events.length!==1||
       !exactKeys(group,['id','mode','loss','events'])||
       !exactKeys(group.events[0],['track','record']))
      throw new Error('Invalid public group mode, identity, loss or cardinality');
    const {track,record}=group.events[0];
    if(!/^t[0-7]$/.test(track)||typeof record!=='string'||
       Buffer.byteLength(record,'utf8')>maxBytes)
      throw new Error('Invalid track or physical record budget');
    if(group.mode==='generated')physicalGenerated++;
    const {kind,fields}=decodeRecord(record);
    if(open){
      if(group.mode!==open.mode||track!==open.track||fields.id!==open.id)
        throw new Error('Fragment crossed a visibility or lane boundary');
      open.parts.push(record);
      if(kind==='value-close'){
        const [joined]=restoreLines(open.parts);
        const full=decodeRecord(joined);
        if(['value-open','value-part','value-close'].includes(full.kind))
          throw new Error('Nested fragment');
        accept(full.kind,full.fields,open.mode,open.track);open=null;
      }else if(kind!=='value-part'||typeof fields.data!=='string'||!fields.data.length)
        throw new Error('Interrupted semantic fragment');
    }else if(kind==='value-open'){
      if(typeof fields.id!=='string'||!fields.id||fields.type!=='semantic-record')
        throw new Error('Invalid fragment opening');
      open={id:fields.id,mode:group.mode,track,parts:[record]};
    }else if(kind==='value-part'||kind==='value-close')
      throw new Error('Orphaned fragment');
    else accept(kind,fields,group.mode,track);
  }
  if(open)throw new Error('Incomplete fragment');
  if(stage!==2||!ended)throw new Error('No complete observed context and terminal record');
  return {valid:true,logicalRecords:logical,semanticEvents:producers.size,
    generatedRecords:generated,physicalGenerated};
}
