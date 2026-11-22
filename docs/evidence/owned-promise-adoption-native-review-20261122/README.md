# Independent Promise consumer review before qualification

The first native increment was published as
`5c964c1c30b3b87c5f11913be9afc2a1efecc94f`, exact tree
`a0908f39311297f095ba8dc9ef8a9bd6b3505362`. A separate clean checkout of
that exact tree reproduced three discrepancies with the producer:

1. An owned Promise with an explicitly null prototype could be adopted. The
   bounded intrinsic-then profile requires the unchanged prototype lookup.
2. While Promise P had a required next resolution intent, an enqueue for fresh
   unrelated Q could proceed and leave P's intent unconsumed.
3. A restored assimilation job could carry an extraneous field, despite the
   producer's exact canonical job shape.

The retained script and JSON reproduce those direct transition/restore
acceptances. These are native public-machine defects; this evidence does not
demonstrate bypass of the independent complete source-admission pipeline.
The producer already rejected them, and its tests now state the unrelated-P
and extra assimilation/forwarding-field cases explicitly.

Actual source integration found a distinct legitimate continuation refusal:
the native enqueue guard required a nonempty stack after a detached async body
had completed and popped its frame. The first integration suite had 19 passed
and one failed leaf, zero skips; a per-source diagnosis passed 13 of 14 and
identified `nested-async-receiver` as the refused case. That diagnostic used
the initial native implementation with the new interoperability assets copied
into its worktree. It is not an immutable full-tree qualification result.

A two-invocation public control then exposed another restore refusal: shared
heap adoption state owned by the first invocation was rejected while restoring
the second invocation's protocol controller. The clean first native tree
reproduces this failure. The producer control retains both controllers and
forces an earlier second-owner job to run before adoption forwarding, then
checks JSON restoration and actual native replay of both owners. This control
has 19 generated contexts; it is a public-machine control, not an independently
compiled original-source family.

Corrected native `03a9e33866207b5b0c4105297c6050dacadcf85f`, tree
`0531e702beb88c5421907d6c41d078169ccd00b5`, contains the corresponding
refusals and shared-owner validation. Its guard binds an immediate intent to
the current owner's exact Promise and target, and its canonical job validator
rejects extra fields. Foreign shared-heap rows retain common shape/settlement
checks; local cause and job tables are validated by their actual owning
controller. An already bound completion can enqueue after detachment without
inventing an active frame.

The exact pair still needs the full frozen local and hosted suites. Working-tree
green diagnostics do not replace those results. A separate older boundary
remains explicit: sharing executor resolver closures across invocation-specific
executor aggregate state is not qualified here. The retained two-owner control
uses the scoped async completion owner, and does not imply broad cross-invocation
resolver capability support.
