# Durable sealed trace archives (Node/POSIX)

The opt-in package entry tracing-js-self/storage/node stores a completed JSON trace bundle in a private local directory. It makes a sealed semantic-tracing-run/2 artifact addressable across Node processes. This is not a persistent VM continuation, a write-ahead execution journal, a natlang module realm, or a native resource checkpoint.

## API

~~~js
import {createRuntime} from 'tracing-js-self';
import {createDurableTraceStore} from 'tracing-js-self/storage/node';

const store = createDurableTraceStore({directory: '/private/traces'});
const runtime = createRuntime().start('let answer = 2 + 3;');
runtime.drive();

const receipt = await store.put(runtime.exportRun());
// {id: '<sha256 hex>', bytes: ..., eventCount: ..., chunkCount: ...}
const original = await store.get(receipt.id); // revalidates AND replays
const ids = await store.list();                // metadata only; not verification

// A new process can open the same directory and retrieve the archive.
~~~

Both put() and get() enforce:

1. A JSON-serializable semantic-tracing-run/2 bundle.
2. Independent journal structure validation (validateBundle).
3. Exact re-execution through the owned interpreter (replayExact), with **zero native host adapter calls**.
4. A SHA-256 digest over the **exact UTF-8 JSON file bytes**, including the terminating newline, checked before reading JSON back.

The ID is byte-addressed, not a canonical semantic hash: a different JSON key ordering may produce a different ID for an equivalent run. put returns an immutable receipt with id, bytes, eventCount, and chunkCount; get returns the decoded bundle. The default maximum **serialized archive** size is 256 MiB; set maxBytes in bytes to tighten this cap. There is no streaming writer, and serialization allocates the full payload in memory.

## Crash and concurrency behavior

On POSIX filesystems supporting hard links and directory fsync, writes use a private same-directory staging file, exclusive creation, file fsync, atomic no-replace link, and directory fsync. Concurrent identical writers converge on the same final name without publishing partially written bytes. An existing published name is never overwritten and its bytes are compared with the incoming payload before accepting a duplicate. Archive readers open with O_NOFOLLOW for the final path component and verify the digest.

Crash-interrupted staging files use .tmp-* names and are ignored by get/list; they are deliberately **not** automatically deleted, because a different writer could be using them. Operators may clean them during exclusive maintenance. The caller must provide a private, access-controlled directory on a trusted local filesystem. The implementation is not a transactional database, multi-host distributed store, or a guarantee against disk corruption and privileged tampering. Directory sync / hard-link semantics vary on Windows and network filesystems and are not claimed there.

## Trust and training boundaries

Store **private** owned-machine archives, not the public semantic-execution/2 training episodes, and protect host arrival payloads and source code accordingly. The archive contains historical host inputs and may contain sensitive material. Only pass trusted in-process JSON/plain-data run objects to put: JavaScript JSON.stringify invokes getters or toJSON on arbitrary caller-provided objects.

The stored artifact is replayable by the **current bounded interpreter**, not independently proved ECMAScript-correct. get verifies again under the installed runtime version; older bundles may need a pinned compatible package. It does not reissue native effects or restore sockets, timers, guest heaps in a live runtime, agent scheduling, callbacks, or ECMAScript Module Records. It does not change admitted=0 or the Test262 / WPT / Node / browser conformance boundaries.

Use an external retention index or database if you need production catalog queries, streaming append, replication, lifecycle/GC, content encryption, or high-throughput backpressure. This facility closes only the **sealed-bundle persistence** slice of the broader durability roadmap.

## Bounded evaluated-module-session checkpoints

`tracing-js-self/storage/node` also exports `createDurableRetainedModuleStore({directory})`. This stores committed histories from `createBoundedRetainedModuleSession`, not live JS VMs:

~~~js
import {createBoundedRetainedModuleSession} from 'tracing-js-self/evaluated-module-session';
import {createDurableRetainedModuleStore} from 'tracing-js-self/storage/node';
const session=createBoundedRetainedModuleSession({modules:{'main.js':'export let n=1; export function add(x){n+=x;return n;}'},entryModule:'main.js'});
await session.invoke('add',[2]);
const store=createDurableRetainedModuleStore({directory:'/private/traces'});
const {id}=await store.put(session);
const restored=await store.get(id);
// (await restored.invoke('add',[4])).result === 7
session.close();restored.close();
~~~

Only up to 32 bounded primitive-argument invocation records, previously committed and replay-verified, are included. Pending invocations, host object identities, native side effects and live guest continuations are deliberately excluded. Every `put` first restores/replays a detached copy of the history; every `get` checks its exact digest and replays again with no native service installed. Reads create new host object identities. Writes use the same POSIX hard-link/fsync pattern as sealed trace bundles, but distinct `module-sessions` namespaces and an 8 MiB default size cap. Store source code and histories only in a private trusted directory. This facility is **not** a natlang callable-folder `setModuleRealm` implementation or a general persistent ESM Module Record.
