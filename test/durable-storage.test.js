import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile, stat, mkdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createRuntime, replayExact} from 'tracing-js-self';
import {createDurableTraceStore, DurableTraceStore, TraceStorageError}
  from 'tracing-js-self/storage/node';

function sample() {
  const runtime = createRuntime().start('let answer = 2 + 3 * 4;');
  assert.equal(runtime.drive().kind, 'terminated');
  return JSON.parse(JSON.stringify(runtime.exportRun()));
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'owned-trace-archive-'));
  try { return await run(createDurableTraceStore({directory}), directory); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

test('archive survives store re-instantiation with digest and full replay verification', async () => {
  await withStore(async (store, directory) => {
    const original = sample();
    const receipt = await store.put(original);
    assert.match(receipt.id, /^[a-f0-9]{64}$/);
    assert.equal(receipt.eventCount, original.events.length);
    assert.equal(receipt.chunkCount, original.chunks.length);
    const file = store.objectPath(receipt.id);
    assert.equal((await stat(file)).size, receipt.bytes);
    assert.equal((await readFile(file, 'utf8')).endsWith('\n'), true);
    const reopened = new DurableTraceStore({directory});
    const loaded = await reopened.get(receipt.id);
    assert.deepEqual(loaded, original);
    assert.equal(replayExact(loaded).externalAdapterCalls, 0);
    assert.deepEqual(await reopened.list(), [receipt.id]);
  });
});

test('concurrent duplicate writes publish one complete immutable object', async () => {
  await withStore(async store => {
    const original = sample();
    const receipts = await Promise.all(Array.from({length: 8}, () => store.put(original)));
    assert.equal(new Set(receipts.map(r => r.id)).size, 1);
    assert.deepEqual(await store.list(), [receipts[0].id]);
    assert.deepEqual(await store.get(receipts[0].id), original);
    assert.deepEqual(await store.put(original), receipts[0]);
  });
});

test('stored bytes are authenticated before parsing or running a guest replay', async () => {
  await withStore(async store => {
    const receipt = await store.put(sample());
    await writeFile(store.objectPath(receipt.id), '{"manifest":{}}\n');
    await assert.rejects(store.get(receipt.id), error =>
      error instanceof TraceStorageError && /digest mismatch/.test(error.message));
    // Enumeration is not a substitute for verifying the archived contents.
    assert.deepEqual(await store.list(), [receipt.id]);
  });
});

test('an unreplayable archive cannot be admitted or published', async () => {
  await withStore(async store => {
    const altered = sample();
    altered.sources[0].text = 'let answer = 3 + 3 * 4;';
    await assert.rejects(store.put(altered), /Replay divergence|Cannot compile|source/i);
    assert.deepEqual(await store.list(), []);
    const unsupported = sample();
    unsupported.manifest.schema = 'semantic-tracing-run/1';
    await assert.rejects(store.put(unsupported), TraceStorageError);
    assert.deepEqual(await store.list(), []);
  });
});

test('IDs are strict, byte limits are enforced, and staged files are never listed', async () => {
  await withStore(async (store, directory) => {
    for (const id of ['../secret', 'ABCDEF', '0'.repeat(63), 'f'.repeat(65)]) {
      await assert.rejects(store.get(id), TraceStorageError);
      assert.throws(() => store.objectPath(id), TraceStorageError);
    }
    const bounded = new DurableTraceStore({directory, maxBytes: 8});
    await assert.rejects(bounded.put(sample()), TraceStorageError);
    await assert.rejects(store.get('a'.repeat(64)), {code: 'ENOENT'});
    const id = 'a'.repeat(64);
    const shard = dirname(store.objectPath(id));
    await mkdir(shard, {recursive: true});
    await writeFile(join(shard, '.tmp-orphan'), 'incomplete');
    assert.deepEqual(await store.list(), []);
  });
});

test('refuse an attacker-substituted symlink for the final archive file', async () => {
  if (process.platform === 'win32') return;
  await withStore(async (store, directory) => {
    const id = 'b'.repeat(64);
    const path = store.objectPath(id);
    await mkdir(dirname(path), {recursive: true});
    await symlink(join(directory, 'outside.json'), path);
    await assert.rejects(store.get(id));
    assert.deepEqual(await store.list(), []);
  });
});
