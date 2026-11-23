#!/usr/bin/env node
// Retain every selected attempt without duplicating the deterministic full
// inventory and unselected ledger. Run from the producer checkout being used.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {basename,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const flags=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const name=process.argv[index],value=process.argv[index+1];
  if(!['--report','--out'].includes(name)||!value||flags.has(name))
    throw new TypeError('Usage: node retain-test262-campaign.mjs --report full-report.json.gz --out directory');
  flags.set(name,value);
}
if(flags.size!==2)throw new TypeError('--report and --out are required');
const {readTest262Json,validateOriginalTest262Report}=await import(
  pathToFileURL(resolve('src/conformance/test262-campaign.js')));
const {bindTest262CatalogProfile}=await import(pathToFileURL(resolve('src/conformance/test262-catalog.js')));
const report=readTest262Json(flags.get('--report'));
validateOriginalTest262Report(report);
const catalog=report.baseCatalog,executionCatalog=bindTest262CatalogProfile(catalog,report.profile);
const selected=new Set(report.campaign.selectedIds),rows=report.campaign.rows.filter(row=>row.selected);
if(rows.length!==selected.size||rows.some(row=>!selected.has(row.id)))
  throw new TypeError('Selected ledger does not match selection');
for(const row of report.campaign.rows.filter(row=>!row.selected))
  if(row.attempts.length||Object.values(row.stages).some(stage=>stage.status!=='not_selected'))
    throw new TypeError('Cannot omit nontrivial unselected evidence');
const variants=executionCatalog.variants.filter(row=>selected.has(row.id));
const requiredPaths=new Set(variants.flatMap(row=>[row.path,...row.harness.map(file=>file.path),
  ...(row.dependencies?.files??[]).map(file=>file.path)]));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=bytes=>({bytes:bytes.length,sha256:sha(bytes)});
const archive=readFileSync(flags.get('--report')),json=Buffer.from(JSON.stringify(report)+'\n');
const fullReport={path:basename(flags.get('--report')),...identity(archive),
  jsonBytes:json.length,jsonSha256:sha(json)};
const {baseCatalog,...reduced}=report;
reduced.campaign={...report.campaign,rows};
const selection={schema:'test262-campaign-selection-projection/1',projection:{standaloneFullReport:false,
  omittedRows:'All unselected rows have only not_selected stages and no attempts.',
  fullPopulation:report.summary.catalogVariants,selected:rows.length},
  fullCatalogDigest:catalog.digest,fullReport,report:reduced};
const {files,variants:allVariants,...catalogMetadata}=catalog;
const selectedCatalog={schema:'test262-catalog-selection-projection/1',projection:{standaloneFullCatalog:false,
  selectedVariants:variants.length,selectedFiles:requiredPaths.size},fullCatalog:catalogMetadata,
  files:files.filter(file=>requiredPaths.has(file.path)),variants};
const output=resolve(flags.get('--out'));mkdirSync(output,{recursive:true});
const written={};
function write(name,value){const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
  writeFileSync(join(output,name),bytes);written[name]=identity(bytes);}
write('selected-catalog.json',selectedCatalog);
write('selected-report.json',selection);
write('selected-paths.txt',[...new Set(variants.map(row=>row.path))].sort().join('\n')+'\n');
write('observation.json',{schema:'test262-current-observation/1',
  sourceRevision:catalog.suiteRevision,producerRevision:report.campaign.implementation.producerRevision,
  implementationDigest:report.campaign.implementation.codeDigest,catalogDigest:report.catalogDigest,
  fullCatalogSummary:catalog.summary,acquiredPopulation:report.summary.catalogVariants,
  selected:rows.length,attempts:report.summary.attempts,runPolicy:report.runPolicy,
  resourcePolicy:report.profile.resourcePolicy,runtime:{node:report.campaign.implementation.node,
    v8:report.campaign.implementation.v8},summary:report.summary,claims:report.claims,
  fullReport,fullReportCheck:{valid:true},artifacts:written});
console.log(JSON.stringify({output,fullReport,selected:rows.length,attempts:report.summary.attempts}));
