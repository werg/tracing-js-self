// Node/POSIX content-addressed storage for fully sealed, replayable owned traces.
// This is archive persistence, NOT a durable guest continuation or native host replay.
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, link, unlink, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const SHARD = /^[a-f0-9]{2}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export class TraceStorageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TraceStorageError';
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id))
    throw new TraceStorageError('Invalid SHA-256 trace archive ID');
  return id;
}

function checkMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError('maxBytes must be a positive safe integer');
  return value;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function verifyBundle(bundle) {
  if (bundle?.manifest?.schema !== 'semantic-tracing-run/2')
    throw new TraceStorageError('Durable storage requires replayable semantic-tracing-run/2');
  // The independent validator and same-interpreter replay are BOTH required.
  // Do not persist structurally plausible but unreplayable candidate episodes.
  const structural = validateBundle(bundle);
  const replay = replayExact(bundle);
  if (structural.valid !== true || replay.valid !== true || replay.externalAdapterCalls !== 0)
    throw new TraceStorageError('Trace verification did not succeed');
  return {eventCount: structural.eventCount, chunkCount: structural.chunkCount};
}

export class DurableTraceStore {
  constructor({directory, maxBytes = DEFAULT_MAX_BYTES} = {}) {
    if (typeof directory !== 'string' || !directory.trim())
      throw new TypeError('A private local storage directory is required');
    this.directory = resolve(directory);
    this.maxBytes = checkMaxBytes(maxBytes);
  }

  objectPath(id) {
    checkId(id);
    return join(this.directory, 'objects', id.slice(0, 2), id + '.json');
  }

  async prepare(id) {
    const objects = join(this.directory, 'objects');
    const shard = join(objects, id.slice(0, 2));
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    await mkdir(objects, {recursive: true, mode: 0o700});
    await mkdir(shard, {recursive: true, mode: 0o700});
    // Persist newly-created directory entries before publishing the object.
    await syncDirectory(this.directory);
    await syncDirectory(objects);
    return shard;
  }

  /**
   * Verify a JSON snapshot BEFORE publication; fsync the temporary bytes,
   * publish with an atomic no-replace hard link, then fsync the containing
   * directory. Identical concurrent writers converge on the same ID.
   *
   * Only trusted in-process plain JSON archives should be passed here:
   * JSON.stringify of attacker-created JS objects can execute getters/toJSON.
   */
  async put(bundle) {
    let serialized;
    try { serialized = JSON.stringify(bundle); }
    catch (cause) { throw new TraceStorageError('Trace cannot be encoded as JSON', {cause}); }
    if (typeof serialized !== 'string')
      throw new TraceStorageError('Trace must be a JSON object');
    const bytes = Buffer.from(serialized + '\n', 'utf8');
    if (bytes.length > this.maxBytes)
      throw new TraceStorageError('Trace exceeds the configured archive byte limit');
    const snapshot = JSON.parse(bytes.toString('utf8'));
    const summary = verifyBundle(snapshot);
    const id = digest(bytes);
    const shard = await this.prepare(id);
    const target = this.objectPath(id);
    const temp = join(shard, '.tmp-' + randomUUID());
    let written = false;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        written = true;
      } finally {
        await handle.close();
      }
      try {
        // link() is atomic and refuses to replace an existing archive.
        await link(temp, target);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Existing content must be checked, not blindly trusted as valid.
        const existing = await this.readBytes(id);
        if (!existing.equals(bytes))
          throw new TraceStorageError('Existing archive has conflicting bytes');
      }
      await syncDirectory(shard);
    } finally {
      // Orphaned .tmp-* files after a crash are never visible to get/list.
      // Do not automatically delete other writers' temporary files.
      await unlink(temp).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (written) await syncDirectory(shard);
    }
    return Object.freeze({id, bytes: bytes.length, ...summary});
  }

  async readBytes(id) {
    const path = this.objectPath(id);
    // O_NOFOLLOW blocks a substituted symlink at the final component.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > this.maxBytes)
        throw new TraceStorageError('Invalid archive file or byte limit exceeded');
      const bytes = await handle.readFile();
      if (bytes.length > this.maxBytes || digest(bytes) !== id)
        throw new TraceStorageError('Trace archive digest mismatch');
      return bytes;
    } finally {
      await handle.close();
    }
  }

  /** Re-check the content digest, journal structure and exact replay on EVERY read. */
  async get(id) {
    const bytes = await this.readBytes(id);
    let bundle;
    try { bundle = JSON.parse(bytes.toString('utf8')); }
    catch (cause) { throw new TraceStorageError('Trace archive contains invalid JSON', {cause}); }
    verifyBundle(bundle);
    return bundle;
  }

  /** Return only published names; each get() independently checks their contents. */
  async list() {
    const objects = join(this.directory, 'objects');
    let shards;
    try { shards = await readdir(objects, {withFileTypes: true}); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const ids = [];
    for (const shard of shards) {
      if (!shard.isDirectory() || !SHARD.test(shard.name)) continue;
      for (const entry of await readdir(join(objects, shard.name), {withFileTypes: true})) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (ID.test(id) && id.startsWith(shard.name)) ids.push(id);
      }
    }
    return ids.sort();
  }
}

export function createDurableTraceStore(options) {
  return new DurableTraceStore(options);
}

export {DurableRetainedModuleStore,DurableRetainedModuleStorageError,
  createDurableRetainedModuleStore} from './retained-session.js';
