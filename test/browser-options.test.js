import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/browser.js';

test('browser options never invoke getters', () => {
  let touched = 0;
  const options = Object.defineProperty({}, 'maxSteps', {
    enumerable: true,
    get() { touched++; throw new Error('untrusted option getter'); }
  });
  assert.throws(() => createRuntime(options), /own data properties/);
  assert.equal(touched, 0);
});

test('browser options refuse inherited configuration and unknown keys', () => {
  assert.throws(() => createRuntime(Object.create({maxSteps: 1})), /plain record/);
  assert.throws(() => createRuntime({adapters: {}}), /Unsupported browser runtime option/);
});

test('browser options accept plain and null-prototype own data records', () => {
  assert.ok(createRuntime({maxSteps: 10}));
  const options = Object.assign(Object.create(null), {maxSteps: 10});
  assert.ok(createRuntime(options));
});
