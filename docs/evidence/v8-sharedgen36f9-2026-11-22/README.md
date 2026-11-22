# Shared generator and Promise source composition

The isolated source composition gate completed successfully on 2026-11-22.

- Producer: `36f9dd7bcd53ed1e92e8bc8a1b8289da7a33e1d3`.
- Independent native consumer: `385b830b8744d39fa5847b58f82dd0eceb3656ee`.
- [Actions run 45009126350](https://github.com/werg/tracing-js-self/actions/runs/45009126350), job `137167273194`.
- Full job output is retained in [complete-success.log](complete-success.log).
- All 49 generator, Promise executor and shared composition controls passed, with zero skips. The existing 40 original ESM and source-owned scheduler controls and six independent native scheduler controls also passed with zero skips.
- Six original shared generator source cases passed fresh independent source qualification, public replay, checkpoint continuation and actual Python replay of every generated context: 189 contexts total.
- The cases cover initial declaration, suspension, completion and Promise reaction; injected rejection caught before cleanup suspends; live captured cells across Promise suspension; generators without yields and completed resumes; abrupt return before first resume; and uncaught generator rejection unwinding the exact executor.

The public generator shares one existing controller, heap, capture cells, guest frame identities and event ownership transaction with Promise source components. This gate does not admit evaluated module records or training rows. `moduleAdmission=false`, `trainingAdmission=false` and `optimizerUpdates=0` are enforced in the hosted evidence. Nested async helper calls and shared yield delegation remain refused at this exact revision; later work must qualify its own producer/consumer pair.

Both checkouts were verified clean after the complete gate. Production native policy pins, existing fixture populations and training denominators were not changed by this experiment.
