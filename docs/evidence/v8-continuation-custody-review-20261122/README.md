# Independent review of the completed continuation archive custody

The successful original step314-to348 continuation has durable custody in
unpublished draft release `454593314`:
https://github.com/werg/tracing-js-self/releases/tag/untagged-d0396035653d8f600ab0

Its uploaded asset `779733613` is the byte-original Actions artifact
`14763057413`: **374,757,456 bytes**, SHA-256
`c89b297625afe95bff6b378d4338d31e8f45c766ad86ee28350d08822bf22f1c`.
The intended named tag remains unpublished; the returned draft URL above is the
observed release location.

Successful [custody run 45045362800](https://github.com/werg/tracing-js-self/actions/runs/45045362800),
job `137278687672`, used source
`5dba7174b6f42d4dc6a22e794b9924b9fe5114c0`. Its preservation step uploaded
the original archive, downloaded the saved release asset again, and measured
the same byte length and SHA-256 before issuing its verified receipt. Release
receipt asset `779734535` and Actions receipt artifact `14763835548` retain the
custody result.

This review read the existing release/artifact metadata, exact workflow and
implementation, and complete hosted job log. It did not upload or download a
second large ZIP, perform optimization or rerun training. `review.json` states
that read-only verification boundary. The full decoded hosted job log is stored
losslessly in `complete-job.log.gz`; its original 24,118 UTF-8 bytes have SHA-256
`726d794aa5fadc01aa6124481fab1a789d852563b319b9923d32ea1379bbb0a2`.
`files.json` records the stored evidence hashes.

The original interrupted campaign, completed continuation and separate expanded
fit remain distinct artifacts. This custody record preserves the continuation
result; it does not add optimizer updates, qualify learned behavior, export the
348-update weights or change a production default.
