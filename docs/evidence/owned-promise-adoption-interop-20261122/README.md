# Promise adoption interoperability refresh

This follow-up regenerates the six paired fixture payloads and the contract
after the initial producer implementation `2a6ce9ff653dc99ce05d17bcc591ab202d8a4a8e`.
It also makes the new scheduler guard tolerate a minimal non-Promise component
controller without a jobs/ready table. Actual adoption still requires the full
controller scheduler. The existing machine and iterator fixture generators
check or reproduce their declared bytes after that guard correction.

All existing 20 source examples were independently regenerated and rechecked.
Three new source examples exercise the new protocol within the same fixture
bundle, taking that source interoperability list to **23**:

| Example | Protocol records | Compact regions | Detailed records |
| --- | ---: | ---: | ---: |
| Executor resolves to an owned pending Promise, then ignores reject | 12 | 1 | 26 |
| Scoped async function returns an owned Promise after suspension | 9 | 0 | 21 |
| Reaction returns an owned Promise | 9 | 0 | 26 |

The four mixed host/protocol examples and six region examples were also rebuilt
and independently source-rechecked by the existing generators. The full
interoperability manifest now has 35 entries. This is an interoperability
fixture expansion; it does not alter production family, data, target, training,
or optimizer denominators.

Exact shared identities:

- Definition: `fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`.
- Interoperability: `b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`.
- Refusal fixtures: `56f7f36d3b25b3b11a208be3de337e637b9782e6759faea1e1ec107b0a90f0ce`.

`payload-map.json` identifies all seven native destinations: the contract and
six fixture payloads, including the exact encoding, byte counts, Git blob IDs,
and SHA-256 hashes. JSON fixture compression uses gzip with timestamp zero.
Native implementation/replay and the exact hosted paired gate are still pending
for this increment. The production admission policy remains fail closed until
the matching native source is published and pinned. The earlier initial bundle
retains its original scope and its explicit unconfigured-native skip.
