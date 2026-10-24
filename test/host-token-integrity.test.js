import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeJson} from '../src/host/materialize.js';
import {validatePreparedRequest} from '../src/host/validate-request.js';

test('outbound host codec refuses malformed scalar tagged values', () => {
  const malformed = [
    ['null', 'unexpected'],
    ['bool', true, 'unexpected'],
    ['str', 'x', 'unexpected'],
    ['num', 1, 'unexpected'],
    ['ref', 'o1', 'unexpected']
  ];
  const heap = {o1: {
    kind:'object',version:0,shapeVersion:0,
    properties:{},propertyVersions:{}
  }};
  for (const value of malformed) {
    assert.throws(() => materializeJson(heap, [value]), TypeError,
      'malformed token must never become an external request: '+JSON.stringify(value));
  }
});

test('valid scalar host requests retain canonical byte accounting and independent verification', () => {
  const args=[['str','𝄞'],['null']];
  const payload=materializeJson({},args);
  assert.equal(payload.payload,'["𝄞",null]');
  assert.equal(payload.byteLength,Buffer.byteLength(payload.payload,'utf8'));
  const effect={operation:'demo.store',kind:'synchronous',args,
    request:{schema:'host-request/1',operation:'demo.store',
      signature:'demo.store/1',codec:'canonical-json/1',
      payload:payload.payload,byteLength:payload.byteLength,
      graphVersions:payload.graphVersions}};
  assert.equal(validatePreparedRequest({},effect).valid,true);
});
