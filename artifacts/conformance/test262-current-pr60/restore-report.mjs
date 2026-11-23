#!/usr/bin/env node
// Run from the recorded producer checkout. This reconstructs retained evidence;
// it does not run guests or create new conformance/admission observations.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const flags=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const name=process.argv[index],value=process.argv[index+1];
  if(!['--catalog','--selection','--out'].includes(name)||!value||flags.has(name))
    throw new TypeError('Usage: node restore-report.mjs --catalog full-catalog.json.gz --selection selected-report.json --out restored.json.gz');
  flags.set(name,value);
}
if(flags.size!==3)throw new TypeError('All three arguments are required');
const root=process.cwd();
const {bindTest262CatalogProfile,createTest262Campaign,conformanceDigest}=await import(
  pathToFileURL(resolve(root,'src/conformance/test262-catalog.js')));
const {readTest262Json,writeTest262Json,createTest262CampaignReport,validateOriginalTest262Report}=await import(
  pathToFileURL(resolve(root,'src/conformance/test262-campaign.js')));
const projection=JSON.parse(readFileSync(flags.get('--selection'),'utf8'));
if(projection.schema!=='test262-campaign-selection-projection/1')throw new TypeError('Unknown projection');
const input=readTest262Json(flags.get('--catalog')),baseCatalog=input.catalog??input;
if(baseCatalog.digest!==projection.fullCatalogDigest)throw new TypeError('Full acquired catalog differs from retained evidence');
const retained=projection.report,catalog=bindTest262CatalogProfile(baseCatalog,retained.profile);
const campaign=createTest262Campaign({catalog,implementation:retained.campaign.implementation,
  selectedIds:retained.campaign.selectedIds});
const selectedRows=new Map(retained.campaign.rows.map(row=>[row.id,row]));
if(selectedRows.size!==retained.campaign.rows.length||selectedRows.size!==campaign.selectedIds.length||
  [...selectedRows.values()].some(row=>!row.selected)||
  campaign.selectedIds.some(id=>!selectedRows.has(id)))throw new TypeError('Projection changed selected rows');
campaign.rows=campaign.rows.map(row=>row.selected?selectedRows.get(row.id):row);
const report=createTest262CampaignReport({baseCatalog,catalog,campaign,runPolicy:retained.runPolicy});
// Recompute the full ledger first, then require that every retained non-row
// field (including claims and full-population counts) is reproduced exactly.
const {baseCatalog:omittedCatalog,...reduced}=report;
reduced.campaign={...report.campaign,rows:report.campaign.rows.filter(row=>row.selected)};
if(conformanceDigest(reduced)!==conformanceDigest(retained))throw new TypeError('Projection changed report metadata');
validateOriginalTest262Report(report);
const json=Buffer.from(JSON.stringify(report)+'\n');
const jsonSha256=createHash('sha256').update(json).digest('hex');
if(jsonSha256!==projection.fullReport.jsonSha256)throw new TypeError('Reconstructed full report differs from original bytes');
writeTest262Json(flags.get('--out'),report);
const archiveSha256=createHash('sha256').update(readFileSync(flags.get('--out'))).digest('hex');
console.log(JSON.stringify({valid:true,reconstructed:true,guestExecutions:0,
  sourceRevision:baseCatalog.suiteRevision,producerRevision:campaign.implementation.producerRevision,
  catalogVariants:report.summary.catalogVariants,selected:report.summary.selected,attempts:report.summary.attempts,
  jsonSha256,archiveSha256,archiveByteIdentical:archiveSha256===projection.fullReport.sha256}));
