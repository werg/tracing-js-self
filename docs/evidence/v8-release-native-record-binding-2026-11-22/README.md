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

## Correction and observed outcomes

Source correction: local `ce8e03fe5284f3c76df95a94cfceaab174a50b9e`, tree
`1d3a3a7b04314efc343aeef21bfc06df16452d53`. The helper now checks the complete
allowed admitted-copy transformation and binds each recorded receipt to the
original source's exact native transport bytes, public/context/source/dataset
digests, source and consumer revisions, tokenizer and teacher transcript.
Source-validation flags retain their boolean types. The checks apply to every
historical native-qualified attempt before deriving current membership.

The unchanged original packet passes with 64 source-task bindings and 64 native
record bindings. The exact preserved negative packet refuses with
`recorded admitted artifact differs from the original task source`; its journal
remains byte-exact. The snapshot performs no fresh native or source execution.
`fixed-packet.json` and its raw log record those outcomes.

The complete producer control set passes 69 executable leaves, zero failures,
errors or skips (`fixed-node.xml`); Node's reporter includes 12 parent
containers and displays 81 tests. Ten added executable controls cover another
source's admitted copy and coherently resealed public/source/dataset/native
input hashes, producer/consumer/tokenizer pins, boolean validation flags and
unrequested teacher claims. The earlier 59 controls and their original logs
remain independently retained.

This correction preserves recorded correspondence. It does not authenticate
an unsigned historical journal or turn its receipt into fresh semantic
verification. Package and restore still require independent source replay and
native preparation from trusted external checkouts. The original 596a3b8e
hosted run passed mechanics; the separately frozen 790f525c candidate checks
task binding but predates this additional native-record check. Final composed
release qualification must use the later source and its own exact pair.
