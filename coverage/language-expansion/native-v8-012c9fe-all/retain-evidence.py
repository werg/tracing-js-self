"""Retain exact, independently hash-checked v8 population evidence.

Run retain_native_qualification_inputs.mjs on each completed qualification first.
Archives are deterministic, grouped by population, and split below the chosen
compressed byte bound. This script never changes the measured reports.
"""

from pathlib import Path
import argparse
import hashlib
import json
import shutil
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_bytes())


def summarize(rows):
    return {
        "declared": len(rows),
        "sourceQualified": sum(row["source"] == "passed" for row in rows),
        "nativeAdmitted": sum(row["native"] == "passed" for row in rows),
        "sourceDispositions": {
            status: sum(row["source"] == status for row in rows)
            for status in sorted({row["source"] for row in rows})
        },
        "nativeDispositions": {
            status: sum(row["native"] == status for row in rows)
            for status in sorted({row["native"] for row in rows})
        },
    }


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", required=True)
parser.add_argument("--population", action="append", default=[], help="ID:QUALIFICATION:COSTS")
parser.add_argument("--comparison")
parser.add_argument("--comparison-inputs")
parser.add_argument("--reference")
parser.add_argument("--policy")
parser.add_argument("--validation")
parser.add_argument("--max-archive-bytes", type=int, default=8_000_000)
args = parser.parse_args()
assert args.max_archive_bytes > 0
out = Path(args.output)
out.mkdir(parents=True, exist_ok=False)
groups = {}
populations = []


def retain(group, name, path, expected=None):
    data = path.read_bytes()
    digest = sha(data)
    if expected is not None:
        assert digest == expected, (name, "source artifact SHA-256")
    previous = groups.get(group, {}).get(name)
    assert previous is None or previous[1:] == (digest, len(data)), (name, "conflicting retained bytes")
    groups.setdefault(group, {})[name] = (path, digest, len(data))


for specification in args.population:
    ident, qualified, costs = specification.split(":", 2)
    assert ident and Path(ident).name == ident
    assert ident not in groups, "duplicate population"
    item = {"id": ident}
    for kind, directory in [("qualification", Path(qualified)), ("costs", Path(costs))]:
        report_path = directory / "report.json"
        report = read_json(report_path)
        expected = "semantic-v8-qualification/1" if kind == "qualification" else "semantic-v8-population-costs/1"
        assert report["schema"] == expected
        assert report["artifactDigestEncoding"] == "sha256 of exact UTF-8 file bytes"
        item[kind] = {"reportSha256": sha(report_path.read_bytes()), "report": report}
        retain(ident, f"{ident}/{kind}/report.json", report_path)
        for name, digest in report["artifacts"].items():
            assert Path(name).name == name
            retain(ident, f"{ident}/{kind}/{name}", directory / name, digest)
        # Attempts, progress identities and exact native input bindings are also
        # retained, even when the original report does not list these sidecars.
        for path in sorted(directory.iterdir()):
            if path.is_file() and path.suffix in {".json", ".jsonl", ".log"}:
                retain(ident, f"{ident}/{kind}/{path.name}", path)
        for path in sorted((directory / "progress").rglob("*")):
            if path.is_file() and path.name != ".campaign.lock":
                retain(ident, f"{ident}/{kind}/{path.relative_to(directory).as_posix()}", path)
        for suffix in ("stdout.log", "stderr.log"):
            path = directory.with_name(directory.name + "." + suffix)
            if path.exists():
                retain(ident, f"{ident}/{kind}/{suffix}", path)
    q = item["qualification"]["report"]
    c = item["costs"]["report"]
    assert c["qualification"]["reportSha256"] == item["qualification"]["reportSha256"]
    assert c["producerRevision"] == q["producerRevision"]
    assert len(q["rows"]) == q["declared"] == len(c["rows"])
    inventory = read_json(Path(qualified) / "population.json")
    assert {task["fixture"]["id"] for task in inventory["tasks"]} == {row["id"] for row in q["rows"]}
    manifest = read_json(Path(qualified) / "native-inputs-manifest.json")
    admitted = {row["id"]: row for row in q["rows"] if row["native"] == "passed"}
    assert manifest["producerRevision"] == q["producerRevision"]
    assert manifest["consumerRevision"] == q["nativePolicy"]["consumerRevision"]
    assert len(manifest["rows"]) == manifest["retainedNativeInputs"] == len(admitted) == q["nativeAdmitted"]
    assert {row["id"] for row in manifest["rows"]} == set(admitted)
    for row in manifest["rows"]:
        receipt = read_json(Path(qualified) / (row["id"] + ".native.json"))
        assert receipt == admitted[row["id"]]["nativeReceipt"]
        actual = sha((Path(qualified) / row["nativeInput"]).read_bytes())
        assert actual == row["nativeInputSha256"] == receipt["sourceVerification"]["artifactSha256"]
        assert receipt["sourceVerification"]["producerRevision"] == q["producerRevision"]
        assert receipt["consumerRevision"] == q["nativePolicy"]["consumerRevision"]
    populations.append(item)

