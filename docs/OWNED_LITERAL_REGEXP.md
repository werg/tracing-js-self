# Bounded literal RegExp operations

The owned RegExp implementation accepts nonempty literal patterns of at most
256 UTF-16 code units, with either no flags or the `g` flag. Regular-expression
metacharacters, escapes, and line terminators remain outside this literal
profile. The existing explicitly pinned scanners remain available separately.
Matching uses owned ordered string searches, without delegating guest matching
to the host RegExp engine. Global matches do not overlap.

`test` accepts strings up to 10,000 code units and bounded integer `lastIndex`
values. Global tests advance `lastIndex` to the match end and reset it to zero
on failure; non-global tests preserve it. Global callback replacement collects
at most 1,024 matches before executing callbacks, resets `lastIndex` to positive
zero, and preserves any subsequent writes made by those callbacks. Callback
arguments contain the actual match, UTF-16 offset, and original string.

The source and public replay regressions include the frozen replacement
interaction, repeated matches, no matches, overlapping candidates, Unicode
literal data, callback writes and throws, and restoration during replacement.
Unsupported syntax and exceeded work limits remain explicit refusals. These
engineering checks do not by themselves claim native or model qualification.
