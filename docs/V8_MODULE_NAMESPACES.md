# Bounded original-module namespace source profile

## Scope

The V8 module path has an explicit experimental namespace profile. A caller must
set `experimentalNamespacePlan: true` on an original-module training case.
Without that opt-in, a graph requiring a namespace exotic still returns
`unsupported.module-namespace-projection`. The existing ordinary module path
keeps its asynchronous wrapper and existing source/reference evidence shape.

This profile is deliberately narrower than ECMAScript module conformance. It
qualifies a synchronous scalar subset with actual namespace exotics, live
mutable cells, dynamic string-key reads, `Object.keys`, and value descriptors.
It does not qualify general async module scheduling, cycles, dynamic import,
namespace escape, arbitrary reflection, Proxy behavior, persistent-session
module restoration, or TypeScript source semantics.

The runnable fixture is
[`test/fixtures/semantic-module-namespace-v8.js`](../test/fixtures/semantic-module-namespace-v8.js).
It imports a namespace through an explicit reexport, reads a live cell, obtains
the namespace keys, changes the cell through a named imported function, and
reads the changed value through a descriptor. The graph has one scalar entry
argument and one entry call. The artifact emitter uses a separate one-member
technical registry; it does not add a source to any production population.

## Calling the source qualifier

```js
import {verifyRegionModuleTrainingCase} from '../src/semantic/module-v8.js';

const result = await verifyRegionModuleTrainingCase({
  id: 'namespace-example',
  family: 'namespace-example',
  moduleEntry: 'main.js',
  exportName: 'run',
  modules: {
    'main.js': `
      import * as view from './view.js';
      import {update} from './state.js';
      export function run(key) {
        const before = view[key];
        const keys = Object.keys(view);
        update(9);
        const after = Object.getOwnPropertyDescriptor(view, 'value').value;
        return {before, after, keys};
      }
    `,
    'state.js': `
      export let value = 1;
      export const fixed = 2;
      export function update(next) { value = next; }
    `,
    'view.js': "export {value, fixed} from './state.js';"
  },
  args: ['value'],
  experimentalNamespacePlan: true,
  projectionOptions: {maxGenerated: 20000}
});
```

An exported source artifact is not by itself a native admission receipt or a
learning result. Source admission, independent native admission, tokenizer
verification, packing, optimizer use, and learned program success remain
separate gates.

## Authority chain

1. **Original graph and synchronous proof.** Canonical own-data module paths
   and source bytes are retained. The linker proves the supported AST and
   call targets before selecting the synchronous wrapper. It rejects jobs,
   Promise/async/generator scheduling, top-level await, unknown call targets,
   shadowed imported callees, thenable-shaped values, and unsupported namespace
   cell forms. The synchronous wrapper is not selected merely because an
   example happened to finish synchronously.
2. **Fresh plan derivation.** The plan is rebuilt from the original modules.
   It binds raw source digests, the entry module, cells, namespace identities,
   export-name-to-cell mappings, and lowered binding names. A supplied digest
   alone does not establish those mappings.
3. **Independent original ESM execution.** A separate worker evaluates actual
   `vm.SourceTextModule` modules. The observer independently resolves original
   export/reexport syntax, then records real namespace operations and cell
   changes. The owned linked program is not the reference implementation.
   Observer bindings and original namespace identity are checked, and
   unsupported escapes or non-scalar observations refuse.
4. **Owned event projection.** The generated owned program runs through the
   interpreter. A private adapter must own the exact source instruction and
   complete getter continuation for each namespace operation. The adapter
   checks actual heap cells, closure bindings, frame identity and continuation
   state; a matching source span alone is insufficient.
5. **Outcome and ordered-operation comparison.** The original ESM outcome is
   compared with the independently owned outcome. Its ordered cell/read/key/
   descriptor observations must also equal the normalized projected operations.
   Only then is original-module reference agreement recorded.
6. **Fresh admission recheck.** Direct protocol entry and exported-artifact
   recheck rederive original module evidence and compare the actual arguments,
   linked source, published plan, metadata and reference input. Altering a
   reference field, argument graph, export mapping or outer public plan cannot
   gain authority merely by recomputing hashes.
