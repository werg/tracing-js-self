#!/usr/bin/env node
// A release-only projection: never rewrite source identities, frozen splits,
// original admissions, or held-out memberships to satisfy a training budget.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {balanceFamilyTokens} from '../src/corpus/source-registry.mjs';

export function selectReleaseTraining(rows,{maxFamilyTokens=null,maxFamilyShare=null}={}){
  const enabled=maxFamilyTokens!==null||maxFamilyShare!==null;
  if(!Array.isArray(rows)||maxFamilyTokens!==null&&(!Number.isSafeInteger(maxFamilyTokens)||maxFamilyTokens<1)||
    maxFamilyShare!==null&&(!Number.isFinite(maxFamilyShare)||maxFamilyShare<=0||maxFamilyShare>1))
    throw new TypeError('Invalid release family token caps');
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id)||row.status!=='admitted'||
      !['train','validation','test'].includes(row.split)||typeof row.sourceCluster!=='string'||!row.sourceCluster||
      !Number.isSafeInteger(row.generatedTokens)||row.generatedTokens<1)
      throw new Error('Release selection requires unique qualified candidates and actual native token counts');
    seen.add(row.id);
  }
  const training=rows.filter(row=>row.split==='train'),heldOut=rows.filter(row=>row.split!=='train');
  if(enabled&&training.some(row=>row.splitPolicy!=='source-components/1'||
    !/^[a-f0-9]{64}$/.test(row.registryDigest??'')))
    throw new Error('Training token caps require authenticated frozen source components');
  if(enabled&&new Set(training.map(row=>row.registryDigest)).size>1)
    throw new Error('Training token caps require one global frozen source registry');
  const balanced=enabled?balanceFamilyTokens(training,{maxFamilyTokens:maxFamilyTokens??Number.MAX_SAFE_INTEGER,
    maxFamilyShare:maxFamilyShare??1}):{selected:training,refused:[]};
  const selected=new Set(balanced.selected.map(row=>row.id)),components=new Map();
  for(const row of training){
    const component=components.get(row.sourceCluster)??{sourceCluster:row.sourceCluster,families:new Set(),
      availableGeneratedTokens:0,selectedGeneratedTokens:0,availableCandidates:0,selectedCandidates:0};
    component.families.add(row.family);component.availableGeneratedTokens+=row.generatedTokens;component.availableCandidates++;
    if(selected.has(row.id)){component.selectedGeneratedTokens+=row.generatedTokens;component.selectedCandidates++;}
    components.set(row.sourceCluster,component);
  }
  const total=balanced.selected.reduce((sum,row)=>sum+row.generatedTokens,0),
    available=training.reduce((sum,row)=>sum+row.generatedTokens,0);
  return {schema:'semantic-training-selection/1',status:enabled&&!selected.size?'empty-training-selection':'selected',
    policy:{enabled,maxFamilyTokens,maxFamilyShare,scope:'training-only',
      tokenMeasurement:'fresh-native-generatedTokens',componentIdentity:training.every(row=>row.splitPolicy==='source-components/1')?
        'authenticated-frozen-source-components':'authenticated-source-families'},
    availableTrainIds:training.map(row=>row.id),selectedTrainIds:balanced.selected.map(row=>row.id),
    excludedTrain:balanced.refused,heldOutIds:heldOut.map(row=>row.id),
    heldOutBySplit:Object.fromEntries(['validation','test'].map(split=>[split,heldOut.filter(row=>row.split===split).map(row=>row.id)])),
    preparedCandidateIds:rows.filter(row=>row.split!=='train'||selected.has(row.id)).map(row=>row.id),
    generatedTokens:{availableTrain:available,selectedTrain:total,excludedTrain:available-total,
      heldOut:heldOut.reduce((sum,row)=>sum+row.generatedTokens,0)},
    components:[...components.values()].map(row=>({...row,families:[...row.families].sort(),
      selectedTokenShare:total?row.selectedGeneratedTokens/total:0})).sort((a,b)=>a.sourceCluster.localeCompare(b.sourceCluster)),
    originalAdmissionsPreserved:true,heldOutMembershipsPreserved:true,optimizerSteps:0,learnedSuccess:null};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw new Error('Usage: node tools/select-release-training.mjs INPUT_JSON OUTPUT_JSON');
  const {rows,...options}=JSON.parse(readFileSync(process.argv[2],'utf8'));
  writeFileSync(process.argv[3],JSON.stringify(selectReleaseTraining(rows,options),null,2)+'\n',{flag:'wx'});
}
