#!/usr/bin/env python3
"""Verify a retained v8 dataset run; optionally re-encode its lexical token IDs."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

SPLITS = ("train", "validation", "test")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


def digest(value):
    return sha(canonical(value))


def read(path):
    return json.loads(path.read_bytes())


def rows(path):
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--codec-source", type=Path)
    parser.add_argument("--tokenizer-json", type=Path)
    parser.add_argument("--producer-revision", help="Require this exact producer SHA")
    parser.add_argument("--consumer-revision", help="Require this exact consumer SHA")
    args = parser.parse_args()
    require(bool(args.codec_source) == bool(args.tokenizer_json),
            "Supply both codec source and tokenizer JSON, or neither")
    root, dataset = args.run_directory, args.run_directory / "dataset"
    manifest = read(dataset / "manifest.json")
    consumer_revision = args.consumer_revision or manifest["nativePolicy"]["consumerRevision"]
    producer_revision = args.producer_revision
    require(manifest["nativePolicy"]["consumerRevision"] == consumer_revision, "Exact consumer pin")
    require(manifest["admitted"] and manifest["nativeRequired"] and not manifest["allowLocal"],
            "Production admission flags")
    require(manifest["optimizerSteps"] == 0 and manifest["learnedSuccess"] is None,
            "No model-training claim")
    require(digest(manifest["nativePolicy"]) == manifest["nativePolicyDigest"], "Native policy digest")
    for entry in manifest["files"].values():
        path = dataset / entry["file"]
        require(path.parent == dataset, "Manifest path outside dataset")
        raw = path.read_bytes()
        require(len(raw) == entry["bytes"] and sha(raw) == entry["sha256"], str(path) + " hash")
        require(len(rows(path)) == entry["rows"], str(path) + " row count")

    registry = read(dataset / "family-registry.json")
    require(digest({key: value for key, value in registry.items() if key != "digest"}) ==
            registry["digest"] == manifest["registryDigest"], "Frozen registry digest")
    components = {item["id"]: item for item in registry["components"]}
    dispositions = rows(dataset / "dispositions.jsonl")
    require(digest(dispositions) == manifest["dispositionDigest"], "Disposition digest")
    declared = manifest["inputCandidates"]
    require(declared > 0 and len(rows(root / "candidates.jsonl")) == declared,
            "Complete candidate denominator")
    require(len(dispositions) == declared and all(row["status"] == "exported" for row in dispositions),
            "Every retained candidate exported")
    require(manifest["dispositions"] == {"exported": declared, "source-refused": 0,
            "export-refused": 0, "duplicate": 0}, "Complete admission accounting")

    bindings = rows(root / "native-inputs/bindings.jsonl")
    require(len(bindings) == declared and len({row["sourceId"] for row in bindings}) == declared,
            "One native input binding per episode")
    receipts, inputs = {}, {}
    for binding in bindings:
        prefix = root / "native-inputs" / binding["id"]
        raw = prefix.with_suffix(".json").read_bytes()
        artifact = json.loads(raw)
        receipt = read(prefix.with_suffix(".receipt.json"))
        verification, sidecar = receipt["sourceVerification"], artifact["sidecar"]
        if producer_revision is None:
            producer_revision = verification["producerRevision"]
        require(sha(raw) == binding["sha256"] == verification["artifactSha256"],
                "Exact native input bytes: " + binding["id"])
        require(verification["producerRevision"] == producer_revision and
                receipt["consumerRevision"] == consumer_revision, "Exact retained execution pins")
        require(all(verification[key] is True for key in
                    ("producerTreeClean", "sourceValidated", "projectionValidated", "replayValidated")),
                "Retained source authority checks")
        require(receipt["admitted"] and all(value == "passed" for value in receipt["checks"].values()),
                "Retained native admission")
        require(receipt["optimizerSteps"] == 0 and receipt["learningClaim"] is None, "Receipt scope")
        require(digest(artifact["public"]) == receipt["publicDigest"] == verification["publicDigest"],
                "Public digest")
        require(digest(artifact["contexts"]) == receipt["contextsDigest"] == verification["contextDigest"],
                "Context digest")
        require(digest(sidecar["sourceArtifact"]) == receipt["sourceArtifactDigest"] ==
                verification["sourceArtifactDigest"], "Source artifact digest")
        require(digest(sidecar["datasetBinding"]) == receipt["datasetBindingDigest"] ==
                binding["datasetBindingDigest"], "Dataset binding digest")
        require(sidecar["splitIdentity"]["sourceId"] == binding["sourceId"], "Native source identity")
        for field in ("contractDigest", "fixtureDigest", "interoperabilityDigest"):
            require(receipt[field] == manifest[field], "Receipt " + field)
        require(receipt["tokenizer"]["identity"] == manifest["tokenizerIdentity"] and
                receipt["tokenizer"]["sha256"] == manifest["nativePolicy"]["tokenizerSha256"],
                "Native tokenizer pins")
        receipts[binding["sourceId"]], inputs[binding["sourceId"]] = receipt, artifact

    codec, tokenizers_version, codec_sha256 = None, None, None
    if args.codec_source:
        raw = args.codec_source.read_bytes()
        codec_sha256 = sha(raw)
        require(codec_sha256 == manifest["tokenizerQualification"]["codecSourceSha256"],
                "Exact original codec source")
        namespace = {"__name__": "historical_dataset_codec"}
        exec(compile(raw, str(args.codec_source), "exec"), namespace)
        codec = namespace["ByteCodec"].from_tokenizer_json(
            args.tokenizer_json, expected_sha256=manifest["nativePolicy"]["tokenizerSha256"])
        require(codec.fingerprint == manifest["tokenizerIdentity"], "Exact tokenizer fingerprint")
        import tokenizers
        tokenizers_version = tokenizers.__version__
        require(tokenizers_version == manifest["tokenizerQualification"]["tokenizersVersion"],
                "Exact tokenizers version")

    totals, examples, episodes, seen_sources = {}, {}, {}, set()
    for split in SPLITS:
        artifacts = rows(dataset / (split + "-artifacts.jsonl"))
        by_id = {row["id"]: row for row in artifacts}
        require(len(by_id) == len(artifacts), "Unique split artifacts")
        for source_id, row in by_id.items():
            exported, original = row["exported"], inputs[source_id]
            require(source_id not in seen_sources, "Source crosses splits")
            seen_sources.add(source_id)
            require(row["split"] == split and components[row["componentId"]]["split"] == split,
                    "Frozen component split")
            require(source_id in components[row["componentId"]]["sourceIds"], "Component membership")
            require(exported["sidecar"]["nativeAdmission"] == receipts[source_id], "Retained receipt")
            require(exported["public"] == original["public"] and
                    exported["contexts"] == original["contexts"], "Captured public artifact")
            for key, value in original["sidecar"].items():
                if key not in ("admission", "nativeAdmission"):
                    require(exported["sidecar"][key] == value, "Captured sidecar " + key)
            require(exported["sidecar"]["splitIdentity"]["registry"] == registry,
                    "Exact frozen family registry")
        items, total, ordinals = rows(dataset / (split + ".jsonl")), 0, {}
        for item in items:
            source_id, ordinal = item["metadata"]["sourceId"], item["metadata"]["targetOrdinal"]
            exported = by_id[source_id]["exported"]
            generated = [row for row in exported["public"]["timeline"] if row["mode"] == "generated"]
            ordinals.setdefault(source_id, []).append(ordinal)
            context, target_row = exported["contexts"][ordinal], generated[ordinal]
            require(item["target"] == target_row["fields"]["line"], "Exact generated target")
            prompt = ("Predict one complete semantic-trace/8 record from this public execution context.\n"
                      + canonical(context).decode() + "\nNext record:\n")
            require(item["prompt"] == prompt, "Exact causal context bytes")
            require(item["metadata"]["sequence"] == target_row["sequence"] and
                    item["metadata"]["contextVisibleThrough"] == context["visibleThrough"] < target_row["sequence"],
                    "Causal context cutoff")
            require(item["metadata"]["split"] == split and item["metadata"]["nativeAdmission"] is True,
                    "Example admission and split")
            for field in ("prompt", "target"):
                require(sha(item[field].encode()) == item[field + "Sha256"], "Exact " + field + " bytes")
            p, t = item["boundaries"]["promptTokens"], item["boundaries"]["targetTokens"]
            ids, eos = item["inputIds"], manifest["eosTokenId"]
            require(p > 0 and t > 0 and all(type(value) is int and value >= 0 for value in ids), "Token IDs")
            require(item["boundaries"]["terminalTokens"] == 1 and len(ids) == p + t + 1 and
                    ids[-1] == item["eosTokenId"] == eos and eos not in ids[:-1], "One terminal EOS")
            require(item["labels"] == [-100] * p + ids[p:] and item["attentionMask"] == [1] * len(ids),
                    "Generated-only loss labels and complete attention")
            require(item["costs"] == {"flatContextTokens": len(ids), "publicContextTokens": p,
                    "generatedTokens": t, "terminalTokens": 1,
                    "maxContextTokens": manifest["maxContextTokens"]}, "Example token accounting")
            require(item["tokenizerIdentity"] == manifest["tokenizerIdentity"], "Example tokenizer identity")
            if codec:
                require(codec.encode(item["prompt"]) == ids[:p] and
                        codec.encode(item["target"]) == ids[p:-1], "Pinned physical token IDs")
                require(codec.decode(ids[:p]) == item["prompt"].encode() and
                        codec.decode(ids[p:-1]) == item["target"].encode(), "Byte round trips")
            total += t + 1
        for source_id, row in by_id.items():
            require(ordinals[source_id] == list(range(len(row["exported"]["contexts"]))),
                    "Every complete episode target retained once")
        examples[split], episodes[split], totals[split] = len(items), len(artifacts), total
    require(seen_sources == set(inputs), "Every native input retained in dataset")
    require(examples == manifest["examples"], "Examples")
    require(episodes == manifest["episodes"] and sum(episodes.values()) == declared, "Episodes")
    require(totals == manifest["generatedTokens"], "Token totals")
    result = {"schema": "v8-dataset-retained-evidence-check/1", "passed": True,
              "producerRevision": producer_revision, "consumerRevision": consumer_revision,
              "scope": "retained-evidence-integrity-and-physical-token-check",
              "freshNativeExecution": False, "manifestFilesChecked": len(manifest["files"]),
              "nativeInputsChecked": len(bindings), "episodes": episodes, "examples": examples,
              "generatedTokensWithEOS": sum(totals.values()), "eosTokens": sum(examples.values()),
              "manifestHashes": True, "exactNativeInputHashes": True, "receiptBindings": True,
              "frozenComponentSplits": True, "exactCausalContextBytes": True,
              "generatedOnlyMasks": True, "allCompleteEpisodeTargets": True,
              "physicalTokenIdsReencoded": codec is not None, "byteRoundTripsRechecked": codec is not None,
              "codecSourceSha256": codec_sha256,
              "tokenizerIdentity": manifest["tokenizerIdentity"],
              "pythonVersion": sys.version.split()[0], "tokenizersVersion": tokenizers_version,
              "optimizerSteps": 0, "learningClaim": None}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
