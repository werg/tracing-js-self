# Main 134 and e528 verification checkpoints

Full unabridged logs are preserved here.

- Producer `134a832` / native `e9817ad`:
  [run 44994305376](https://github.com/werg/tracing-js-self/actions/runs/44994305376)
  passed all four populations: original 665, interoperability 66, gallery 11 and
  support 64. The four `main134-*-pass.log` files retain each complete lane.
- Producer `e52855c485232f3468828dc56876cdf2b602582c`:
  [focused run 44999248539](https://github.com/werg/tracing-js-self/actions/runs/44999248539)
  passed 141 individual controls; [installed run 44999248522](https://github.com/werg/tracing-js-self/actions/runs/44999248522)
  passed all 665 original and 66 interoperability sources.
- Exact `e52855c/e9817ad` paired
  [run 44999248481](https://github.com/werg/tracing-js-self/actions/runs/44999248481)
  has completed its interoperability, gallery and support lanes successfully.
  Their full logs are retained here. The original-source lane was still running
  at this checkpoint and is not included in these passing results.

Each population has its own denominator. Ordinary support and interoperability
optimizer/resume/export/restoration routes are retained in their lane logs;
they are distinct from source, admission and packing eligibility. These small
lifecycle runs do not establish full target exposure or learned quality.
