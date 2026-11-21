# Retained callback code identity

A callback invocation with a retained closure must enter the same immutable
function site recorded by that closure. An observed entry name is not authority
to execute another function with the retained closure's captured cells.

Both `entry` and the closure's `code` resolve against the immutable program's
function inventory. Each must resolve to exactly one site, and those sites must
have the same source start. An unambiguous declared name and its `function:start`
spelling may identify the same function. Duplicate-name ambiguity refuses even
when the other spelling is precise. A missing entry derives from the retained
closure, before the program's ordinary entry is considered.

Admission checks this invariant before importing input graphs or changing realm,
invocation, ingress or timeline state. Closure-backed event registration applies
the same rule before storing/publishing the handler and verifies its source
revision against the retained realm. Ordinary calls without a closure retain
their existing entry behavior.

The paired native consumer independently resolves these identities from its own
program and heap state. This closes a demonstrated malformed-prefix acceptance:
replacing a callback entry with `run` previously paired `run`'s parameter/frame
metadata with a different function's captures. Public replay and checkpoint
restoration now encounter the same refusal. Tests retain valid name/site aliases,
refuse ambiguous or substituted sites, and compare the entire checkpoint before
and after invalid admission.

The recurring qualification population also includes original return-callback
source cases (receiver/argument cycles and capture cells, throw, async return and
reentrant host work) and two original synchronous module graphs. The population
contains 44 scripts and 2 modules. Independent native admission and complete cost
measurements must be collected at each published pair; adding a fixture does not
constitute admission or model evidence.
