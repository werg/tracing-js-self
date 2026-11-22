"""Test-only controlled decoder for the actual paired V8 recovery peer.

Only the last lexical decision changes from track_complete to track_cancel. The
pinned native adapter still produces and validates every selection, commit,
checkpoint, tombstone and restore receipt. This does not qualify learned output.
"""
import importlib.util
import json
import sys
from pathlib import Path

from megatoken.data.semantic_json import stable_algorithm_json


def main():
    args = list(sys.argv[1:])
    try:
        peer_index = args.index("--peer")
        peer_path = Path(args[peer_index + 1]).resolve()
    except (ValueError, IndexError):
        raise SystemExit("--peer must identify the paired recovery peer")
    del args[peer_index:peer_index + 2]
    spec = importlib.util.spec_from_file_location("paired_semantic_v8_peer", peer_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the pinned paired recovery peer")
    peer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = peer
    spec.loader.exec_module(peer)
    original = peer._fixture_records

    def track_cancel_records():
        records = list(original())
        if not records:
            raise RuntimeError("paired recovery peer produced no terminal decision")
        terminal = json.loads(records[-1])
        if terminal.get("name") != "track_complete":
            raise RuntimeError("paired recovery fixture terminal action changed")
        terminal["name"] = "track_cancel"
        records[-1] = stable_algorithm_json(terminal)
        return records

    peer._fixture_records = track_cancel_records
    sys.argv = [str(peer_path), *args]
    return peer.main()


if __name__ == "__main__":
    raise SystemExit(main())
