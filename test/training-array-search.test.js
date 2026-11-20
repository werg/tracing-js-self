import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
const source=body=>'"use strict";function run(){'+body+'}';
function check(body){
  const r=verifyOwnedSourceCase({source:source(body),entry:'run',maxGenerated:8192});
  assert.equal(r.status,'locally_verified',r.reason);
  assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
}
test('find findIndex some and every stop exactly at their first decisive callback',()=>{
  for(const method of ['find','findIndex','some','every']){
    check('let calls=[];const xs=[2,3,4];const r=xs.'+method+'((x,i)=>{calls.push(i);return x>2;});return [r,calls];');
    check('return [[],[1]].map(a=>a.'+method+'(x=>false));');
  }
});
test('search visits holes while some every map filter and reduce skip absent indices',()=>{
  check('const xs=[,2,,];let seen=[];const n=xs.findIndex((x,i)=>{seen.push([i,x]);return false;});return [n,seen];');
  check('const xs=[,2,,4,,];let seen=[];const ys=xs.map((x,i)=>{seen.push(i);return x*2;});return [ys,seen,xs.filter(x=>true),xs.reduce((a,b)=>a+b),xs.every(x=>x>0)];');
  check('try{return [,,].reduce((a,b)=>a+b);}catch(e){return e.name;}');
});
test('callbacks retain fixed length live reads thisArg and original matched value',()=>{
  check('const a=[1,2,3];let seen=[];const found=a.find(function(x,i,arr){seen.push([i,this.k,x]);arr[1]=8;arr.push(9);return i===1;},{k:7});return [found,seen,a];');
  check('const a=[1,2,3];return a.find((x,i)=>{a[i]=9;return true;});');
  check('let seen=[];const a=[1,2,3];const r=a.map((x,i)=>{seen.push(i);a.length=1;return x;});return [r,seen];');
});
test('search callback abrupt completion retains try and finally source receipts',async()=>{
  const body='let count=0;try{return [1,2,3].find(x=>{count++;if(x===2)throw 7;return false;});}catch(e){return [e,count];}finally{count++;}';
  check(body);
  const r=await verifyEffectfulTrainingCase({source:source(body),entry:'run',family:'search-callback-abrupt',fixture:{calls:[]}});
  assert.equal(r.status,'locally_verified',r.reason);
});
