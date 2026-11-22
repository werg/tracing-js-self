#!/usr/bin/env node
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {buildRegionFamilyRegistry,regionSplitIdentity,regionDatasetBinding,verifyRegionDatasetBinding} from '../src/semantic/family-registry-v8.js';
import {moduleSchedulerSourceFixture} from '../test/fixtures/semantic-module-scheduler-source-v8.js';

const index=process.argv.indexOf('--output');
if(index<0||!process.argv[index+1])throw new Error('--output is required');
const output=resolve(process.argv[index+1]),fixture=structuredClone(moduleSchedulerSourceFixture),
  verified=await verifyRegionModuleTrainingCase(fixture);
if(!verified.exported||verified.moduleReference!=='passed'||verified.moduleCorrespondence!=='passed')
  throw new Error('Original module source artifact refused: '+JSON.stringify({status:verified.status,phase:verified.phase,reason:verified.reason}));
const artifact=verified.exported,source=artifact.sidecar.sourceArtifact.sidecar,
  member={id:fixture.id,family:source.sourceFamily,ancestors:source.ancestorIds??[],source:source.referenceInput.source,entry:source.referenceInput.entry},
  registry=buildRegionFamilyRegistry([member],{seed:873041}),identity=regionSplitIdentity(registry,member);
Object.assign(artifact.sidecar,{family:identity.family,sourceFamily:identity.family,sourceId:identity.sourceId,
  sourceComponent:identity.componentId,familyRegistryDigest:identity.registryDigest,split:identity.split,splitIdentity:identity});
artifact.sidecar.datasetBinding=regionDatasetBinding(artifact,identity);
if(verifyRegionDatasetBinding(artifact).valid!==true)throw new Error('Isolated source registry rejected the artifact');
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(artifact),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify({status:'source-emitted',fixtureId:identity.sourceId,split:identity.split,
  registryDigest:identity.registryDigest,publicDigest:artifact.sidecar.datasetBinding.episodeDigest,
  contexts:artifact.contexts.length,moduleCuts:source.compiler.moduleSchedulerOwnership.ownedEventCount,
  productionPopulationChanged:false,optimizerUpdates:0}));
