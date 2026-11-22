# Recorded native admission must refer to the original task's source

The task-binding source published at
`790f525c280b34a66ef8269aa7148bd9966b8639` correctly refuses a wrong source
artifact for the original task. An additional retained red control found that
its snapshot still accepted an inconsistent historical native claim: keep
all 64 original source files and tasks unchanged, swap only the original
`*.admitted.json` and `*.native.json` pairs for rectangle-perimeter-pure and
rectangular-capacity-pure, then reseal the synthetic journal with those native
receipts. The snapshot returned verified with 64 native-admitted rows even
though each swapped receipt's public digest named the other source.

This is a historical correspondence gap. The independent fresh native
preparation still processes the correct source artifact at package and restore;
the control does not demonstrate bypassing that semantic check.

`reproduce.mjs` is the original task-binding red reproduction with only the
admitted/native pair substitution changed. It takes the same extracted inputs
documented in `../v8-release-task-binding-red-2026-11-22/README.md`. All source,
admitted and native bytes come unmodified from the retained 175,381,869-byte
primary archive (SHA-256
`6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af`).
The original archive and its 64 source files are never rewritten. `red.log`
and `red-result.json` retain the observed false positive. No optimization,
decoder pass or fresh native admission occurs in this snapshot control.
