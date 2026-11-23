#!/usr/bin/env python3
"""Check this packet's retained bytes and recorded accounting; execute no guests."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text())
actual = {str(path.relative_to(root)) for path in root.rglob("*")
          if path.is_file() and path.name != "manifest.json"}
assert actual == set(manifest["files"]), "retained file set differs from manifest"
for name, identity in manifest["files"].items():
    data = (root / name).read_bytes()
    assert len(data) == identity["bytes"], name + ": byte length differs"
    assert hashlib.sha256(data).hexdigest() == identity["sha256"], name + ": SHA-256 differs"
selection = json.loads((root / "selected-report.json").read_text())
report = selection["report"]
verification = json.loads((root / "verification.json").read_text())
assert report["campaign"]["implementation"]["producerRevision"] == manifest["producerRevision"]
catalog = json.loads((root / "selected-catalog.json").read_text())
assert catalog["fullCatalog"]["suiteRevision"] == manifest["sourceRevision"]
assert report["summary"]["selected"] == 40
assert report["summary"]["attempts"] == 120
rows = report["campaign"]["rows"]
assert len(rows) == 40 and all(row["selected"] for row in rows)
assert sum(len(row["attempts"]) for row in rows) == 120
for stage in ("parseStatic", "ownedExecution", "independentReference"):
    assert report["summary"]["stages"][stage]["passed"] == 40
    assert all(attempt["status"] == "passed" for row in rows for attempt in row["attempts"] if attempt["stage"] == stage)
assert verification["completedResume"]["byteIdentical"] is True
assert verification["completedResume"]["sha256Before"] == verification["completedResume"]["sha256After"] == selection["fullReport"]["sha256"]
assert verification["completedResume"]["attemptsBefore"] == verification["completedResume"]["attemptsAfter"] == 120
assert verification["compactReconstruction"]["archiveByteIdentical"] is True
assert verification["compactReconstruction"]["archiveSha256"] == selection["fullReport"]["sha256"]
assert verification["compactReconstruction"]["jsonSha256"] == selection["fullReport"]["jsonSha256"]
assert verification["sourceCorrespondenceExecuted"] is False
assert verification["nativeTraceReplayExecuted"] is False
assert verification["nativeConsumerContext"]["executedInThisCampaign"] is False
print(json.dumps({"valid": True, "verifiedFiles": len(actual),
                  "retainedBytes": sum(row["bytes"] for row in manifest["files"].values()),
                  "producerRevision": manifest["producerRevision"],
                  "sourceRevision": manifest["sourceRevision"],
                  "selected": 40, "attempts": 120,
                  "guestExecutions": 0, "nativeReplayExecuted": False}))
