# Complete installed population and callback continuation correction

The exact `347c0ec` installed workflow completed every case: **665/665 original
cases passed; 64/66 selected cases passed**. The failed cases were
`callback-owned-join` and `callback-owned-join-awaited`. The prior locked-tarball
cache correction succeeded. This run is still failed, not a full installed pass.
The complete job log is permanently retained here. Its separate 644,556,518-byte
Actions archive has 30-day retention and an upload-reported hash; it has not been
downloaded or independently verified locally.

Both failures were reproduced using the unchanged committed worker from
`3a17cefb47849c7037166f00b6ea48ee2f5bdd7e`. A live callback-end selection correctly
publishes the generated end followed by its observed handler-close receipt in
one synchronous batch. The qualifier compared only the last emitted row with
the expected generated row, incorrectly treating the valid consequence as a
mismatch. No semantic runtime change or private replay flag is required.

The correction compares the complete batch with the exact corresponding saved
public suffix, checks nonempty/bounded output, and advances past every verified
row. Reordering, missing rows and extra rows still fail. Live `select` and
`importObserved` remain the public continuation path after JSON restore.

The complete focused tooling selection passes **9/9**, zero skips, including
both callback variants and the existing source, module, package, cache and
integrity controls. It overlaps the earlier eight tooling controls. The initial
local reproduction command's incorrect import is retained separately as a setup
error; it is not evidence of a product failure. Full fresh665/66 installed
qualification remains required on the corrected committed worker.

Reproduce the passing selection with:

```sh
node --test --test-reporter=tap test/semantic-installed-qualification-v8.test.js
```

`SHA256.json` records exact run identities, all complete logs and encoded/decoded
hashes. These are source/public/recovery engineering checks, with no independent
native admission or learned execution claim.
