"""Check real Ling tokens, loss labels, complete context and frozen v7 export splits."""

import argparse
import hashlib
import json
from pathlib import Path

from megatoken.data.algorithm_v7 import stable_algorithm_hash
from megatoken.data.semantic_family_v7 import verify_family_registry_v7
from megatoken.generation.codec import LING_TOKENIZER_SHA256, ByteCodec


def check(corpus, tokenizer_json):
    manifest = json.loads((corpus / "manifest.json").read_text())
    if (
        manifest["schema"] != "semantic-training-dataset/7"
        or manifest["adapter"] != "semantic-causal-lm/3"
        or manifest["admitted"] is not True
        or manifest["allowLocal"] is not False
        or manifest["optimizerSteps"] != 0
    ):
        raise ValueError("Only newly admitted v7 causal exports can pass this gate")
    codec = ByteCodec.from_tokenizer_json(
        tokenizer_json, expected_sha256=LING_TOKENIZER_SHA256
    )
    if (
        manifest["tokenizerIdentity"] != codec.fingerprint
        or manifest["eosTokenId"] != 156892
    ):
        raise ValueError("Causal export tokenizer or record terminator changed")
    registry_bytes = (corpus / "family-registry.json").read_bytes()
    registry = json.loads(registry_bytes)
    if (
        verify_family_registry_v7(registry) != manifest["registry"]["digest"]
        or hashlib.sha256(registry_bytes).hexdigest() != manifest["registry"]["sha256"]
    ):
        raise ValueError("Causal export family registry changed")
    components = {
        source_id: component
        for component in registry["components"]
        for source_id in component["sourceIds"]
    }
    counts, profiles, sources = {}, {}, set()
    for split, expected in manifest["files"].items():
        if split not in {"train", "validation", "test", "refusals", "failures"}:
            raise ValueError("Unknown exported split")
        payload = (corpus / (split + ".jsonl")).read_bytes()
        if (
            len(payload) != expected["bytes"]
            or hashlib.sha256(payload).hexdigest() != expected["sha256"]
        ):
            raise ValueError("Exported bytes differ from the manifest")
        rows = [json.loads(line) for line in payload.splitlines()]
        if len(rows) != expected["rows"]:
            raise ValueError("Exported row count differs from the manifest")
        if split in {"refusals", "failures"}:
            if rows:
                raise ValueError(
                    "The declared qualification set contains refusals or failures"
                )
            continue
        counts[split] = len(rows)
        for row in rows:
            if (
                row["schema"] != manifest["adapter"]
                or row["traceFormat"] != "semantic-trace/7"
            ):
                raise ValueError("Causal row has an older prompt or trace contract")
            prompt, target = row["prompt"].encode(), row["target"].encode()
            prompt_ids, target_ids = codec.encode(prompt), codec.encode(target)
            if codec.decode(prompt_ids) != prompt or codec.decode(target_ids) != target:
                raise ValueError(
                    "Tokenizer failed an exact public-context or generated-byte round trip"
                )
            expected_ids = prompt_ids + target_ids + [manifest["eosTokenId"]]
            if (
                row["inputIds"] != expected_ids
                or row["labels"]
                != [-100] * len(prompt_ids) + target_ids + [manifest["eosTokenId"]]
                or row["attentionMask"] != [1] * len(expected_ids)
                or len(expected_ids) > manifest["maxContextTokens"]
                or row["promptSha256"] != hashlib.sha256(prompt).hexdigest()
                or row["targetSha256"] != hashlib.sha256(target).hexdigest()
            ):
                raise ValueError(
                    "Causal tokens or generated-only labels differ from original bytes"
                )
            context = json.loads(
                row["prompt"].split("\n", 1)[1].rsplit("\nNext record:\n", 1)[0]
            )
            if row["representation"] == "algorithm" and (
                context.get("program", {}).get("definitionDigest")
                != context["definition"]
                or "inputGraph" not in context
                or stable_algorithm_hash(context["inputGraph"]) != context["input"]
            ):
                raise ValueError(
                    "Flat algorithm prompt contains unresolved program or input references"
                )
            metadata = row["metadata"]
            component = components[metadata["sourceId"]]
            if (
                metadata["split"] != split
                or component["split"] != split
                or component["id"] != metadata["sourceComponent"]
                or metadata["nativeAdmission"] is not True
            ):
                raise ValueError(
                    "Causal export moved a family or lost native admission"
                )
            sources.add(metadata["sourceId"])
            profiles[row["representation"]] = profiles.get(row["representation"], 0) + 1
    if not sources or len(sources) != manifest["registeredSourceMembers"]:
        raise ValueError("Causal export did not retain every registered source")
    return {
        "schema": "semantic-causal-export-check/7",
        "registryDigest": registry["digest"],
        "tokenizerIdentity": codec.fingerprint,
        "episodes": len(sources),
        "targetsBySplit": counts,
        "targetsByRepresentation": profiles,
        "byteRoundTripsValidated": True,
        "lossLabelsValidated": True,
        "completeFlatContextsValidated": True,
        "optimizerSteps": 0,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--tokenizer-json", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.corpus, args.tokenizer_json), separators=(",", ":")))
