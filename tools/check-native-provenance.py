#!/usr/bin/env python3
"""Opt-in actual pinned consumer regression: controls pass, private tampering fails.

Run with the locked companion Python environment. This calls the production
prepare_semantic_corpus path, including a fresh producer source process and real
tokenizer/visibility/loss/native preparation. No synthetic receipts are used.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def read(path):
    return json.loads(Path(path).read_text())


def revision(path):
    changes = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=path, text=True)
    if changes:
        raise ValueError(f"Native provenance regression requires an unchanged tracked checkout: {path}")
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()


def replace_path(document, path, value):
    target = document
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--session", type=Path, help="Optional separately admitted session when the corpus is a single-only smoke")
    parser.add_argument("--tracer-root", type=Path, required=True)
    parser.add_argument("--consumer-root", type=Path, required=True)
    parser.add_argument("--tokenizer-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    manifest = read(options.corpus / "manifest.json")
    producer = revision(options.tracer_root)
    consumer = revision(options.consumer_root)
    if producer != manifest["producerRevision"]:
        raise ValueError("Use the exact immutable tracer checkout recorded by this corpus")
    sys.path.insert(0, str(options.consumer_root.resolve() / "src"))
    from megatoken.data.semantic_corpus import prepare_semantic_corpus, source_verifier_for_checkout
    from megatoken.generation.codec import ByteCodec, LING_TOKENIZER_SHA256

    single, session = None, read(options.session) if options.session else None
    # Large release corpora carry full private journals. Retain only the two
    # needed controls rather than loading the entire release into host memory.
    for case in manifest["cases"]:
        if case["status"] != "admitted":
            continue
        document = read(options.corpus / case["path"])
        if single is None and not document["sidecar"].get("collection"):
            single = document
        if session is None and document["sidecar"].get("collection", {}).get("schema") == "semantic-teacher-session/4":
            session = document
        if single is not None and session is not None:
            break
    if single is None or session is None:
        raise ValueError("A real admitted single episode and repeated session are both required")
    controls = [("single", single), ("session", session)]
    for name, document in controls:
        side = document["sidecar"]
        if side["producerRevision"] != producer or side["nativePolicy"]["consumerRevision"] != consumer:
            raise ValueError(f"{name} producer/consumer pins differ from the actual checkouts")
        if side["environment"]["timezone"] != os.environ.get("TZ"):
            raise ValueError(f"{name} requires explicit TZ={side['environment']['timezone']} for exact source recheck")
    if options.output.exists() and any(options.output.iterdir()):
        raise ValueError("Use a fresh output directory so dedup state cannot mask regressions")
    options.output.mkdir(parents=True, exist_ok=True)
    inputs = options.output / "inputs"
    inputs.mkdir()
    candidate_specs = [(single, None, None), (session, None, None)]
    labels = ["control-single", "control-session"]
    mutations = []
    for name, document in controls:
        side = document["sidecar"]
        changed_split = "test" if side["split"] != "test" else "train"
        fields = [
            ("split", ["sidecar", "split"], changed_split),
            ("family", ["sidecar", "sourceFamily"], "forged-source-family"),
            ("lineage", ["sidecar", "sourceLineage"], "forged-lineage"),
            ("ancestors", ["sidecar", "ancestorIds"], [*side["ancestorIds"], "forged-ancestor"]),
            ("task", ["sidecar", "taskId"], "forged-task"),
            ("fixture-family", ["sidecar", "fixtureFamily"], "forged-fixture-family"),
            ("source-digest", ["sidecar", "sourceProvenance", "sourceDigest"], "0" * 64),
            ("provenance-family", ["sidecar", "sourceProvenance", "family"], "forged-provenance-family"),
            ("split-seed", ["sidecar", "sourceProvenance", "seed"], side["sourceProvenance"]["seed"] + 1),
            ("license", ["sidecar", "license"], "forged-license"),
            ("identity-digest", ["sidecar", "identityDigest"], "0" * 64),
            ("native-binding", ["sidecar", "nativeBinding", "identityDigest"], "0" * 64),
            ("consumer-policy", ["sidecar", "nativePolicy", "consumerRevision"], "0" * 40),
            ("tokenizer-policy", ["sidecar", "nativePolicy", "tokenizerSha256"], "0" * 64),
        ]
        if name == "session":
            component = side["collection"]["components"][0]["sidecar"]
            fields.extend([
                ("component-split", ["sidecar", "collection", "components", 0, "sidecar", "split"], changed_split),
                ("component-ancestors", ["sidecar", "collection", "components", 0, "sidecar", "ancestorIds"],
                 [*component["ancestorIds"], "forged-component-ancestor"]),
            ])
        for label, path, value in fields:
            mutations.append({"candidate": len(candidate_specs), "case": f"{name}-{label}", "path": path})
            labels.append(f"{name}-{label}")
            candidate_specs.append((document, path, value))
    input_receipts = []
    input_paths = []
    for label, (original, changed_path, value) in zip(labels, candidate_specs):
        document = original if changed_path is None else copy.deepcopy(original)
        if changed_path is not None:
            replace_path(document, changed_path, value)
            if document["public"] != original["public"]:
                raise AssertionError("Provenance test accidentally changed public execution bytes")
        raw = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
        path = inputs / f"{label}.json.gz"
        path.write_bytes(gzip.compress(raw, mtime=0))
        input_paths.append(path)
        input_receipts.append({"case": label, "path": str(path.relative_to(options.output)),
                               "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    codec = ByteCodec.from_tokenizer_json(options.tokenizer_json, expected_sha256=LING_TOKENIZER_SHA256)
    candidates = (json.loads(gzip.decompress(path.read_bytes())) for path in input_paths)
    native, report = prepare_semantic_corpus(candidates, options.output / "prepared", codec=codec,
        producer_revision=producer, consumer_revision=consumer,
        source_verifier=source_verifier_for_checkout(options.tracer_root, producer))
    refusals = {item["candidate"]: item for item in report["refusals"]}
    failures = []
    if report["counts"].get("admitted") != len(controls) or any(i in refusals for i in range(len(controls))):
        failures.append("Untampered controls did not both pass full source/native preparation")
    for mutation in mutations:
        refusal = refusals.get(mutation["candidate"])
        mutation["status"] = refusal["status"] if refusal else "unexpectedly-admitted"
        mutation["reason"] = refusal["reason"] if refusal else None
        if not refusal or refusal["status"] != "admission_rejected":
            failures.append(f"Tampered case was not rejected: {mutation['case']}")
        elif "runtime, dependency or verifier environment" in refusal["reason"]:
            failures.append(f"Environment mismatch masked provenance test: {mutation['case']}")
    audit = read(options.output / "prepared" / "semantic-audit.json")
    if len(audit) != len(controls) or not all(row["source"].get("identityValidated") is True for row in audit):
        failures.append("Native preparation did not retain both independently rechecked identity receipts")
    summary = {"schema": "semantic-native-provenance-regression/1", "status": "failed" if failures else "passed",
        "producerRevision": producer, "consumerRevision": consumer,
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "tokenizerSha256": hashlib.sha256(options.tokenizer_json.read_bytes()).hexdigest(),
        "tokenizerIdentity": codec.fingerprint, "timezone": os.environ.get("TZ"),
        "controlsAdmitted": report["counts"].get("admitted", 0), "mutationsAttempted": len(mutations),
        "mutationsRejected": len(refusals), "nativePreparedEpisodes": report["accepted"],
        "nativeManifestFingerprint": native["fingerprint"], "optimizerSteps": 0, "learnedSuccess": None,
        "mutations": mutations, "inputArtifacts": input_receipts, "failures": failures,
        "scope": "Private metadata tampering with unchanged public bytes; actual pinned source/native preparation."}
    (options.output / "provenance-regression.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({key: summary[key] for key in ["status", "producerRevision", "controlsAdmitted",
        "mutationsAttempted", "mutationsRejected", "nativePreparedEpisodes", "failures"]}))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
