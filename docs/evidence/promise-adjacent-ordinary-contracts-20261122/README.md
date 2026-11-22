# Adjacent ordinary Promise contract reconciliation

The historical ordinary Node 20/22/24 matrix exposed adjacent assertions that the initial focused Promise gate did not select. On exact published producer `cc0d61e98dc6252749f4a2a4c8b669d79b0f7efa`, a focused run of the three affected files reproduced **six failures among twelve actual tests**, with no errors or skips. The original complete log and JUnit are retained here. This result was checked before any local correction; it was not inferred solely from the historical matrix.

Test-only commit `b79f7ae14d6131411d04e22b122e049936dfed5e` changes the three files. The next actual run passed all twelve tests with no errors, failures, or skips on Node 24.22.3. Its complete log and JUnit are also retained. Runtime implementation, protocol payloads, native source, queue semantics, and admission scope are unchanged.

## Assertions reconciled

- Source joins require the canonical shared Promise adoption component and its source profile. Exact component ordering and complete original source replay/restore checks remain enforced.
- The recurring inventory is 66 scripts plus three modules, 69 unique inputs. All three new source goldens are named explicitly: executor adoption, async-return adoption, and reaction-return adoption. Durable cyclic input round trips remain checked.
- The original ordered 47-input source cohort remains byte-identical under hash `60fd28bdbb54bc4e144414422a8ff23caa036a573191d64857baa6cb6d6a6ae8`. It is selected separately from the three added adoption inputs and nineteen accepted conversion inputs. The original hash was not replaced. All five candidate conversion refusals remain excluded, and fresh mutable fixture input checks remain intact.
- Bare teacher projection of async adoption still refuses without the paired adoption component. The test now requires its canonical `TypeError` with category `unsupported.effectful-region-source`; it retains the original explicit-job refusal assertions for the two `finally` cases and the forwarding/FIFO tampering controls.

## Required gate correction

Separate commit `57836a4fd62e101e6dcefc86531313948b3fc0b4` changes only the gate specification and aggregate summary. It adds the actual per-file leaves from this green XML: join-source **5**, qualification population **4**, and training projection **3**. The combined verifier independently accepted this exact twelve-leaf XML. Promise requirements become **185 producer / 106 native**, and recovery remains **193 producer / 165 native**, for **649 required test leaves** overall. There are no new synthetic or inferred cases.

Runs `45045811229` and `45047889597` retain their original 637-case specifications and exact source pins. This local twelve-case proof does not turn either run into a 649-case proof. A subsequent hosted gate must qualify the expanded specification on its own exact pair. The broader ordinary Node 20/22/24 suite remains separate CI; this packet is only the focused local Node 24 result. No production fit, module admission, or learned-quality result is inferred.

The original failing log and XML are stored as gzip/base64 so their original whitespace and complete diagnostics remain byte-identical without adding whitespace violations to repository text files. Their raw and stored hashes are both recorded in the manifest.
