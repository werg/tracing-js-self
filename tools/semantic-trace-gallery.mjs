// node tools/semantic-trace-gallery.mjs --out <directory> [--case <id> ...]
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
import {SEMANTIC_GALLERY_FIXTURES,buildSemanticTraceGallery,
  compareSemanticGalleryToV5,renderSemanticTraceGallery} from '../src/training/semantic-trace-gallery.js';

const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
let out=null,tokenizer=null,tokenizerJson=null,consumerRoot=null,python='python3',compact=false;
let baselinePath=resolve(repository,'docs/evidence/semantic-target-gallery-v1/control/gallery.json');
const selected=[];
for(let index=2;index<process.argv.length;index++){
  const argument=process.argv[index];
  const value=()=>{const next=process.argv[++index];if(!next||next.startsWith('--'))throw Error('Missing value for '+argument);return next;};
  if(argument==='--out')out=resolve(value());
  else if(argument==='--case')selected.push(value());
  else if(argument==='--tokenizer-module')tokenizer=await import(pathToFileURL(resolve(value())).href);
  else if(argument==='--tokenizer-json')tokenizerJson=resolve(value());
  else if(argument==='--consumer-root')consumerRoot=resolve(value());
  else if(argument==='--python')python=value();
  else if(argument==='--baseline-gallery')baselinePath=resolve(value());
  else if(argument==='--local-state-compaction')compact=true;
  else throw Error('Unknown option '+argument);
}
if(!out)throw Error('Usage: node tools/semantic-trace-gallery.mjs --out <directory> [--case <id>] [--tokenizer-module <pinned-adapter.mjs> | --tokenizer-json <file> --consumer-root <megatoken>] [--baseline-gallery <v5-gallery.json>]');
if(tokenizer&&tokenizerJson)throw Error('Choose one pinned tokenizer source');
if((tokenizerJson===null)!==(consumerRoot===null))throw Error('--tokenizer-json and --consumer-root must be supplied together');
const fixtures=selected.length?selected.map(id=>{
  const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id===id);
  if(!fixture)throw Error('Unknown gallery fixture '+id);return fixture;
}):SEMANTIC_GALLERY_FIXTURES;
const gallery=await buildSemanticTraceGallery({fixtures,tokenizer,
  projectionOptions:compact?{localStateCompaction:true}:{}});
const baseline=JSON.parse(await readFile(baselinePath,'utf8'));
const targets=cases=>cases.map(row=>({id:row.id,targets:row.records
  .filter(record=>record.targetMask==='generated').map(record=>record.raw)}));
let v5TokenCounts=null;
if(tokenizerJson){
  const script=join(repository,'tools/tokenize-semantic-gallery.py');
  const run=spawnSync(python,[script,'--consumer-root',consumerRoot,'--tokenizer-json',tokenizerJson],{
    input:JSON.stringify({current:targets(gallery.cases),v5:targets(baseline.cases)}),
    encoding:'utf8',maxBuffer:32*1024*1024,timeout:180000,
  });
  if(run.error)throw run.error;
  if(run.status!==0)throw new Error('Pinned production tokenizer batch failed: '+run.stderr.slice(-4000));
  const measured=JSON.parse(run.stdout);
  const attach=(cases,counts)=>{
    const byId=new Map(counts.map(row=>[row.id,row]));
    for(const item of cases){
      const row=byId.get(item.id),records=item.records.filter(record=>record.targetMask==='generated');
      if(!row||row.tokenCounts.length!==records.length)throw new Error('Tokenizer result does not match case '+item.id);
      records.forEach((record,index)=>{record.tokenCount=row.tokenCounts[index];});
      item.metrics.generatedTokens=row.generatedTokens;
      item.tokenization={status:'measured',identity:measured.identity,
        scope:'Exact raw target lines encoded independently; excludes native transport and recurrent context.'};
    }
  };
  attach(gallery.cases,measured.current);
  v5TokenCounts=Object.fromEntries(measured.v5.map(row=>[row.id,row.generatedTokens]));
  gallery.tokenization={status:'measured',identity:measured.identity,
    scope:'Exact raw current and archived-v5 lines encoded independently with the pinned production codec.'};
  gallery.totals.generatedTokens=gallery.cases.reduce((total,row)=>total+row.metrics.generatedTokens,0);
}else if(tokenizer){
  const countBaseline=async()=>{
    const result={};
    for(const row of baseline.cases){
      let count=0;
      for(const record of row.records.filter(item=>item.targetMask==='generated')){
        const ids=await tokenizer.encode(record.raw);
        if(!Array.isArray(ids)||!ids.every(Number.isSafeInteger)||
           await tokenizer.decode(ids)!==record.raw)
          throw new Error('Tokenizer changes archived v5 target bytes');
        count+=ids.length;
      }
      result[row.id]=count;
    }
    return result;
  };
  v5TokenCounts=await countBaseline();
}
gallery.v5BaselineComparison=compareSemanticGalleryToV5(gallery,baseline,{v5TokenCounts});
await mkdir(out,{recursive:true});
await writeFile(join(out,'gallery.json'),JSON.stringify(gallery,null,2)+'\n');
await writeFile(join(out,'gallery.md'),renderSemanticTraceGallery(gallery));
console.log(JSON.stringify({schema:gallery.schema,out,...gallery.totals,
  archivedV5Comparison:gallery.v5BaselineComparison.totals,categories:gallery.categories}));
