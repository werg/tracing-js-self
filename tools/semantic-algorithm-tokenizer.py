#!/usr/bin/env python3
"""Persistent, byte-exact token metering with the pinned companion ByteCodec.

This qualifies a text meter only. It neither parses v7 records nor admits them
to the native consumer, and it does not load a model or a training checkpoint.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import subprocess
import sys


MAX_MESSAGE_BYTES = 8 * 1024 * 1024
TOKENIZERS_VERSION = "0.23.3"


def emit(value):
    print(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")), flush=True)


def load_codec(consumer_root, tokenizer_path, policy):
    root = consumer_root.resolve(strict=True)
    tokenizer = tokenizer_path.resolve(strict=True)
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True, stderr=subprocess.PIPE
    ).strip()
    dirty = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, text=True
    ).strip()
    if revision != policy["consumerRevision"] or dirty:
        raise ValueError("Token meter requires the exact clean pinned consumer checkout")
    if importlib.metadata.version("tokenizers") != TOKENIZERS_VERSION:
        raise ValueError("Token meter requires tokenizers==" + TOKENIZERS_VERSION)
    sys.path.insert(0, str(root / "src"))
    from megatoken.generation import codec as module

    codec_source = (root / "src/megatoken/generation/codec.py").resolve(strict=True)
    if Path(module.__file__).resolve() != codec_source:
        raise ValueError("Loaded ByteCodec does not belong to the pinned consumer")
    codec = module.ByteCodec.from_tokenizer_json(
        tokenizer, expected_sha256=policy["tokenizerSha256"]
    )
    if codec.fingerprint != policy["tokenizerIdentity"]:
        raise ValueError("Pinned codec fingerprint differs from policy")
    identity = {
        "name": module.LING_REPOSITORY,
        "revision": module.LING_REVISION,
        "tokenizerSha256": policy["tokenizerSha256"],
        "fingerprint": codec.fingerprint,
        "codecVersion": module.CODEC_VERSION,
        "vocabSize": codec.vocab_size,
    }
    qualification = {
        "schema": "semantic-codec-meter/1",
        "status": "qualified",
        "scope": "byte-exact-token-meter-only",
        "consumerRevision": revision,
        "consumerClean": True,
        "codecSourceSha256": hashlib.sha256(codec_source.read_bytes()).hexdigest(),
        "pythonVersion": platform.python_version(),
        "tokenizersVersion": TOKENIZERS_VERSION,
        "nativeAdmission": False,
    }
    # Test the byte contract independently of the eventual measured corpus.
    for raw in [b"", b"\x00\xff", "e\u0301\n\u03b1".encode(), b"<|im_start|>"]:
        if codec.decode(codec.encode(raw)) != raw:
            raise ValueError("Pinned codec changed a byte-contract probe")
    return codec, identity, qualification


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--consumer-root", type=Path, required=True)
    parser.add_argument("--tokenizer-json", type=Path, required=True)
    parser.add_argument("--policy-json", required=True)
    args = parser.parse_args()
    policy = json.loads(args.policy_json)
    if set(policy) != {"consumerRevision", "tokenizerIdentity", "tokenizerSha256"} or any(
        not isinstance(value, str) for value in policy.values()
    ):
        raise ValueError("Exact token metering policy required")
    codec, identity, qualification = load_codec(args.consumer_root, args.tokenizer_json, policy)
    emit({"ready": True, "identity": identity, "qualification": qualification})
    while raw := sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1):
        if len(raw) > MAX_MESSAGE_BYTES or not raw.endswith(b"\n"):
            raise ValueError("Token meter message exceeds its byte bound")
        request = json.loads(raw)
        request_id = request.get("id") if isinstance(request, dict) else None
        try:
            if type(request_id) is not int or request_id < 1:
                raise ValueError("Token meter request identity")
            if request.get("op") == "encode" and set(request) == {"id", "op", "text"}:
                text = request["text"]
                if not isinstance(text, str):
                    raise TypeError("Token meter requires exact text")
                payload = text.encode("utf-8", errors="strict")
                tokens = codec.encode(payload)
                if codec.decode(tokens) != payload:
                    raise ValueError("Token meter changed exact target bytes")
                emit({"id": request_id, "ids": tokens})
            elif request.get("op") == "decode" and set(request) == {"id", "op", "ids"}:
                tokens = request["ids"]
                if not isinstance(tokens, list) or any(type(token) is not int or token < 0 for token in tokens):
                    raise TypeError("Token meter requires nonnegative integer token IDs")
                emit({"id": request_id, "text": codec.decode(tokens).decode("utf-8", errors="strict")})
            else:
                raise ValueError("Unknown token meter operation or fields")
        except Exception as error:
            emit({"id": request_id, "error": str(error), "type": type(error).__name__})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1) from None
