# Locked current-v5 native environment

The lock targets CPython 3.12 on Linux x86_64 and CPU PyTorch. The exact
qualification runtime is in `profiles/release-environment.lock.json`. GPU
training requires a separately qualified CUDA environment; this lock makes no
GPU memory-fit claim.

```sh
python3.12 -m venv .cache/native-venv
.cache/native-venv/bin/python -m pip install --require-hashes -r tools/native-consumer/requirements.lock
.cache/native-venv/bin/python -m pip install --no-deps --no-build-isolation -e /path/to/pinned/megatoken
TZ=UTC LC_ALL=C.UTF-8 .cache/native-venv/bin/python tools/native-consumer/check_environment.py \
  --megatoken /path/to/pinned/megatoken --tokenizer /path/to/tokenizer.json \
  --out /path/to/new/environment-receipt.json
```

The consumer checkout and actual tokenizer identity must match
`contracts/native-admission-policy-v5.json`. The checker rejects dirty tracked
consumer files, a different installed checkout, mismatched dependency versions,
the wrong Python version, and tokenizer byte or codec identity changes. The
receipt records the actual host, libc, available runner/container identifiers,
dependencies and lock hashes. An absent container identity remains explicit.

`requirements.in` pins the companion's direct dependencies, native admission and
CPU learning dependencies, and the editable build backend. The committed lock
also pins transitive versions and distribution hashes. Regenerate deliberately
with `pip-compile --generate-hashes --allow-unsafe --strip-extras --output-file
tools/native-consumer/requirements.lock tools/native-consumer/requirements.in`,
then qualify the environment again. The companion repository is installed
without dependency or build isolation resolution, so that install cannot change
the reviewed dependency set.
