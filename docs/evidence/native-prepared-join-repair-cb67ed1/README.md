# Repaired candidate/task join against original native preparation

This local regression replay reads the unchanged hosted engineering evidence from producer `cb67ed15750760267d1bb6edd53b4190d349885c` and consumer `272584270a00409cee6c7c49078c775faf24d16b`, from [run 44384520028](https://github.com/werg/tracing-js-self/actions/runs/44384520028). It tests the new stream reducer and complete inventory join against an actual failure case.

The original 190,433,742-byte native audit, prepared index and deduplication database reconcile to 25 accepted examples: 19 training, two validation and four test; no native exclusions or upstream omissions. Candidate `repeated-ingress` correctly retains native task ID `async-counter`. These identities have distinct meanings and are joined through the original admission and public-episode identities.

The audit streamed in 4.05 seconds with peak RSS of 129,601,536 bytes for this one replay process (about 124 MiB). This is a measured process-memory value, not aggregate resource enforcement or a qualified runner.

The original replay receipt and compact audit proofs are retained unchanged. Their input checksums bind the historical files, and the receipt binds the proof stream. The repair code was in the working tree when this local replay ran; this is not a clean-checkout native qualification. Complete source/native reconstruction, encoded token/mask checks, larger recipes and optimizer consumption remain separate checks executed by the maintained CLI and its hosted workflow. No optimizer update or model result is claimed here. Historical source, native and split receipts were not modified.