comparison = None
if args.comparison:
    path = Path(args.comparison)
    comparison = read_json(path)
    retain("comparison", "paired-serving-costs.json", path)
    shutil.copyfile(path, out / "paired-serving-costs.json")
if args.comparison_inputs:
    assert comparison is not None
    path = Path(args.comparison_inputs)
    retain("comparison", "comparison-inputs.json", path, comparison["inputs"]["afterManifestSha256"])
reference = None
if args.reference:
    directory = Path(args.reference)
    reference = read_json(directory / "report.json")
    index = read_json(directory / "artifacts.json")
    for name, digest in index["artifacts"].items():
        retain("reference", f"reference/{name}", directory / name, digest)
    retain("reference", "reference/artifacts.json", directory / "artifacts.json")
if args.policy:
    path = Path(args.policy)
    retain("policy", "native-policy.json", path)
validation = None
if args.validation:
    directory = Path(args.validation)
    validation = read_json(directory / "summary.json")
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            retain("consumer-validation", "consumer-validation/" + path.relative_to(directory).as_posix(), path)


def make_archive(group, members, suffix=""):
    archive_path = out / (group + "-artifacts" + suffix + ".tar.xz")
    with tarfile.open(archive_path, "w:xz", preset=6, format=tarfile.PAX_FORMAT) as tf:
        for name, (path, digest, size) in members:
            info = tarfile.TarInfo(name)
            info.size = size
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            with path.open("rb") as stream:
                tf.addfile(info, stream)
    if archive_path.stat().st_size > args.max_archive_bytes:
        archive_path.unlink()
        assert len(members) > 1, "a single artifact exceeds the compressed archive bound"
        midpoint = len(members) // 2
        return make_archive(group, members[:midpoint], suffix + "-a") + make_archive(group, members[midpoint:], suffix + "-b")
    with tarfile.open(archive_path, "r:xz") as tf:
        assert tf.getnames() == [name for name, _ in members]
        for name, (_, digest, size) in members:
            data = tf.extractfile(name).read()
            assert len(data) == size and sha(data) == digest, name
    return [{
        "file": archive_path.name,
        "sha256": sha(archive_path.read_bytes()),
        "compressedBytes": archive_path.stat().st_size,
        "files": [{"name": name, "sha256": digest, "bytes": size} for name, (_, digest, size) in members],
    }]


archives = []
for group, files in groups.items():
    archives.extend(make_archive(group, sorted(files.items())))
index = {
    "schema": "semantic-v8-retained-populations/1",
    "digestEncoding": "sha256 of exact uncompressed file bytes; archive digest binds compressed bytes",
    "maximumArchiveBytes": args.max_archive_bytes,
    "archives": archives,
    "populations": [{
        "id": p["id"],
        "producerRevision": p["qualification"]["report"]["producerRevision"],
        "nativePolicy": p["qualification"]["report"]["nativePolicy"],
        "qualificationReportSha256": p["qualification"]["reportSha256"],
        "costReportSha256": p["costs"]["reportSha256"],
        "populationDigest": p["qualification"]["report"]["populationDigest"],
        "tokenizerEvidence": p["costs"]["report"]["tokenizerEvidence"],
    } for p in populations],
}
(out / "archive.json").write_text(json.dumps(index, indent=2) + "\n")
summary = {
    "schema": "semantic-v8-population-results/1",
    "populations": [],
    "model": {"status": "unmeasured", "reason": "This fixed source/native/data population run performs no model optimization or model execution. Separately retained model studies have their own inputs, pins and outcomes."},
    "nativeServing": {"status": "unmeasured"},
    "defaultPromotion": "not-qualified",
}
for item in populations:
    q = item["qualification"]["report"]
    c = item["costs"]["report"]
    rows = q["rows"]
    summary["populations"].append({
        "id": item["id"],
        "producerRevision": q["producerRevision"],
        "nativePolicy": q["nativePolicy"],
        "populationDigest": q["populationDigest"],
        **summarize(rows),
        "costs": c["summary"],
        "families": {family: summarize([r for r in rows if r["family"] == family]) for family in sorted({r["family"] for r in rows})},
        "unqualified": [{key: row.get(key) for key in ["id", "family", "status", "source", "reason", "native", "nativeReason"]} for row in rows if row["source"] != "passed" or row["native"] != "passed"],
    })
if comparison:
    summary["comparison"] = {key: comparison[key] for key in ["inputs", "denominators", "summary", "baselinePopulations", "currentPopulations"]}
if reference:
    summary["reference"] = {key: reference[key] for key in ["producerRevision", "manifestDigest", "registryDigest", "reference", "families", "interactionGroups", "realSource", "comprehension", "native", "modelExecution", "standardPromotion"]}
if validation:
    summary["consumerValidation"] = validation
(out / "report.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({"output": str(out), "archives": [{key: archive[key] for key in ["file", "compressedBytes", "sha256"]} for archive in archives], "files": sum(len(a["files"]) for a in archives)}))
