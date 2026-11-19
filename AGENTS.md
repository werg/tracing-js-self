# Agent guidelines

## Pre-release development

This repository and its paired consumer, `werg/megatoken`, are pre-release.
Nobody depends on compatibility with the current implementation or saved formats.

- Make the smallest direct change that solves the problem. Change APIs, formats,
  schemas, and implementations in place when that is the quickest sensible path.
- Do not require version bumps, migrations, compatibility shims, deprecation
  periods, or a format-release process. Existing version labels may stay in place
  while their definitions evolve. Do not make versioning a blocker for a PR.
- Update affected producers, consumers, tests, fixtures, and examples together.
  Regenerate affected artifacts when necessary; do not preserve an obsolete
  format merely to keep old generated data working.
- Keep correctness checks and honest evidence. Historical results describe their
  recorded code and inputs; they are not proof that a later change works.
- Save authorized work in small commits and push completed increments promptly.

These instructions supersede older repository guidance that requires version
bumps or compatibility work during this pre-release period.
