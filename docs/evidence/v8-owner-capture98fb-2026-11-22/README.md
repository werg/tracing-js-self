# First actual scheduler owner capture

Producer `98fb8d51dd8abf26941247808629b15486868d9d` passed one exact owned-runtime capture and replay control, zero skips, in [run 45008799452](https://github.com/werg/tracing-js-self/actions/runs/45008799452), job 137166257530.

The complete log includes 24 original events and the terminal audit snapshot. They establish separate generator-body, async-driver, awaited-Promise and completion-reaction identities; synchronous modules have no execution Promise. The terminal snapshot is diagnostic context, not event-time source authority. The successor capture retains exact definition/allocation events and every subsequent record mutation and removes terminal-state authority.

This is isolated evidence only: no public/native scheduler admission, production denominator, learned result or automatic recovery claim.
