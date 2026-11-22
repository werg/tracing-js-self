# Nested async source calls and independent native state

The isolated paired gate completed successfully on 2026-11-22.

- Producer: `fa8eeee2ae7643d541c50e6ebda41aabdb811688`.
- Independent native consumer: `fe563c1fa8e11a73f59af53c59da97e553b26fa3`.
- [Actions run 45011261678](https://github.com/werg/tracing-js-self/actions/runs/45011261678), job `137173882156`.
- Full job output is retained in [complete-success.log](complete-success.log).
- 95 independent native scheduler and async composition controls passed with zero skips.
- 40 original ESM and source-owned scheduler controls, 49 generator/Promise composition controls, and 18 nested async source controls passed with zero skips: 107 Node controls total.
- All ten original nested async source cases passed fresh source qualification and recheck, public replay and JSON continuation recovery. Actual Python replay checked every one of their 231 generated contexts and compared their final shared states.
- Six shared generator cases also replayed all 189 contexts natively; six original module lifecycle cases retained 64 uniquely owned cuts. These are distinct populations, not production fixture additions.
- Canonical producer generation was checked without modifying either checkout. Both public contract copies match digest `f92c2b99bcd373eadaadf2fa425af6b866c4312a18c6ff62b74743c40ab19f3c`. The existing six interoperability example payloads retain digest `f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661`.

The public protocol makes the actual execution Promise own its child source frame. First suspension restores the caller's receiver and capture aliases while the caller keeps any active reaction job. Subsequent resumes require the exact ready continuation, settled dependency value and shared-realm FIFO turn. Child completion settles only its own execution Promise. Independent native transitions implement these rules without importing producer code.

The tests cover immediate and delayed fulfillment/rejection, a rejected await caught within the child, sibling FIFO, repeated awaits, method receivers and mutated live captures, children started inside a reaction job, nested children, ordinary reference results and a generator yielding a child execution Promise. Adversarial controls cover wrong active turn, Promise, invocation or settled input; generic completion/settlement bypasses; changed restored receiver/captures; rehashed completion forgery; duplicate source ownership before preparation; and rollback after observer failure.

This exact candidate retains explicit refusals for async Promise callbacks, Promise-return adoption, thenable assimilation and shared yield delegation. It does not grant evaluated-module or training admission: `moduleAdmission=false`, `trainingAdmission=false`, `optimizerUpdates=0`. The production module gate, native policy pins and training populations were not changed. The later private-context staging optimization and 707-record original-module engineering probe are separate work and are not claimed by this run.
