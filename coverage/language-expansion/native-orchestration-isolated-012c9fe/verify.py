"""Verify retained bytes without rerunning the native model or tests."""

import hashlib
import io
import json
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_bytes(data, entry):
    assert len(data) == entry["bytes"], entry["path"]
    assert digest(data) == entry["sha256"], entry["path"]
    return data


def check_file(entry):
    return check_bytes((ROOT / entry["path"]).read_bytes(), entry)


def check_members(data, expected):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        members = archive.getmembers()
        assert all(member.isfile() for member in members)
        names = [member.name for member in members]
        assert len(names) == len(set(names))
        assert set(names) == {entry["path"] for entry in expected}
        for entry in expected:
            stream = archive.extractfile(entry["path"])
            assert stream is not None
            check_bytes(stream.read(), entry)


def main():
    index = json.loads((ROOT / "files.json").read_text())
    assert index["bundlePartsPublished"] is True
    expected_names = {entry["path"] for entry in index["files"]}
    actual_names = {path.name for path in ROOT.iterdir() if path.is_file()}
    assert actual_names == expected_names | {"files.json"}
    for entry in index["files"]:
        check_file(entry)

    native = json.loads((ROOT / "native-orchestration-index.json").read_text())
    check_members(check_file(native["archive"]), native["members"])

    bundle = json.loads((ROOT / "served-bundle-archive.json").read_text())
    combined = b"".join(check_file(part) for part in bundle["parts"])
    check_bytes(combined, bundle["archive"])
    check_members(combined, bundle["members"])

    run = json.loads((ROOT / "run.json").read_text())
    assert run["status"] == "passed" and run["exitCode"] == 0
    assert run["identityUnchanged"] is True
    assert run["tapCounts"] == {
        "tests": 5, "suites": 0, "pass": 5, "fail": 0,
        "cancelled": 0, "skipped": 0, "todo": 0,
    }
    retained = {Path(row["path"]).name: row for row in run["evidence"]}
    for entry in native["members"]:
        original = retained[Path(entry["path"]).name]
        assert entry["bytes"] == original["bytes"]
        assert entry["sha256"] == original["sha256"]

    print(json.dumps({
        "status": "verified",
        "retainedFiles": len(index["files"]),
        "nativeEvidenceMembers": len(native["members"]),
        "servedBundleMembers": len(bundle["members"]),
        "servedArchiveSha256": digest(combined),
        "recordedTests": run["tapCounts"],
        "scope": "Byte-integrity verification only; no test or model execution.",
    }, indent=2))


if __name__ == "__main__":
    main()
