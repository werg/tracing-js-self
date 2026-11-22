# Source-owned async-module lifecycle evidence

The exact candidate producer `83e0475e360cacbe82e66d92889094909a42347b` and native consumer `385b830b8744d39fa5847b58f82dd0eceb3656ee` passed [run 45007870400](https://github.com/werg/tracing-js-self/actions/runs/45007870400), job `137163411013`, on 2026-11-22. `complete-success.log` retains the complete job output, including the two complete machine-readable evidence records.

The job passed **40 Node tests and 6 native Python tests, with zero failures or skips**. All six new original ESM scenarios produced independently observed lifecycle order and exact source-owned cuts, then applied those same cuts in the actual Python controller. The evidence reports **64 uniquely owned lifecycle transitions**. These counts describe the module lifecycle cuts; they do not claim ownership or public projection of every runtime event.

The source controls cover already settled rejected awaits caught by the module, nested awaits and cleanup, synchronous shared dependencies, syntactic top-level await that does not execute, failure before the first await, failure after an await, sibling progress, and downstream rejection. Fresh linker/compiler identity, dependency identities, frames, promises, and exact completion callbacks determine the cuts. Mutated source/dependency/bytecode inputs refuse. Synchronous modules retain a null execution Promise.

The gate reports `publicAdmission: false`, `trainingAdmission: false`, and `optimizerUpdates: 0`. This proves source-to-state correspondence for the bounded DAG, including actual native state parity. It does not add module scheduler records to the public V8 selector, packed target admission, cycle handling, dynamic import, or a learning claim. Shared generator/Promise composition and nested async call scheduling remain separate work.

