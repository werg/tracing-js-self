# Experimental namespace qualification checkpoint

This is evidence for isolated engineering gates, not main-branch namespace admission.

- Exact producer `d762793bedfc1cbadab78e2e786eb2ec34717b99` passed **14 source, private-owner, real original ESM worker, direct-entry tampering and synchronous-profile controls**, zero skips, in [run 45000628175 / job 137141160431](https://github.com/werg/tracing-js-self/actions/runs/45000628175/job/137141160431). The complete log is retained.
- Exact producer `17ace16ac169a0953b5687cb7a73e0e3af97f5de` / native `449838503e19068bccf1ed461c1dac03c444d9fd` passed **46 native controls** (45 namespace tests plus the exact clean-consumer admission CLI control) and **75 companion transport cases**, zero skips, in [run 45000154070 / job 137139702258](https://github.com/werg/tracing-js-self/actions/runs/45000154070/job/137139702258). Its full log also retains the three source-owner/admission failures before the d762 correction; the overall run was not green.
- Earlier producer `c6a52f0` / native `d8aed03` passed **845/846** native controls; one exact-clean-checkout admission case failed because the workflow reformatted an import before the test. The exact formatted import was committed at `4498385`; the correction is tested above without modifying either checkout. The original complete failure log is retained.

The source path freshly relinks original modules, binds the actual arguments and public namespace plan, reruns real original ESM, compares its outcome and ordered namespace/cell observations with the owned projection, and rechecks that authority on direct entry. Generated getter creation/read/return events have exact instruction/site ownership. Namespace object creation rows are canonical identity publication before source evaluation, not a claim about observable ECMAScript allocation timing.

Scope remains a bounded synchronous scalar namespace profile. Dynamic/async imports, jobs, function-valued namespace exports, arbitrary reflection, ownership escapes and compact-region execution remain outside this gate. Broader source/native module profiles and all 17 complete acceptance packages remain open.

Next required gate: emit the real source-qualified artifact, bind it to a separate one-member technical registry, require pinned independent native/source rechecking and the real tokenizer, then reload and inspect all six operation kinds in actual packed targets. This technical fixture does not modify production populations and performs zero optimizer updates. Its first execution is pending after this checkpoint.
