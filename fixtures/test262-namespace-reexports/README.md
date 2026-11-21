# Original namespace reexport controls

These six JavaScript files are unchanged bytes from `tc39/test262` revision
`d53ebc8b1931d9f1541e43d59650776e4b766248`. Their original directory, Git blob
identities and byte counts are retained in `snapshot.lock.json`; the upstream
BSD license is retained alongside them.

The two tests and four dependency modules exercise ECMA-262 17.0 `ParseModule`
step 10.a.ii: exporting an imported namespace binds the namespace of its target
module, exactly as a direct `export * as` declaration does. Multiple star paths
to that same namespace are unambiguous.

The controls verify source-only resolution and execute the original test bodies
with owned validation and exact replay. Their `typeof foo` observations are
supported when the source binding proves that `foo` is an imported namespace;
this does not permit the namespace object itself to escape.

Node 24.22.3 / V8 13.6 still rejects these graphs while linking. Tests retain that
failed independent reference result explicitly. The original cases have no
public/native admission, dataset admission, or edition-wide conformance claim.
Separate owned static-read controls exercise the corrected namespace origin
through live exported cells, while a native-agreeing namespace `typeof` graph
has its own source/public and fresh-recheck controls.