7. **Independent public/native execution.** The public JavaScript machine and
   Python consumer implement the same six operations against their own state.
   Native admission rechecks source binding, exact repository revisions and the
   production tokenizer before preparing targets. Packing must retain the
   operations and nonempty positive-loss token masks.

The checks are intentionally separate. None can be replaced by a copied
reference outcome, a private source claim, or a hash of attacker-supplied data.

## Public plan and operations

The published plan has schema `semantic-module-namespace-plan/1` and fields
`entryModule`, `modules`, `cells`, `namespaces`, and `digest`.
Source offsets and private event ownership stay outside this public plan.
A namespace export maps to one canonical cell. Public namespace objects retain
cell references and metadata rather than duplicating mutable export values.

| Operation | Public meaning |
| --- | --- |
| `namespace.create` | Atomically allocate the named namespace identity and bind its published namespace name. |
| `cell.initialize` | Initialize one declared cell exactly once with a supported scalar. |
| `cell.write` | Update an initialized mutable cell through its declared lowered binding. |
| `namespace.keys` | Check exact ordered export keys and publish the result array. |
| `namespace.read` | Read the current value of the exact declared export cell. |
| `namespace.descriptor` | Publish the current scalar value with the namespace descriptor flags: writable and enumerable, not configurable. |

The public machine rejects invalid lifecycle transitions, writes to immutable
cells, undeclared names, stale values, and uninitialized reads. Shared controller
locals/capture aliases and namespace references have one cell owner. Generic
detail records, property operations, alias rewrites and compact whole-region
shortcuts cannot bypass that authority.

The active invocation's program identity selects its plan. A later program
publication cannot silently change the plan used by an earlier invocation.
Replay and checkpoint restoration retain this same program/plan binding.

## Source ownership lessons

A generated getter's GET and RETURN instructions can have the same source
range. Ownership therefore checks the operation, unique instruction/site,
getter code identity, and captured cell. A dynamic read spans property access,
getter dispatch, binding read and return; key/descriptor operations also span
continuations. The source certificate owns the complete ordered event group
and verifies the resulting value or heap object before publishing its record.

The independent observer checks reexport syntax separately from the linker.
An internally consistent, rehashed plan with the wrong export-to-cell mapping
is still invalid.

## Evidence and remaining work

The complete composed pair `4a39059/9a5b87f` passed **178 focused individual
JUnit controls, 17 source/compiler controls, 846 native controls, 40 namespace
controls and 79 companion transport controls**, all zero skips, in
[run 45002727473](https://github.com/werg/tracing-js-self/actions/runs/45002727473).
These test populations overlap and are not a unique aggregate total. The actual
original-module artifact passed source revalidation, native admission, exact
tokenizer checks and all six packed target kinds. The final artifact asset guard
passed separately at exact `5503879/b6e0bf9`: complete assets require one pass
and zero skips; absent assets yield an explicit standalone CI skip, and partial
assets fail. [Complete permanent logs, raw reports, digests and file map](evidence/v8-namespace-composed4a390-2026-11-22/README.md).

The qualified artifact has 15 packed windows and seven namespace/cell target
occurrences across 225 scored token positions, from a separate one-member
technical registry. It performs zero optimizer updates and changes no production
denominator. The exact qualified implementation is now promoted to the main PR
branches; each new main-head CI run remains a separate observation.

Earlier lint and clean-checkout failures remain retained as failures. The public
and native state agree at every one of the 23 accepted/refused transition cuts.
The actual artifact test is
[`tests/integration/test_module_namespace_artifact_packing.py`](https://github.com/werg/megatoken/blob/124fbd0d493c29af6fb7cf7965d06744e4c7bad5/tests/integration/test_module_namespace_artifact_packing.py).

Remaining work includes broader module forms and reflection, public async module
scheduling, cycles, retained/persistent sessions, larger independent source
populations, production corpus integration, actual optimizer exposure and learned
quality. Passing this bounded explicit profile does not close the complete module
work package or change the default refusal policy.
