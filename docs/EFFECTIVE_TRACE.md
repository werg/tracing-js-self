# Effective semantic execution trace (sole training format)

The public contract is **semantic-execution/2**, with **semantic-trace/2**
and **semantic-context/2**. The Python consumer in megatoken uses the same
contract. There is no /1 compatibility reader, dual writer, or format switch.
The versioned private execution journal is independent of this training view.

## Principle: mirror the computation, not the interpreter

The training target records **the effective computation that actually
happened** in source terms: evaluated values, control choices, calls, reads,
mutations, aliases and completion. It should read like concise, checkable
reasoning about execution.

It **does not** aim for bijective reconstruction of internal ECMAScript
mechanics: prototype-chain walks, accessor descriptor flags, internal
abstract-operation phases, instruction pointers, machine stack shuffles and
whole-state patches are not model targets merely to reconstruct the engine.

**Custom prototypes, accessors and proxies are not format exclusions.**
When an independently supported guest runtime executes those operations,
a property access becomes its effective observed value. Getter, setter and
proxy-trap invocations appear as ordinary calls, with the actual executed
operations, returns and side effects. We must neither suppress those
effects nor invent a direct value where guest JS executed.

The current strict \`training-js/1\` language profile remains deliberately
bounded. A feature may still be rejected because its *runtime semantics or
independent oracle* are not yet implemented. That is a separate admission
boundary, **not** a requirement that the output format encode the full
internal method sequence. Unsupported execution must never silently run
untraced guest JS in a host runtime.

## Format

The observed prefix publishes exact source, source-site spans, code and
function identities, and an identity-preserving input graph. Dynamic records
refer to stable source sites and reflect the evaluation that occurred.

| Record | Effective observation or computation |
| --- | --- |
| \`enter\` | Invocation, receiver, arguments and captures |
| \`value\` | Produced value and any named binding updates |
| \`branch\` | Evaluated \`test\`, selected \`path\`: \`then\`, \`else\`, \`use-left\`, \`evaluate-right\` |
| \`loop\` | Executed backedge, \`repeat\`; every actual test still emits a branch |
| \`read\` | Observed property or lexical value, whether own or inherited |
| \`write\` / \`delete\` | The effective mutation; preserve aliases and absence |
| \`alloc\` | Newly allocated object, array or closure identity |
| \`call\` / \`return\` / \`throw\` | Dynamic invocation and completion (including accessor/trap calls) |
| \`carry\` | Copy a committed lexical iteration value into a fresh captured cell |
| \`await\` / \`resume\` / \`request\` / \`observe\` | Scheduling or external facts where the enabled profile supports them |
| \`end\` | Terminal execution boundary |

Each logical record is one canonical operation name and JSON fields.
The fields are operation-specific, not a free-form engine metadata dump.
The \`renderRecord\` helper gives a source-expanded view for humans using
only the observed source map.

Example source choice:

\`\`\`js
if (n > 10) { total = n - 10; }
\`\`\`

The trace says \`"test":["bool",true],"path":"then"\` (for n=12).
It does not say \`decision=false\` to mean that the VM's
jump-if-false instruction did **not** jump.

### Accessor example (illustrative target for an expanded profile)

\`\`\`js
const proto = { get total() { return this.x + 3; } };
const o = Object.create(proto);
o.x = 4;
return o.total;
\`\`\`

\`\`\`text
set &o.x = 4
call get total(this=&o)
  read &o.x -> 4
  value this.x + 3 -> 7
return get total -> 7
read &o.total -> 7
return 7
\`\`\`

This is an **illustrative desired trace**, not a claim the entire source
is currently accepted by the strict training profile. The model need not
reconstruct [[Get]], the hidden prototype walk, or descriptor attributes to
follow what computed 7.

## Correctness, causality and training

The full owned runtime journal and independent reference evidence stay in
the private sidecar. Where state fidelity matters, public records preserve
location values, stable identity, actual read/write order and source-level
control. The controller realizes committed model records, but **does not
interpret missing JavaScript or replace incorrect model values with gold
results**. Replay and internal state reconstruction are audit tools, not the
semantic *purpose* of the public trace.

A public reference trace must be consumable by the same serving controller
and agree on independently checked observable results. Local verification
does not constitute corpus admission. During training, only the observed
prefix and previously committed groups condition a prediction; future
targets and reference sidecar never enter the model context.

Model chunks and transport fragments are not guest scheduling transitions,
and a long printed line is not extra recurrence. The downstream megatoken
adapter retains the exact physical target bytes, causal dependencies,
observed/generated boundaries, and loss masks without supporting /1.
