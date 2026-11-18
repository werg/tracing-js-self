import {execFileSync} from 'node:child_process';

export function producerSnapshot(root){
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  return {revision:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),
    trackedChanges:git('status','--porcelain','--untracked-files=no')};
}

export function compareProducerSnapshot(expected,actual){
  const mismatches=[];
  if(expected.trackedChanges)mismatches.push('baseline started with modified tracked files');
  if(actual.trackedChanges)mismatches.push('tracked producer files changed during qualification');
  if(actual.revision!==expected.revision)mismatches.push('producer revision changed during qualification');
  if(actual.tree!==expected.tree)mismatches.push('producer tree changed during qualification');
  return mismatches;
}

export function compareReleaseEnvironment(expected,actual){
  return Object.fromEntries(['node','v8','npm','platform','arch','timezone','locale']
    .filter(key=>actual[key]!==expected[key])
    .map(key=>[key,{expected:expected[key],actual:actual[key]??null}]));
}
