# Reserved settlement job extra-field review

This archive retains the exact targeted reproduction, the stdout captured from
the original tool result, the command, and the native dirty diff/source metadata.

The reproduction injected `readySequence: 1` into the reserved settlement job
and called `validate_protocol_state`. At that execution point, the validator
accepted the extra field. The captured stdout is in
`captured-toolstdout.log`; the script and command are
`reproduce_extra_reserved_field.py` and `original-command.txt`.

Provenance caveat: the source hashes and dirty diff were captured after the
original reproduction, not before it. The original raw stdout existed only in
the tool return and was copied verbatim into `captured-toolstdout.log`; no
timestamp was added. No rerun was used to recreate this pre-fix result.
