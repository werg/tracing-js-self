"""Fault injection around the actual native durable commit JSONL peer.

The production native adapter and durable bridge still execute every operation.
This fixture changes only the requested process-exit boundary or returned bytes.
"""
import importlib.util
import os
import sys
from pathlib import Path


def main():
    args = list(sys.argv[1:])
    peer_index = args.index("--peer")
    peer_path = Path(args[peer_index + 1]).resolve()
    del args[peer_index:peer_index + 2]
    fault_index = args.index("--fault")
    fault = args[fault_index + 1]
    del args[fault_index:fault_index + 2]
    spec = importlib.util.spec_from_file_location("durable_commit_test_peer", peer_path)
    peer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = peer
    spec.loader.exec_module(peer)
    original = peer.dispatch

    def dispatch(adapter, request, **kwargs):
        if request.get("op") == "durable-commit" and fault == "before-native-intent":
            os._exit(86)
        result = original(adapter, request, **kwargs)
        if request.get("op") == "durable-commit":
            if fault == "after-native-outcome":
                os._exit(87)
            if fault == "alter-reply":
                result["requestSha256"] = "0" * 64
        return result

    peer.dispatch = dispatch
    sys.argv = [str(peer_path), *args]
    return peer.main()


if __name__ == "__main__":
    raise SystemExit(main())
