#!/usr/bin/env node
import {writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';
import {
  buildRegionFamilyRegistry,
  regionSplitIdentity,
  regionDatasetBinding,
  verifyRegionDatasetBinding,
} from '../src/semantic/family-registry-v8.js';
import {
  namespaceModules,
  namespaceEntry,
  namespaceExport,
  namespaceArgs,
  namespaceMaxGenerated,
} from '../test/fixtures/semantic-module-namespace-v8.js';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Required option ${name}`);
  return process.argv[index + 1];
}

const output = resolve(option('--output'));
const fixture = {
  id: 'namespace-public-pack-fixture-v1',
  family: 'namespace-public-pack-fixture',
  moduleEntry: namespaceEntry,
  exportName: namespaceExport,
  modules: namespaceModules,
  args: namespaceArgs,
  experimentalNamespacePlan: true,
  projectionOptions: {maxGenerated: namespaceMaxGenerated},
};
const result = await verifyRegionModuleTrainingCase(fixture);
if (!result.exported || result.moduleReference !== 'passed' || result.moduleCorrespondence !== 'passed') {
  throw new Error('Actual original-module namespace fixture did not produce a source-corresponding artifact: ' +
    JSON.stringify({status: result.status, phase: result.phase, reason: result.reason, category: result.category}));
}
const artifact = structuredClone(result.exported);
const sourceSide = artifact.sidecar?.sourceArtifact?.sidecar;
const reference = sourceSide?.referenceInput;
if (!reference || typeof reference.source !== 'string' || typeof reference.entry !== 'string' ||
  typeof sourceSide.sourceFamily !== 'string' || !sourceSide.sourceFamily) {
  throw new Error('Supported module fixture lacks canonical source family/reference evidence');
}

// This registry is isolated to one explicit technical fixture. It is re-derived
// from the actual producer-emitted source/entry and is never merged into either
// production population or its immutable registry.
const member = {
  id: fixture.id,
  family: sourceSide.sourceFamily,
  ancestors: sourceSide.ancestorIds ?? [],
  source: reference.source,
  entry: reference.entry,
};
const registry = buildRegionFamilyRegistry([member], {seed: 873041});
const identity = regionSplitIdentity(registry, member);
Object.assign(artifact.sidecar, {
  family: identity.family,
  sourceFamily: identity.family,
  sourceId: identity.sourceId,
  sourceComponent: identity.componentId,
  familyRegistryDigest: identity.registryDigest,
  split: identity.split,
  splitIdentity: identity,
});
artifact.sidecar.datasetBinding = regionDatasetBinding(artifact, identity);
if (verifyRegionDatasetBinding(artifact).valid !== true) {
  throw new Error('Canonical one-member fixture registry rejected the emitted artifact');
}
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(artifact), {encoding: 'utf8', flag: 'wx'});
process.stdout.write(JSON.stringify({
  status: 'source-emitted',
  fixtureId: identity.sourceId,
  split: identity.split,
  registryDigest: identity.registryDigest,
  publicDigest: artifact.sidecar.datasetBinding.episodeDigest,
}) + '\n');
