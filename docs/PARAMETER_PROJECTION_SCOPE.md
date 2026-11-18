# Parameter initialization: bounded positive projection and remaining refusals

The owned runtime preserves parameter environments, left-to-right initialization,
the temporal dead zone (TDZ), and the separation of parameter captures from body
`var` declarations. Two additional projections use the existing public v5
records and the existing native consumer contract. Historical F receipts remain
unchanged; fresh positive native qualification requires a new published producer.

## Implicit parameter ReferenceError

Reading, applying `typeof` to, assigning to, or updating an uninitialized
parameter produces a genuine owned `GuestFault`. At that exact boundary the
runtime now materializes the existing name/message error leaf and retains its
identity through catch/finally, synchronous unwinding, and async rejection.
Private journal metadata identifies the parameter environment and name.
Independent reconstruction checks the prior uninitialized parameter, current
opcode and source site, original event, and exact newly allocated error object.
This supports the supplied case:

```js
const b = 9;
function run(a = b, b = 3) { return a; }
// Throws ReferenceError before b initializes or the body executes.
```

An error propagated through owned coercion retains its original identity.
Reconstruction separately requires the original authenticated completion and the
owning operation's previously committed completion to agree exactly. It does not
pretend the propagation event created a new error. General object-coercion
witnesses can still be refused for their existing unrelated profile limits.

This is a positive leaf for **implicit parameter ReferenceError**. It does not
enable general implicit exception projection or add a `ReferenceError`
constructor. It does not change native Error prototypes, stacks, descriptors,
causes, or extensibility coverage. Non-GuestFault interpreter exceptions,
resource exhaustion, oracle failures, and unsupported features remain distinct
failures or refusals.

## Forward parameter closure

The current public contract requires each closure capture to reference an
already committed shared cell. It has no public TDZ-cell value. The projection
therefore uses a narrowly checked reordering for this case:

```js
const b = 7;
function run(a = () => b, b = 3) { return a(); }
// Returns 3; the uninitialized parameter shadows the outer b from entry.
```

The private execution first creates the closure. The projector freezes its code
and lexical environment/name identities, but withholds both its public allocation
and the parameter write that references it. Until the captured parameter really
initializes, only these operations may occur in that same frame and exact
parameter environment: default guards, scalar literal materialization, private
jumps, and initialization of still-uninitialized parameters. Only frame and
parameter-environment mutations are allowed. No intervening guest reads, calls,
effects, other allocations, exceptions, jobs, or checkpoints may cross this
region.

Once every captured cell has actually initialized, the projector uses the current
committed values, emits the closure referencing those shared cells, and publishes
its deferred parameter write. It never uses the final heap, the later body value,
an outer shadowed binding, or an invented `undefined` TDZ sentinel. The private
certificate retains the original allocation event, the complete intervening
event chain, fixed capture environment/name identities, and the actual
initialization boundary. Source rechecking regenerates the same projection.

The resulting public prefix binds `b` to 3, allocates the closure capturing that
cell, and binds `a` to the closure. Later `b = 5` is visible through the capture;
later `var b = 5` creates a separate body binding and leaves the capture at 3.
Aliases established after initialization retain the same closure and cell.
A provided object can be captured after parameter initialization while retaining
its already observed identity and subsequent mutations.

The following remain explicit projection refusals:

- An early call or read such as `run(a = () => b, b = a())` or
  `run(a = () => b, c = a, b = 3)`.
- An intervening effect, guest call or exception, object allocation in a later
  default, or another pending closure.
- A capture that depends on its own unpublished closure or mixes the deferred
  parameter with an uninitialized lexical capture.
- An unresolved closure at a final snapshot or any ambiguous operation outside
  the allowlist.

Supporting those cases generally requires a separately specified public TDZ-cell
contract or a broader proven projection. They are not silently converted into
positive examples. These changes run no optimizer or model evaluation.
