#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverEngineInventory, formatEngineInventory, readPinnedEngine,
  reconcileEngineInventory, validateInventoryStructure, verifyEngineInventory } from '../src/engine-inventory.js';

const args = process.argv.slice(2);
let engineSource = null, candidate = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--engine-source' && args[index + 1]) engineSource = resolve(args[++index]);
  else if (args[index] === '--candidate' && args[index + 1]) candidate = resolve(args[++index]);
  else throw new Error('Usage: node scripts/audit-engine262.mjs [--engine-source PATH] [--candidate FILE]');
}
if (candidate && !engineSource) throw new Error('--candidate requires --engine-source');
const profile = JSON.parse(readFileSync(new URL('../profiles/targets.lock.json', import.meta.url), 'utf8'));
const inventoryPath = new URL('../coverage/engine262-inventory.json', import.meta.url);
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const expectedCommit = profile.referenceEngine.upstreamCommit;
if (engineSource) {
  const upstream = readPinnedEngine(engineSource, expectedCommit);
  if (candidate) {
    const discovered = reconcileEngineInventory(inventory, discoverEngineInventory(upstream));
    writeFileSync(candidate, formatEngineInventory(discovered));
    console.log(JSON.stringify({ candidate, evidence: 'Candidate only; new or changed records are unclassified and require review.' }, null, 2));
  } else console.log(JSON.stringify(verifyEngineInventory(inventory, upstream, { expectedCommit }), null, 2));
} else console.log(JSON.stringify(validateInventoryStructure(inventory, { expectedCommit }), null, 2));
