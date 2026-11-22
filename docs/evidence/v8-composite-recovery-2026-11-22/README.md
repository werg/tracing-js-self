# Composite coordinator and child recovery

The bounded ordinary orchestration driver can pause at a declared quiescent cut and restore through a fresh native process. Its packet binds original coordinator/child selections, exact causal contexts and source ingress, native replay operations, bootstrap/join/completion receipts, stale rejections, and consumed active timeout. The verifier restores the host bridge with the caller's live clock and requires a native restore receipt with zero host dispatch before executing new work.

The focused driver/checkpoint suite passed **19/19**. The combined process, transport, driver and checkpoint suite passed **34/34 with zero skips**; the smaller count is a subset, not additive evidence. The stale positive control causes an actual host preflight conflict, rejects the original native selection, retries its exact bytes, and verifies fresh-process restoration of that history. Full logs are archived with exact byte counts and SHA-256 hashes in `manifest.json`.

The mandatory paired gate now includes `semantic-native-orchestration-recovery-v8.test.js`, backed by the real Python production adapter and shared runtime from native commit `9a189f6e1fa133134591f69f2cf412bd8289f73a`. Its deterministic lexical fixture proves engineering recovery only. It has been syntax checked locally; Torch is unavailable here, so its actual hosted execution is pending. No model-quality result is claimed.

Durable automatic history, `restoreLatest`, terminal checkpoints, and dynamic descendant support remain unfinished. These tests do not promote defaults or complete any of the 17 cutover work packages. Source-session composition and the separately declared production behavior cohort remain separate work.
