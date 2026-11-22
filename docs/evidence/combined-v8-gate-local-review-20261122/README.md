# Local review of the required combined gate

Gate source commit `88fad55d0af478d4dfb6742b589bd7a992d184e7` adds three
files: the six-lane workflow, its exact per-file case specification and the
verifier. These files do not change Promise or recovery execution semantics.

The required populations remain separate: recovery has 165 native cases and
five producer lanes of 123, 33, 9, 12 and 16 cases (193 total). Promise has 106
native and 173 producer cases. The verifier consumes real JUnit testcase leaves,
requires each named file's exact count, rejects duplicate/unnamed leaves and
fails on any failure, error or skip. Its parser accepted eight original
downloaded groups from runs `45042073863` and `45042386283`; separately changed
copies containing a skip, duplicate leaf, missing file identity or unrelated
file identity all failed. These parser checks preserve the original 167/104
Promise counts and do not claim the later 173/106 composition has run.

The workflow was also reviewed for expression and artifact handling. Job-level
environment values use `github.workspace`; `runner.temp` appears only in step
inputs. The aggregate job uses `always()` and explicitly requires
`needs.paired.result` to equal `success`, so a failed or cancelled required
matrix lane cannot become a skipped aggregate success. Uploads have one root,
including the nested native wheel, matching the six download directories.
Aggregation rechecks raw XML, retained file hashes, source packets, and exact
producer/native revision and tree, policy bytes and gate specification.

## Actual installed consumer probe

A wheel was built from local native composition
`c91677525f25b9ba05e9d4a856cdad48d48af0ea`, whose tree
`85245d6cc3c95fb9d339c53bb54e4b66872bd8da` is the published candidate
`eb758da9f1f6e6cca90ba7f4a3c9d4e70753bb0c` tree. The wheel has 1,397,150
bytes and SHA-256
`16c46cddd8c52d96c8bd8c5b551c261bb8b42e94851b8b2b7c86f58db9263bdd`.
It was installed into a separate local environment, leaving the shared testing
environment unchanged.

The verifier ran under Python `-I`, with the checkout import path disabled.
It imported the installed wheel, compared all **267 tracked Python modules**
byte-for-byte with the native checkout, compared the installed contract bytes,
and actually replayed all **23 canonical source fixture artifacts**. Every
replay, context and continuation check passed. The resulting package file hash
is `89c15059fee84f11e9fd7fc351af066d74cb39c497b90d972509840aef984f06`.

`original-installed-wheel-receipt.json` retains the complete first probe
unchanged. `installed-wheel-review.log` records a second complete probe with
the same result and all per-source checks/counts. The native receipts explicitly
retain untested source-binding, mask and tokenizer checks. Independent source
rechecking is a separate required workflow step; installed replay alone grants
no admission or learned-quality claim.

The test helper also accepted the four retained Promise source packets and the
separate two-owner shared-realm packet, checking actual context arrays against
their named native receipts. These are local verification of the gate and its
installed-wheel path. The final policy pin and composed producer revision must
still complete the new hosted workflow; no local whole-pair qualification is
inferred from this packet.
