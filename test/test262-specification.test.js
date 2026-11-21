import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedTest262Profile} from '../src/conformance/test262-runner.js';
import {readPinnedEcma262Specification,verifyEcma262SpecificationBytes}
  from '../src/conformance/test262-specification.js';

test('the retained normative HTML is the pinned ECMA-262 17th edition with its notice intact',()=>{
  const {manifest,specification,bytes}=readPinnedEcma262Specification();
  const html=bytes.toString('utf8');
  assert.equal(manifest.edition,'ECMAScript 2026');
  assert.equal(manifest.standard,'ECMA-262 17th edition, June 2026');
  assert.equal(manifest.normativeFormat,'text/html');
  assert.equal(manifest.bytes,8_348_904);
  assert.equal(manifest.sha256,'5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a');
  assert.match(html,/<h1 class="title">ECMA-262, 17<sup>th<\/sup> edition, June 2026/);
  assert.match(html,/ALTERNATIVE COPYRIGHT NOTICE AND COPYRIGHT LICENSE/);
  assert.match(html,/Permission under Ecma’s copyright to copy, modify/);
  assert.match(html,/The full text of this COPYRIGHT NOTICE AND COPYRIGHT LICENSE/);
  assert.match(html,/Redistribution and use in source and binary forms/);
  assert.equal(verifyEcma262SpecificationBytes(bytes,specification,manifest),true);
  const profile=ownedTest262Profile({specification});
  assert.deepEqual(profile.specification,specification);
  assert.match(profile.limits[0],/edition membership remains unclassified/i);
});

test('a declared annual pin is rejected when actual bytes or URI/hash metadata differ',()=>{
  const {manifest,specification,bytes}=readPinnedEcma262Specification();
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
  assert.throws(()=>verifyEcma262SpecificationBytes(changed,specification,manifest),
    /bytes differ from the declared identity/);
  assert.throws(()=>verifyEcma262SpecificationBytes(bytes,{...specification,sha256:'0'.repeat(64)},manifest),
    /bytes differ from the declared identity/);
  assert.throws(()=>readPinnedEcma262Specification({declared:{...specification,
    uri:'https://tc39.es/ecma262/'}}),/bytes differ from the declared identity/);
});
