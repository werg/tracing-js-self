"""Direct V8 text release custody, fresh qualification and bounded restoration.

This driver never imports a V6/V7 compiler, packager or restorer. Archived code
is never used as verification authority. Both commands require exact clean
external producer and native checkouts, and fresh source/native preparation.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

# The checked bytes, not a cached bytecode file or a second read, are executed.
ARCHIVE_SHA256 = "d841fd8493f798870b21bc82bd8902c2f411e945fed6dd6de59dd176d46e465c"
_archive_path = Path(__file__).with_name("release_archive.py")
with _archive_path.open("rb") as _stream:
    _source = _stream.read(1024 * 1024 + 1)
if len(_source) > 1024 * 1024 or hashlib.sha256(_source).hexdigest() != ARCHIVE_SHA256:
    raise ValueError("Pinned neutral release archive implementation changed")
_spec = importlib.util.spec_from_file_location("v8_release_archive", _archive_path)
archive = importlib.util.module_from_spec(_spec)
exec(compile(_source, str(_archive_path), "exec", dont_inherit=True), archive.__dict__)  # noqa: S102 - execute only the bounded, independently pinned source bytes

SCHEMA = "semantic-v8-release/1"
PROFILE = "ordinary-single-rank-fresh-stage-text/1"
DESCRIPTOR = "release-inputs.json"
CAMPAIGN = "proofs/campaign-snapshot.json"
NATIVE = "proofs/native-verification.json"
ENVIRONMENT = "proofs/environment.json"
ORIGINAL_RECIPE = "training/original-recipe.json"
NORMALIZATION = "proofs/recipe-locators.json"
MAX_JSON = 128 * 1024**2
ROLES = {
    "qualification": "source-qualification",
    "tokenizer": "tokenizer/tokenizer.json",
    "prepared": "prepared/000",
    "checkpoint": "training/checkpoint",
    "recipe": "training/recipe.json",
    "served": "serving",
}
IMPLEMENTATIONS = (
    "tools/package-semantic-release-v8.py", "tools/restore-semantic-release-v8.py",
    "tools/semantic_release_v8.py", "tools/release_archive.py",
    "tools/verify-v8-release-campaign.mjs", "src/corpus/campaign-store.mjs",
    "tools/native-consumer/check_environment_v8.py",
    "tools/native-consumer/requirements.lock", "profiles/release-environment-v8.lock.json",
    "npm-shrinkwrap.json",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Repeated release JSON key: " + key)
            result[key] = value
        return result

    def invalid(value):
        raise ValueError("Nonfinite release JSON number: " + value)

    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "Release JSON is not a regular file")
    with path.open("rb") as stream:
        return strict_json(archive.read_bounded(stream, MAX_JSON))


def same_json(left, right):
    return archive.canonical(left) == archive.canonical(right)


def existing(value, *, directory):
    path = archive.no_symlinks(Path(value))
    require(path.is_dir() if directory else path.is_file(), "Required release input is absent")
    return path


def new_directory(value, *, excluded=()):
    path = archive.no_symlinks(Path(value))
    require(not path.exists(), "Release output must be a new directory")
    for source in excluded:
        require(not path.is_relative_to(source) and not source.is_relative_to(path),
                "Release output and input paths must be disjoint")
    require(path.parent.is_dir(), "Release output parent must already exist")
    path.mkdir(mode=0o700)
    return path


def repository(root, expected=None):
    root = existing(root, directory=True)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, env=environment,
                                       text=True, timeout=30).strip()

    revision = git("rev-parse", "HEAD")
    require(re.fullmatch(r"[a-f0-9]{40}", revision) is not None and
            (expected is None or revision == expected) and
            Path(git("rev-parse", "--show-toplevel")).resolve() == root.resolve() and
            not git("status", "--porcelain", "--untracked-files=all"),
            "Release work requires exact clean repository checkouts")
    return {"revision": revision, "tree": git("rev-parse", "HEAD^{tree}"), "clean": True}


def implementations(producer):
    return {name: archive.file_receipt(archive.inside(producer, name)) for name in IMPLEMENTATIONS}


def bounded_files(root):
    """Check bounds before hashing or copying; include hidden regular files."""
    root = existing(root, directory=root.is_dir())
    files, directories, total = [], 0, 0
    pending = [root]
    while pending:
        path = pending.pop()
        mode = path.lstat().st_mode
        require(stat.S_ISREG(mode) or stat.S_ISDIR(mode), "Release input contains a link or special file")
        if stat.S_ISDIR(mode):
            directories += 1
            require(directories <= archive.DEFAULT_LIMITS["files"], "Too many release input directories")
            pending.extend(sorted(path.iterdir(), reverse=True))
        else:
            size = path.stat().st_size
            total += size
            files.append(path)
            require(size <= archive.DEFAULT_LIMITS["memberBytes"] and
                    total <= archive.DEFAULT_LIMITS["unpackedBytes"] and
                    len(files) <= archive.DEFAULT_LIMITS["files"], "Release input exceeds fixed archive bounds")
    return sorted(files)


def inventory(roots):
    for root in roots.values():
        bounded_files(root)
    rows, sources = archive.inventory(roots)
    require(len(rows) < archive.DEFAULT_LIMITS["files"] and
            sum(row["bytes"] for row in rows) < archive.DEFAULT_LIMITS["unpackedBytes"],
            "Combined release inputs exceed archive bounds")
    return rows, sources


def bundle_inventory(root):
    rows, sources = inventory({"bundle": root})
    return [{**row, "path": row["path"].removeprefix("bundle/")} for row in rows], {
        name.removeprefix("bundle/"): path for name, path in sources.items()
    }


@contextmanager
def locked_campaign(root):
    lock_path = archive.inside(root, "progress/.campaign.lock")
    require(lock_path.is_file(), "Original qualification lock is missing; no repair is allowed")
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Qualification still has an active writer") from error
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def run_checked(command, directory, evidence, name, *, environment=None, timeout=3600):
    stdout, stderr = evidence / (name + ".stdout.log"), evidence / (name + ".stderr.log")
    with stdout.open("xb") as out, stderr.open("xb") as err:
        result = subprocess.run(command, cwd=directory, env=environment, stdout=out, stderr=err,
                                timeout=timeout, check=False)
    require(result.returncode == 0, f"Release {name} check failed; original logs retained in {evidence}")


def campaign_snapshot(producer, qualification, evidence, name):
    output = evidence / (name + ".json")
    run_checked(["node", str(producer / "tools/verify-v8-release-campaign.mjs"), str(qualification),
                 "--output", str(output)], producer, evidence, name)
    snapshot = read_json(output)
    require(snapshot.get("schema") == "semantic-v8-release-campaign-snapshot/1" and
            snapshot.get("status") == "verified" and snapshot.get("preparationOnly") is False,
            "Release needs a complete source/native qualification journal")
    return snapshot, output


def original_source_members(snapshot, qualification):
    """Bind each selected case to its declared original inputs before replay.

    The journal proves custody, not task/artifact correspondence. This first
    release profile supports explicit original source tasks, including ordered
    repeated invocations; module-task correspondence requires another profile.
    """
    files = {row["path"]: row for row in snapshot["files"]}

    def retained_json(name):
        require(name in files, "Original source input is outside the complete campaign inventory")
        path = archive.no_symlinks(archive.inside(qualification, name))
        with path.open("rb") as stream:
            data = archive.read_bounded(stream, MAX_JSON)
        require(len(data) == files[name]["bytes"] and hashlib.sha256(data).hexdigest() == files[name]["sha256"],
                "Original source input differs from the complete campaign inventory")
        return strict_json(data)

    population, report = retained_json("population.json"), retained_json("report.json")
    tasks = {task["fixture"]["id"]: task for task in population["tasks"]}
    rows = {row["id"]: row for row in report["rows"]}
    require(len(tasks) == len(population["tasks"]) and len(rows) == len(report["rows"]) and
            list(tasks) == list(rows) == [case["id"] for case in snapshot["cases"]] and
            set(snapshot["selectedCaseIds"]) <= tasks.keys(),
            "Original source tasks and committed case membership differ")
    require(report.get("familyRegistryArtifact") == "family-registry.json",
            "Release source tasks require their explicit frozen family registry")
    registry = retained_json("family-registry.json")
    require(registry.get("schema") == "semantic-region-family-registry/1" and
            registry.get("digest") == population.get("registryDigest") == report.get("registryDigest"),
            "Original source registry differs from the frozen campaign")
    registered = {row["id"]: row for row in registry["sources"]}
    require(len(registered) == len(registry["sources"]), "Original source registry repeats a physical source ID")

    def ancestry(values, family):
        require(isinstance(values, list) and len(values) <= 1024 and
                all(isinstance(value, str) and 0 < len(value) <= 256 for value in values),
                "Original source ancestry is outside the declared profile")
        return sorted(set(values) - {family})

    def original_call(fixture, reference):
        require(isinstance(reference, dict) and isinstance(fixture.get("source"), str) and
                isinstance(fixture.get("entry"), str) and isinstance(fixture.get("argsGraph"), dict) and
                reference.get("source") == fixture["source"] and reference.get("entry") == fixture["entry"] and
                same_json(reference.get("inputGraph"), fixture["argsGraph"]),
                "Original source text, entry or argument graph differs from its frozen task")
        expected_fixture = fixture.get("fixture", {"calls": [], "settlementOrder": None})
        # Direct protocol references omit an empty host plan. A nonempty plan
        # must always be represented and compared, including settlement order.
        actual_fixture = reference.get("fixture", {"calls": [], "settlementOrder": None})
        require(same_json(actual_fixture, expected_fixture), "Original source host fixture differs from its frozen task")
        seeds = fixture.get("seeds")
        require(seeds is None or isinstance(seeds, dict), "Original source RNG settings are undeclared")
        expected_seed = fixture.get("randomSeed")
        if expected_seed is None:
            expected_seed = (seeds or {}).get("guestRng")
        require(same_json(reference.get("randomSeed"), expected_seed),
                "Original source RNG seed differs from its frozen task")

    members = []
    for case in snapshot["cases"]:
        if not case["selected"]:
            continue
        task, row = tasks[case["id"]], rows[case["id"]]
        fixture = task["fixture"]
        require(task.get("kind") == "source" and task.get("traceVersion") == 8,
                "This release profile requires original source tasks; module-task correspondence is undeclared")
        document = retained_json(case["sourceArtifact"])
        side = document.get("sidecar", {})
        original = side if side.get("schema") == "semantic-protocol-host-region-evidence/1" else \
            side.get("sourceArtifact", {}).get("sidecar", {})
        reference, binding, identity = original.get("referenceInput"), side.get("datasetBinding", {}), side.get("splitIdentity", {})
        source_id, family = row.get("sourceId"), fixture.get("family")
        require(isinstance(source_id, str) and source_id in registered and isinstance(family, str) and bool(family) and
                document.get("public", {}).get("schema") == "semantic-execution/8" and
                binding.get("sourceId") == identity.get("sourceId") == source_id and
                binding.get("registryDigest") == identity.get("registryDigest") == registry["digest"] and
                same_json(identity.get("registry"), registry) and
                row.get("split") == binding.get("split") == identity.get("split") and
                row.get("split") in {"train", "validation", "test"},
                "Original task physical source, registry or split differs from its artifact")
        registered_source = registered[source_id]
        require(row.get("family") == side.get("family") == side.get("sourceFamily") ==
                original.get("sourceFamily") == registered_source.get("family") == family and
                original.get("sourceLineage", family) == family and
                ancestry(original.get("ancestorIds", []), family) == ancestry(fixture.get("ancestorIds", []), family) ==
                ancestry(registered_source.get("ancestors", []), family),
                "Original source family or ancestry differs from its frozen task")
        require(original.get("producerRevision") == task.get("producerRevision") == snapshot["producerRevision"] and
                original.get("taskId", fixture["id"]) == fixture["id"],
                "Original source producer or task identity differs from its frozen task")
        require(isinstance(reference, dict) and reference.get("source") == fixture.get("source") ==
                registered_source.get("source") and reference.get("entry") == fixture.get("entry") ==
                registered_source.get("entry"), "Original source reference differs from its registered frozen task")
        if "sessionCases" in fixture:
            calls = fixture["sessionCases"]
            require(isinstance(calls, list) and calls and isinstance(reference.get("invocations"), list) and
                    len(calls) == len(reference["invocations"]),
                    "Original source invocation count differs from its frozen task")
            for call, observed in zip(calls, reference["invocations"], strict=True):
                require(isinstance(call, dict) and "sessionCases" not in call and call.get("family") == family and
                        call.get("source") == fixture["source"] and call.get("entry") == fixture["entry"],
                        "Original repeated source call is outside its declared family")
                original_call(call, observed)
        else:
            require("invocations" not in reference, "Original source gained undeclared repeated invocations")
            original_call(fixture, reference)
        teacher = fixture.get("orchestrationTeacher", False)
        require(type(teacher) is bool and ("orchestrationTranscript" in side) == teacher,
                "Original source orchestration teacher differs from its frozen task")
        members.append({"caseId": case["id"], "sourceId": source_id,
                        "path": ROLES["qualification"] + "/" + case["sourceArtifact"]})
    return members


def descriptor_from_campaign(snapshot, producer, native, qualification):
    policy = snapshot["nativePolicy"]
    require(snapshot["producerRevision"] == producer["revision"] and
            policy["consumerRevision"] == native["revision"], "Qualification belongs to another source pair")
    selected = [row for row in snapshot["cases"] if row["selected"]]
    require([row["id"] for row in selected] == snapshot["selectedCaseIds"] and selected and
            all(row["status"] == "admitted" and row["source"] == row["native"] == "passed"
                for row in selected), "Every selected release source must be source-qualified and native-admitted")
    roles = {key: value for key, value in ROLES.items() if key != "prepared"}
    # Original preparation binds the complete source input bytes. The admitted
    # copy remains retained evidence, not a substitute for the declared task.
    roles["prepared"] = [{"path": ROLES["prepared"],
                          "sourceArtifacts": original_source_members(snapshot, qualification)}]
    return {"schema": "semantic-v8-release-inputs/1", "producerRevision": producer["revision"],
            "consumerRevision": native["revision"], "roles": roles,
            **{name: snapshot[name] for name in ("contractDigest", "fixtureDigest", "interoperabilityDigest")}}


def portable_recipe(original):
    require(isinstance(original, dict) and isinstance(original.get("codec"), str) and
            isinstance(original.get("datasets"), list) and len(original["datasets"]) == 1 and
            isinstance(original["datasets"][0], str), "Release recipe requires exactly one explicit prepared input")
    normalized = {**original, "codec": ROLES["tokenizer"], "datasets": [ROLES["prepared"]],
                  "output": "training/resume-output"}
    return normalized, {"schema": "semantic-v8-release-locators/1",
                        "originalRecipe": ORIGINAL_RECIPE, "portableRecipe": ROLES["recipe"],
                        "changes": {name: {"original": original.get(name), "bundled": normalized[name]}
                                    for name in ("codec", "datasets", "output")},
                        "allOtherFieldsUnchanged": True}


def verify_recipe(root):
    normalized, receipt = portable_recipe(read_json(root / ORIGINAL_RECIPE))
    require(same_json(read_json(root / ROLES["recipe"]), normalized) and
            same_json(read_json(root / NORMALIZATION), receipt),
            "Portable recipe changed settings beyond its three recorded physical locators")


def native_checks(root, descriptor, producer, native, python, evidence, source_timeout):
    env = {**os.environ, "PYTHONPATH": str(native / "src"), "PYTHONDONTWRITEBYTECODE": "1"}
    environment_output = evidence / "environment.json"
    run_checked([python, str(producer / "tools/native-consumer/check_environment_v8.py"),
                 "--megatoken", str(native), "--policy", str(root / "source-qualification/report.json"),
                 "--tokenizer", str(root / ROLES["tokenizer"]), "--out", str(environment_output)],
                native, evidence, "environment", environment=env, timeout=600)
    environment_receipt = read_json(environment_output)
    require(environment_receipt.get("schema") == "semantic-v8-release-environment/1" and
            environment_receipt.get("status") == "verified", "Native environment was not verified")
    output = evidence / "native-verification.json"
    run_checked([python, str(native / "scripts/verify_semantic_v8_release.py"),
                 "--bundle-root", str(root), "--descriptor", DESCRIPTOR,
                 "--producer-root", str(producer), "--consumer-revision", descriptor["consumerRevision"],
                 "--source-recheck-timeout-seconds", str(source_timeout), "--output", str(output)],
                native, evidence, "native", environment=env,
                timeout=len(descriptor["roles"]["prepared"][0]["sourceArtifacts"]) * (source_timeout + 60) + 900)
    result = read_json(output)
    require(result.get("schema") == "semantic-v8-native-release-verification/1" and
            result.get("status") == "passed" and result.get("optimizerUpdatesPerformed") == 0 and
            result.get("decoderForwardPassesPerformed") == 0 and result.get("learnedSuccess") is None and
            result.get("defaultPromotion") is False,
            "Fresh source/native/data/checkpoint/served verification did not pass")
    return result, output, environment_output


def native_summary(report):
    """Only semantic checks are compared across physical relocation of a bundle."""
    return {name: report[name] for name in (
        "schema", "status", "descriptorSha256", "producer", "consumer", "contractDigest",
        "fixtureDigest", "interoperabilityDigest", "sourceArtifacts", "preparedEquivalence",
        "checkpoint", "served", "optimizerUpdatesPerformed", "decoderForwardPassesPerformed",
        "routerInternalPositionCoverage", "acceptedHistoryRecovery", "learnedSuccess", "defaultPromotion",
    )}


def copy_inputs(rows, sources, destination):
    for row in rows:
        target = archive.inside(destination, row["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        source = sources[row["path"]]
        with source.open("rb") as incoming, target.open("xb") as outgoing:
            before = os.fstat(incoming.fileno())
            require(stat.S_ISREG(before.st_mode) and not source.is_symlink() and before.st_size == row["bytes"],
                    "Release copy input changed type or size")
            copied = 0
            while block := incoming.read(min(archive.CHUNK_BYTES, row["bytes"] - copied + 1)):
                copied += len(block)
                require(copied <= row["bytes"], "Release input grew during copying")
                outgoing.write(block)
            outgoing.flush()
            os.fsync(outgoing.fileno())
            require(archive.file_identity(before) == archive.file_identity(os.fstat(incoming.fileno())),
                    "Release input changed during copying")
        require(archive.file_receipt(target) == {key: row[key] for key in ("bytes", "sha256")},
                "Copied release input differs from the initial inventory")


def provenance(snapshot):
    return {name: snapshot[name] for name in (
        "identityDigest", "populationDigest", "progressDigest", "journalHead", "declared",
        "selectedCaseIds", "sourceQualified", "nativeAdmitted", "counts", "attemptCounts",
        "auxiliaryFiles",
    )}


def validate_manifest(manifest):
    require(isinstance(manifest, dict) and set(manifest) == {
        "schema", "profile", "producer", "consumer", "descriptor", "descriptorSha256",
        "qualification", "nativeVerification", "environment", "implementations", "files",
        "limits", "scope", "optimizerUpdatesPerformed", "decoderForwardPassesPerformed",
        "learnedSuccess", "defaultPromotion", "identityDigest",
    } and manifest["schema"] == SCHEMA and manifest["profile"] == PROFILE,
            "Archive is not the supported direct V8 release profile")
    require(manifest["descriptor"] == DESCRIPTOR and
            same_json(manifest["limits"], archive.DEFAULT_LIMITS) and
            type(manifest["optimizerUpdatesPerformed"]) is int and manifest["optimizerUpdatesPerformed"] == 0 and
            type(manifest["decoderForwardPassesPerformed"]) is int and manifest["decoderForwardPassesPerformed"] == 0 and
            manifest["learnedSuccess"] is None and manifest["defaultPromotion"] is False,
            "Release manifest changed its fixed profile or qualification claims")
    for name in ("producer", "consumer"):
        value = manifest[name]
        require(isinstance(value, dict) and set(value) == {"revision", "tree", "clean"} and
                value["clean"] is True and all(re.fullmatch(r"[a-f0-9]{40}", value[key] or "")
                                               for key in ("revision", "tree")),
                "Release manifest has no exact clean source identity")
    expected = archive.validate_inventory(manifest["files"])
    require(all(name in expected for name in (DESCRIPTOR, CAMPAIGN, NATIVE, ENVIRONMENT,
                                              ORIGINAL_RECIPE, NORMALIZATION, ROLES["recipe"])),
            "Release manifest omits qualification evidence or original recipe")
    require(manifest["descriptorSha256"] == expected[DESCRIPTOR]["sha256"] and
            manifest["nativeVerification"]["path"] == NATIVE and
            manifest["environment"]["path"] == ENVIRONMENT and
            manifest["nativeVerification"]["sha256"] == expected[NATIVE]["sha256"] and
            manifest["environment"]["sha256"] == expected[ENVIRONMENT]["sha256"] and
            manifest["nativeVerification"]["bytes"] == expected[NATIVE]["bytes"] and
            manifest["environment"]["bytes"] == expected[ENVIRONMENT]["bytes"],
            "Release verification receipts differ from the manifest inventory")
    return manifest


def verified_archive(path, expected_sha):
    require(isinstance(expected_sha, str) and re.fullmatch(r"[a-f0-9]{64}", expected_sha),
            "Restore requires an independently retained archive SHA-256")
    path = existing(path, directory=False)
    require(path.stat().st_size <= archive.DEFAULT_LIMITS["archiveBytes"], "Archive exceeds fixed byte bound")
    require(archive.file_receipt(path)["sha256"] == expected_sha, "Archive differs from its external SHA-256 pin")
    manifest, manifest_sha = archive.bounded_inventory(path, archive.DEFAULT_LIMITS)
    # The neutral helper preserves the old wrappers' parser behavior. This V8
    # boundary additionally refuses duplicate keys and nonfinite JSON values.
    with archive.bounded_tar(path, archive.DEFAULT_LIMITS) as members:
        for member in members:
            if member.name == "release-manifest.json":
                strict_manifest = strict_json(archive.read_bounded(members.extractfile(member), archive.MAX_MANIFEST_BYTES))
                require(same_json(strict_manifest, manifest), "Release manifest changed between bounded reads")
                break
    validate_manifest(manifest)
    verification = archive.verify_archive(path, opener=lambda value: archive.bounded_tar(value, archive.DEFAULT_LIMITS))
    require(verification["archiveSha256"] == expected_sha and
            verification["identityDigest"] == manifest["identityDigest"],
            "Archive changed during independent member verification")
    return {"manifest": manifest, "manifestSha256": manifest_sha,
            "verification": verification, "limits": dict(archive.DEFAULT_LIMITS)}


def source_roots(args):
    producer = existing(args.producer_root, directory=True)
    native = existing(args.megatoken, directory=True)
    require(producer.resolve() == Path(__file__).resolve().parents[1],
            "Use the release driver from the exact declared producer checkout")
    require(producer != native and not producer.is_relative_to(native) and not native.is_relative_to(producer),
            "Producer and native source roots must be disjoint")
    require(type(args.source_recheck_timeout_seconds) is int and 1 <= args.source_recheck_timeout_seconds <= 900,
            "Source recheck timeout must be between one and 900 seconds")
    return producer, native


def package_release(args):
    producer_root, native_root = source_roots(args)
    producer, native = repository(producer_root), repository(native_root)
    implementation = implementations(producer_root)
    inputs = {
        ROLES["qualification"]: existing(args.qualification, directory=True),
        ROLES["prepared"]: existing(args.prepared, directory=True),
        ROLES["tokenizer"]: existing(args.tokenizer, directory=False),
        ROLES["checkpoint"]: existing(args.checkpoint, directory=True),
        ROLES["served"]: existing(args.served, directory=True),
        ORIGINAL_RECIPE: existing(args.recipe, directory=False),
    }
    out = new_directory(args.out, excluded=[producer_root, native_root, *inputs.values()])
    stage, evidence = out / "payload", out / "verification"
    stage.mkdir(mode=0o700)
    evidence.mkdir(mode=0o700)
    with locked_campaign(inputs[ROLES["qualification"]]):
        snapshot, snapshot_file = campaign_snapshot(producer_root, inputs[ROLES["qualification"]], evidence, "original-campaign")
        descriptor = descriptor_from_campaign(snapshot, producer, native, inputs[ROLES["qualification"]])
        rows, sources = inventory(inputs)
        copy_inputs(rows, sources, stage)
        (stage / "proofs").mkdir(exist_ok=True)
        shutil.copyfile(snapshot_file, stage / CAMPAIGN)
        recipe, normalization = portable_recipe(read_json(stage / ORIGINAL_RECIPE))
        archive.write_json(stage / ROLES["recipe"], recipe)
        archive.write_json(stage / NORMALIZATION, normalization)
        archive.write_json(stage / DESCRIPTOR, descriptor)
        with locked_campaign(stage / ROLES["qualification"]):
            copied, _ = campaign_snapshot(producer_root, stage / ROLES["qualification"], evidence, "copied-campaign")
            require(same_json(copied, snapshot), "Copied qualification journal differs from original")
            require(same_json(descriptor_from_campaign(copied, producer, native, stage / ROLES["qualification"]), descriptor),
                    "Copied original task/source membership differs")
            verify_recipe(stage)
            result, native_file, environment_file = native_checks(
                stage, descriptor, producer_root, native_root, args.python, evidence,
                args.source_recheck_timeout_seconds)
            shutil.copyfile(native_file, stage / NATIVE)
            shutil.copyfile(environment_file, stage / ENVIRONMENT)
            require(inventory(inputs)[0] == rows, "Original release inputs changed during verification")
            require(repository(producer_root, producer["revision"]) == producer and
                    repository(native_root, native["revision"]) == native and
                    implementations(producer_root) == implementation, "Source implementation changed during verification")
            files, staged_sources = bundle_inventory(stage)
            payload = {
                "schema": SCHEMA, "profile": PROFILE, "producer": producer, "consumer": native,
                "descriptor": DESCRIPTOR, "descriptorSha256": archive.file_receipt(stage / DESCRIPTOR)["sha256"],
                "qualification": provenance(snapshot),
                "nativeVerification": {"path": NATIVE, **archive.file_receipt(stage / NATIVE), "summary": native_summary(result)},
                "environment": {"path": ENVIRONMENT, **archive.file_receipt(stage / ENVIRONMENT)},
                "implementations": implementation, "files": files, "limits": dict(archive.DEFAULT_LIMITS),
                "optimizerUpdatesPerformed": 0, "decoderForwardPassesPerformed": 0,
                "learnedSuccess": None, "defaultPromotion": False,
                "scope": "Complete selected qualification journal and one ordinary text checkpoint/served bundle; fresh source/data verification and exact loaded state. No live-history recovery, portable-container or default-promotion qualification.",
            }
            destination = out / "semantic-v8-release.tar.gz"
            manifest = archive.write_archive(destination, payload, staged_sources)
            validate_manifest(manifest)
            checksum = archive.file_receipt(destination)["sha256"]
            verified = verified_archive(destination, checksum)
            require(bundle_inventory(stage)[0] == files and inventory(inputs)[0] == rows,
                    "Release inputs changed during archive creation")
    receipt = {"schema": "semantic-v8-release-package-result/1", "status": "verified",
               "archive": {"path": destination.name, **archive.file_receipt(destination)},
               "manifestIdentity": manifest["identityDigest"], "memberVerification": verified["verification"],
               "sourcePair": {"producer": producer, "consumer": native},
               "optimizerUpdatesPerformed": 0, "decoderForwardPassesPerformed": 0,
               "learnedSuccess": None, "defaultPromotion": False}
    archive.write_json(out / "package-result.json", receipt)
    return receipt


def restore_release(args):
    producer_root, native_root = source_roots(args)
    archive_path = existing(args.archive, directory=False)
    verified = verified_archive(archive_path, args.expected_archive_sha256)
    manifest = verified["manifest"]
    producer = repository(producer_root, manifest["producer"]["revision"])
    native = repository(native_root, manifest["consumer"]["revision"])
    require(producer == manifest["producer"] and native == manifest["consumer"] and
            implementations(producer_root) == manifest["implementations"],
            "Restore requires the original exact trusted implementations")
    destination = archive.no_symlinks(Path(args.out))
    require(not destination.exists() and destination.parent.is_dir(), "Restore destination must be new with an existing parent")
    for path in (producer_root, native_root, archive_path):
        require(not destination.is_relative_to(path) and not path.is_relative_to(destination),
                "Restore destination overlaps trusted sources or the original archive")
    evidence = new_directory(args.evidence_out, excluded=[producer_root, native_root, archive_path, destination])
    archive.extract_verified(archive_path, destination, verified)
    descriptor = read_json(destination / DESCRIPTOR)
    with locked_campaign(destination / ROLES["qualification"]):
        snapshot, _ = campaign_snapshot(producer_root, destination / ROLES["qualification"], evidence, "restored-campaign")
        original_snapshot = read_json(destination / CAMPAIGN)
        require(same_json(snapshot, original_snapshot) and same_json(provenance(snapshot), manifest["qualification"]) and
                same_json(descriptor, descriptor_from_campaign(snapshot, producer, native, destination / ROLES["qualification"])),
                "Restored descriptor/selection differs from the complete qualification journal")
        verify_recipe(destination)
        previous = read_json(destination / NATIVE)
        require(same_json(native_summary(previous), manifest["nativeVerification"]["summary"]),
                "Archived native report differs from its declared semantic result")
        current, _, _ = native_checks(destination, descriptor, producer_root, native_root, args.python,
                                      evidence, args.source_recheck_timeout_seconds)
        require(same_json(native_summary(current), native_summary(previous)),
                "Fresh restored source/data/model verification differs from the packaged result")
        integrity = archive.verify_restored_files(destination, verified)
        require(repository(producer_root, producer["revision"]) == producer and
                repository(native_root, native["revision"]) == native and
                implementations(producer_root) == manifest["implementations"] and
                archive.file_receipt(archive_path)["sha256"] == args.expected_archive_sha256,
                "Trusted sources or original archive changed during restore")
    receipt = {"schema": "semantic-v8-release-restore-result/1", "status": "verified",
               "archiveSha256": args.expected_archive_sha256, "manifestIdentity": manifest["identityDigest"],
               "sourcePair": {"producer": producer, "consumer": native}, "restoredFiles": integrity,
               "freshSourceNativePreparation": True, "actualCheckpointAndServedStateCompared": True,
               "optimizerUpdatesPerformed": 0, "decoderForwardPassesPerformed": 0,
               "acceptedHistoryRecovery": "unmeasured", "learnedSuccess": None, "defaultPromotion": False}
    archive.write_json(evidence / "restore-result.json", receipt)
    return receipt


def main(mode, argv=None):
    require(mode in {"package", "restore"}, "Unknown direct V8 release command")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer-root", type=Path, required=True)
    parser.add_argument("--megatoken", type=Path, required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--source-recheck-timeout-seconds", type=int, default=30)
    parser.add_argument("--out", type=Path, required=True)
    if mode == "package":
        for name in ("qualification", "prepared", "tokenizer", "checkpoint", "served", "recipe"):
            parser.add_argument("--" + name, type=Path, required=True)
    else:
        parser.add_argument("--archive", type=Path, required=True)
        parser.add_argument("--expected-archive-sha256", required=True)
        parser.add_argument("--evidence-out", type=Path, required=True)
    args = parser.parse_args(argv)
    result = package_release(args) if mode == "package" else restore_release(args)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0
