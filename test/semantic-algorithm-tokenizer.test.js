import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAlgorithmTokenizer,validateAlgorithmTokenizerEvidence} from '../src/semantic/tokenizer.js';
import {encodeAlgorithmRecord} from '../src/semantic/trace-codec.js';

const policy=JSON.parse(await readFile(new URL('../contracts/native-admission-policy-v6.json',import.meta.url),'utf8'));
const identity={name:'inclusionAI/Ling-3.0-tiny',revision:'pinned',tokenizerSha256:policy.tokenizerSha256,
  fingerprint:policy.tokenizerIdentity,codecVersion:'raw-byte-bpe-v2',vocabSize:157184};
const qualification={schema:'semantic-codec-meter/1',status:'qualified',scope:'byte-exact-token-meter-only',
  consumerRevision:policy.consumerRevision,consumerClean:true,codecSourceSha256:'1'.repeat(64),
  pythonVersion:'3.12.14',tokenizersVersion:'0.23.3',nativeAdmission:false};

test('token meter policy rejects other assets, dirty consumers, and false native-qualification claims',()=>{
  const valid={identity,qualification};assert(validateAlgorithmTokenizerEvidence(valid,policy));
  for(const mutate of [
    value=>value.identity.tokenizerSha256='0'.repeat(64),value=>value.identity.fingerprint='0'.repeat(64),
    value=>value.qualification.consumerRevision='0'.repeat(40),value=>value.qualification.consumerClean=false,
    value=>value.qualification.nativeAdmission=true,value=>value.qualification.scope='native-supervision',
    value=>value.qualification.tokenizersVersion='0.99.0'
  ]){const wrong=structuredClone(valid);mutate(wrong);assert.throws(()=>validateAlgorithmTokenizerEvidence(wrong,policy));}
});

test('token meter fails explicitly when an independently pinned consumer is unavailable',async()=>{
  await assert.rejects(createAlgorithmTokenizer({consumerRoot:'/nonexistent-semantic-consumer',
    tokenizerJson:'/nonexistent-semantic-tokenizer.json',policy,startupTimeoutMs:5000}),
  /Token meter stopped|ENOENT/);
});

const python=process.env.SEMANTIC_TOKENIZER_PYTHON,consumerRoot=process.env.SEMANTIC_TOKENIZER_CONSUMER_ROOT,
  tokenizerJson=process.env.SEMANTIC_TOKENIZER_JSON;
test('actual pinned ByteCodec reproduces the frozen gallery and meters exact v7/context bytes',
  {skip:!(python&&consumerRoot&&tokenizerJson)?'Exact external consumer/tokenizer paths were not supplied':false},async()=>{
    const meter=await createAlgorithmTokenizer({python,consumerRoot,tokenizerJson,policy});
    try{
      assert.equal(meter.qualification.nativeAdmission,false);
      const gallery=JSON.parse(await readFile(new URL('../docs/evidence/semantic-target-gallery-v2/gallery.json',import.meta.url),'utf8'));
      let total=0;
      for(const row of gallery.cases){
        let current=0;
        for(const record of row.records.filter(record=>record.targetMask==='generated')){
          const ids=await meter.encode(record.raw);assert.equal(await meter.decode(ids),record.raw);current+=ids.length;
        }
        assert.equal(current,row.metrics.generatedTokens,'paired baseline tokens: '+row.id);total+=current;
      }
      assert.equal(total,1307);
      const targets=[encodeAlgorithmRecord({kind:'compute',id:'v0',term:{op:'fold_left',input:{op:'input',id:'a0'},
        initial:{op:'literal',value:['num',0]},step:'add',order:'ascending',profile:'dense-number-array/1'},result:['num',9]}),
      encodeAlgorithmRecord({kind:'return',value:['num',9]}),'e\u0301\nα\u0000',
      JSON.stringify({schema:'semantic-context/7',program:{source:'"use strict";function run(){return "α";}'},
        state:{values:[['v0',['num','-0']]],future:null}})+'\n'];
      const encoded=await Promise.all(targets.map(text=>meter.encode(text)));
      const decoded=await Promise.all(encoded.map(ids=>meter.decode(ids)));
      assert.deepEqual(decoded,targets);
    }finally{await meter.close();}
  });
