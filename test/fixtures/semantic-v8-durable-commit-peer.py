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
    request_ordinal = None
    if "--fault-request-ordinal" in args:
        ordinal_index = args.index("--fault-request-ordinal")
        request_ordinal = int(args[ordinal_index + 1])
        del args[ordinal_index:ordinal_index + 2]
    fixture_records = None
    rpc_log = None
    if "--rpc-log" in args:
        log_index = args.index("--rpc-log")
        rpc_log = Path(args[log_index + 1]).open("x", encoding="utf-8")
        del args[log_index:log_index + 2]
    if "--fixture-records" in args:
        records_index = args.index("--fixture-records")
        fixture_records = json.loads(Path(args[records_index + 1]).read_text())
        del args[records_index:records_index + 2]
        if not isinstance(fixture_records, list) or not fixture_records or not all(
            isinstance(record, str) and record for record in fixture_records
        ):
            raise ValueError("Exact nonempty lexical fixture records are required")
    operation = None
    if "--fault-operation" in args:
        operation_index = args.index("--fault-operation")
        operation = args[operation_index + 1]
        del args[operation_index:operation_index + 2]
    action_name = None
    if "--fault-action" in args:
        action_index = args.index("--fault-action")
        action_name = args[action_index + 1]
        del args[action_index:action_index + 2]
    if fault not in {None, "none", "before-native-intent", "after-native-outcome", "alter-reply"}:
        raise ValueError("Unknown controlled process-loss boundary")
    if request_ordinal is not None and request_ordinal < 1:
        raise ValueError("Fault request ordinal must be positive")
    if operation is None:
        operation = ("durable-close" if action_name == "cancel" else
                     "durable-bootstrap-child" if action_name == "bootstrap-orchestration-child"
                     else "durable-commit")
    spec = importlib.util.spec_from_file_location("durable_commit_test_peer", peer_path)
    peer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = peer
    spec.loader.exec_module(peer)
    if fixture_records is not None:
        peer._fixture_records = lambda final_action="track_complete": list(fixture_records)
    original = peer.dispatch

    def dispatch(adapter, request, **kwargs):
        if rpc_log is not None:
            rpc_log.write(json.dumps({"id": request.get("id"), "op": request.get("op"),
                                      "ordinal": request.get("identity", {}).get("ordinal")}) + "\n")
            rpc_log.flush()
        target = request.get("op") == operation
        if target and request_ordinal is not None:
            target = request.get("identity", {}).get("ordinal") == request_ordinal
        if target and action_name is not None:
            original_request = json.loads(base64.b64decode(request["requestBase64"]))
            target = (original_request.get("op") == "cancel" if action_name == "cancel" else
                      original_request.get("op") == "bootstrap-orchestration-child"
                      if action_name == "bootstrap-orchestration-child" else
                      original_request.get("op") == "commit-orchestration"
                      and json.loads(original_request["record"]).get("name") == action_name)
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
