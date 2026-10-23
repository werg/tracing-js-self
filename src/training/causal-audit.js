// Public-only causal-order audit. Does not consult private archive or oracle.
// Proves declared dependency availability, NOT complete implicit data flow.
import {isDeepStrictEqual} from 'node:util';
import {decodeRecord,restoreLines} from './format.js';
import {verifyVisibleExport} from './visibility.js';
const generatedKinds=new Set(['enter','value','branch','loop','alloc','read','write',
  'delete','call','return','throw','end']);
export function auditPublicCausality(episode,{maxBytes=512}={}) {
  verifyVisibleExport({public:episode});
  if(!Number.isSafeInteger(maxBytes)||maxBytes<64||maxBytes>1024)
    throw new RangeError('Invalid causal audit limit');
  const producers=new Set(),codes=new Set(),sites=new Set();
  let stage=0,source=null,input=null,root=null,ended=false,open=null,logical=0,generated=0;
  function accept(kind,fields,mode,track) {
    logical++;
    if(stage===0) {
      if(mode!=='observed'||track!=='t0'||kind!=='code'||
         typeof fields.text!=='string'||!Array.isArray(fields.codes)||
         !Array.isArray(fields.sites))
        throw new Error('First visible record must be an observed source bundle');
      source=fields;
      for(const code of fields.codes) {
        if(typeof code.id!=='string'||codes.has(code.id))
          throw new Error('Duplicate or malformed visible code identity');
        codes.add(code.id);
      }
      for(const site of fields.sites) {
        if(typeof site.id!=='string'||sites.has(site.id)||!codes.has(site.code))
          throw new Error('Unpublished or duplicate visible source site');
        sites.add(site.id);
      }
      stage=1;return;
    }
    if(stage===1){
      if(mode!=='observed'||track!=='t0'||kind!=='value'||
         typeof fields.entry!=='string'||!Array.isArray(fields.graph?.roots))
        throw new Error('Second visible record must be an observed input graph');
      input=fields;stage=2;return;
    }
    if(ended)throw new Error('Records after terminal end');
    if(mode!=='generated'||!generatedKinds.has(kind))
      throw new Error('Unjustified observed or unsupported event');
    generated++;
    if(root===null){
      if(kind!=='enter'||track!=='t0'||fields.entry!==input.entry||
         !isDeepStrictEqual(fields.arguments,input.graph.roots))
        throw new Error('Root entered without published source/input');
      root=fields.invocation;
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
    if(kind==='end'){
      if(fields.invocation!==root||fields.kind!=='return')
        throw new Error('Terminal record contradicts root return');
      ended=true;
    }
  }
  let physicalGenerated=0;
  for(const [i,group] of episode.groups.entries()){
    if(group.id!=='m'+(i+1)||!['observed','generated'].includes(group.mode)||
       group.loss!==(group.mode==='generated'?'semantic':'none')||
       !Array.isArray(group.events)||group.events.length!==1)
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
