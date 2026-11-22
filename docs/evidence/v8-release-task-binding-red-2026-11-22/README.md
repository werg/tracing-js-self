# Original task to artifact substitution: retained red control

The release snapshot at published producer `596a3b8e61011dcfd38fcf28ff5bef4cb6242975`
(`tools/verify-v8-release-campaign.mjs`) accepted a deliberately incorrect mapping
between two original frozen source tasks and their returned evidence.

The control used the original 64-task population and all original source,
admitted and native artifact bytes from the retained primary-fit archive:
175,381,869 bytes, SHA-256
`6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af`.
Its producer was `9cf091e6ccc5add960ef0897576d0c391b199a65` and native consumer
`1a69d9da3254b7568c831d12866a629c206cf4fe`. This audit does not alter or reseal that
original archive.

`reproduce.mjs` constructs two explicitly synthetic, internally consistent
journals using the original frozen tasks and authority. The positive retains
the original mappings. The negative swaps the source/admitted/native files
for `se-support-rectangle-perimeter-pure` and
`se-support-rectangular-capacity-pure` under their claimed original filenames,
updates each row's native receipt to match the copied receipt, and records the
result through the ordinary hash-linked campaign writer. The population,
selection, registry and every individual source artifact remain byte-exact.
The original complete set of 64 unique source IDs is unchanged.

Both snapshots returned `verified`, 64 source-qualified and 64 native-admitted.
In the negative, the task source `return (a+b)*2` was mapped to an artifact for
`return a*b`, and vice versa. File hashes, journal consistency, source ID
uniqueness and fresh replay of each artifact's own source cannot prove the
missing relationship to the originally selected task.

The log and results retain the observed false positive. This control proves
the snapshot boundary gap; it performs no new native admission, checkpoint
load, decoder pass or optimizer update. It does not claim a complete forged
package has been accepted. The currently running hosted package/restore gate
can establish mechanics for its frozen pair, but cannot close this acceptance
gap until the original task to artifact relationship is checked directly.

To reproduce, extract only top-level `v8-admitted/` files from the independently
verified original ZIP into an `original-assets` directory and copy
`v8-admitted/progress/campaign.json` there as `original-authority.json`. Run:

```sh
node reproduce.mjs /path/to/frozen-producer /path/to/original-assets /new/existing/output-parent
```

The script requires the two child campaign directories to be absent. Full
snapshot inventories are written beside the two result files; the original
archive remains the source of the exact asset bytes.
