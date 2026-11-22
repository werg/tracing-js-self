# Preserve and repair the native Promise formatting failure

[Native CI run 45045095235](https://github.com/werg/megatoken/actions/runs/45045095235)
failed at `ddda9a7339297e6074765a001743e2bb569e0eb9`. Both CPU jobs,
`137277861885` (Python 3.11) and `137277862180` (Python 3.12), passed Ruff's
code checks and then failed its formatting check. Ruff 0.17.6 reported eight
Promise files requiring formatting. The later package build and complete CPU
suite did not run in these jobs; their missing artifacts are not test success.

Both complete original decoded job logs, the original run and job metadata,
and exact hashes are retained. Decode `.gz.b64` files with base64 then gzip.
The preserved logs include the full formatter diff and the original failure;
they have not been replaced by a successful rerun.

Local fix `38305a3c1dff10a860e11a102bd9c3b2909104ea`, tree
`6133665850b80b40adb7e4682e24d0aea3032101`, applies that same formatter only
to those eight files. Its local parent `6f64ce0a26644c39079f7be71c841ee6d551f5b4`
has the same tree as the failed published native revision. The AST of every
changed file, including type comments and excluding source coordinates, is
unchanged. `format-ast-proof.json` binds every before/after Git blob and its
common AST hash.

The exact required local lint commands then passed: `ruff check src tests
scripts`, `ruff format --diff src tests scripts` (626 files already formatted),
and `bash -n src/megatoken/cloud_bootstrap.sh`. The complete local output is
`required-lint.log`; the applying formatter's output is also retained.

This change preserves behavior and assertion populations. The eight source
blobs and resulting wheel bytes have changed, so the earlier installed-wheel
proof and combined run `45045811229` remain explicitly before this formatting
increment. The updated native policy pin still requires its own exact hosted
qualification. No wider source profile, optimizer exposure or admission claim
is inferred from formatting or lint success.
