"""Fault injection around the actual native durable commit JSONL peer.

The production native adapter and durable bridge still execute every operation.
This fixture changes only the requested process-exit boundary or returned bytes.
"""
import importlib.util
import base64
import json
import os
import sys
from pathlib import Path


def main():
    args = list(sys.argv[1:])
    peer_index = args.index("--peer")
    peer_path = Path(args[peer_index + 1]).resolve()
    del args[peer_index:peer_index + 2]
    fault = None
    if "--fault" in args:
        fault_index = args.index("--fault")
        fault = args[fault_index + 1]
        del args[fault_index:fault_index + 2]
    if fault not in {None, "before-native-intent", "after-native-outcome", "alter-reply"}:
        raise ValueError("Unknown controlled process-loss boundary")
    fault_ordinal = None
    if "--fault-request-ordinal" in args:
        index = args.index("--fault-request-ordinal")
        fault_ordinal = int(args[index + 1])
        if fault_ordinal < 1:
            raise ValueError("Fault request ordinal must be positive")
        del args[index:index + 2]
    records_path = None
    if "--fixture-records" in args:
        index = args.index("--fixture-records")
        records_path = Path(args[index + 1])
        del args[index:index + 2]
    action_name = None
    if "--fault-action" in args:
        action_index = args.index("--fault-action")
        action_name = args[action_index + 1]
        del args[action_index:action_index + 2]
    spec = importlib.util.spec_from_file_location("durable_commit_test_peer", peer_path)
    peer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = peer
    spec.loader.exec_module(peer)
    if records_path is not None:
        records = json.loads(records_path.read_text(encoding="utf-8"))
        if not isinstance(records, list) or not records or any(
            not isinstance(record, str) or not record for record in records
        ):
            raise ValueError("Controlled lexical records must be a nonempty string list")
        peer._fixture_records = lambda final_action="track_complete": list(records)
    original = peer.dispatch

    def dispatch(adapter, request, **kwargs):
        target_op = ("durable-close" if action_name == "cancel" else
                     "durable-bootstrap" if action_name == "bootstrap-orchestration-child" else "durable-commit")
        target = request.get("op") == target_op
        if target and action_name is not None:
            original_request = json.loads(base64.b64decode(request["requestBase64"]))
            target = (original_request.get("op") == "cancel" if action_name == "cancel" else
                      original_request.get("op") == "bootstrap-orchestration-child"
                      if action_name == "bootstrap-orchestration-child" else
                      original_request.get("op") == "commit-orchestration"
                      and json.loads(original_request["record"]).get("name") == action_name)
        if target and fault_ordinal is not None:
            target = request.get("identity", {}).get("ordinal") == fault_ordinal
        if target and fault == "before-native-intent":
            os._exit(86)
        result = original(adapter, request, **kwargs)
        if target:
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
