#!/usr/bin/env python3
"""Run and attest the exact recovery/Promise pair, without inferred test counts."""
from __future__ import annotations

import argparse
import base64
from collections import Counter
import gzip
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


SPEC_PATH = Path(__file__).with_name("combined-v8-gate.json")
SPEC = json.loads(SPEC_PATH.read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    def unique(items):
        value = {}
        for key, item in items:
            require(key not in value, "Repeated gate JSON key: " + key)
            value[key] = item
        return value

    def reject_constant(value):
        raise ValueError("Non-finite gate JSON number: " + value)

    return json.loads(path.read_text(), object_pairs_hook=unique, parse_constant=reject_constant)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def git(root, *args):
    environment = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    return subprocess.check_output(["git", "-C", str(root), *args], env=environment, text=True).strip()


def run_policy(producer, policy_path, expected_native):
    """Authenticate the frozen run policy against its unchanged declaration."""
    declared_path = producer / "contracts/semantic-native-policy-v8.json"
    declared = read(declared_path)
    policy = read(policy_path)
    require(declared.get("schema") == "semantic-native-policy/8" and
            declared.get("consumerRepository") == "werg/megatoken", "Unexpected consumer policy declaration")
    require(isinstance(expected_native, str) and re.fullmatch(r"[0-9a-f]{40}", expected_native) is not None,
            "Exact native commit required")
    require(declared.get("consumerRevision", expected_native) == expected_native,
            "Recorded native revision cannot be overridden")
    require(policy == {**declared, "consumerRevision": expected_native},
            "Run policy differs from its declaration or chosen native revision")
    resolution_path = Path(str(policy_path) + ".resolution.json")
    resolution = read(resolution_path)
    require(resolution.get("schema") == "semantic-native-resolution/1" and
            resolution.get("repository") == policy["consumerRepository"] and
            resolution.get("revision") == expected_native and
            resolution.get("declaredPolicySha256") == sha(declared_path),
            "Run resolution does not authenticate the declared policy and chosen revision")
    kind, ref, branch = resolution.get("kind"), resolution.get("ref"), resolution.get("requestedBranch")
    require((kind == "recorded-revision" and ref == expected_native and "consumerRevision" in declared) or
            (kind == "explicit-ref" and isinstance(ref, str) and
             (ref == expected_native or ref.startswith("refs/heads/"))) or
            (kind == "matching-branch" and isinstance(branch, str) and branch and ref == "refs/heads/" + branch) or
            (kind == "default-head" and ref == "HEAD"), "Invalid run resolution selection")
    return policy, {"policySha256": sha(policy_path), "resolutionSha256": sha(resolution_path),
                    "declaredPolicySha256": sha(declared_path)}


def retained_policy(root, policy_path):
    """Recheck the exact policy and resolution retained with each lane."""
    for suffix in ("", ".resolution.json"):
        source = Path(str(policy_path) + suffix)
        retained = root / ("semantic-native-policy-v8.json" + suffix)
        require(retained.is_file() and retained.read_bytes() == source.read_bytes(),
                "Retained run policy or resolution bytes differ")


def identity(producer, native, expected_producer, expected_native, policy_path):
    policy, bindings = run_policy(producer, policy_path, expected_native)
    result = {**bindings, "gateSpecSha256": sha(SPEC_PATH)}
    for name, root, expected in (("producer", producer, expected_producer), ("native", native, expected_native)):
        require(git(root, "rev-parse", "HEAD") == expected, name + " checkout differs from exact pin")
        require(not git(root, "status", "--porcelain"), name + " checkout has changed files")
        result[name] = {"revision": expected, "tree": git(root, "rev-parse", "HEAD^{tree}")}
    contract = read(producer / "contracts/semantic-execution-v8.json")
    for policy_key, contract_key in (("contractDigest", "digest"), ("fixtureDigest", "fixtureDigest"),
                                     ("interoperabilityDigest", "interoperabilityDigest")):
        require(policy[policy_key] == contract[contract_key] == SPEC[policy_key], policy_key + " differs")
        result[policy_key] = policy[policy_key]
    return result


def payload_parity(producer, native):
    rows = []
    for row in SPEC["payloads"]:
        source, target = producer / row["source"], native / row["native"]
        actual = target.read_bytes()
        require(hashlib.sha256(actual).hexdigest() == row["nativeSha256"], "Native payload changed: " + row["native"])
        decoded = gzip.decompress(base64.b64decode(actual)) if row["encoding"] == "gzip-base64" else actual
        source_bytes = source.read_bytes()
        if row.get("sourceEncoding") == "gzip-base64":
            source_bytes = gzip.decompress(base64.b64decode(source_bytes))
        require(decoded == source_bytes, "Paired payload differs: " + row["source"])
        rows.append({**row, "sourceSha256": sha(source), "sourceBytes": source.stat().st_size,
                     "nativeBytes": len(actual), "decodedBytes": len(decoded)})
    require(len(rows) == 7, "Require one contract and six shared fixture payloads")
    return rows


def installed_consumer(producer, native, replay_sources):
    # -I removes the checkout PYTHONPATH and current-directory import route.
    require(sys.flags.isolated, "Installed consumer probe requires Python -I")
    distribution = importlib.metadata.distribution("megatoken")
    direct = json.loads(distribution.read_text("direct_url.json") or "{}")
    require(not direct.get("dir_info", {}).get("editable"), "Installed probe requires the built wheel")
    installed_root = Path(distribution.locate_file("megatoken")).resolve()
    require(not installed_root.is_relative_to(native), "Installed probe imported the source checkout")
    package_files = []
    for source in git(native, "ls-files", "-z", "--", "src/megatoken").split("\0"):
        if not source or not source.endswith(".py"):
            continue
        relative = Path(source).relative_to("src")
        installed = Path(distribution.locate_file(str(relative))).resolve()
        require(installed.is_relative_to(installed_root), "Wheel path escaped installed package")
        require(installed.is_file() and sha(installed) == sha(native / source), "Installed module differs: " + source)
        package_files.append([str(relative), sha(installed)])
    require(package_files, "No installed Python modules verified")
    for name in ("megatoken", "megatoken.data.native_v8", "megatoken.data.protocol_v8"):
        module = importlib.import_module(name)
        require(Path(module.__file__).resolve().is_relative_to(installed_root), "Import did not use wheel: " + name)
    installed_contract = installed_root / "data/contracts/semantic-execution-v8.json"
    require(installed_contract.read_bytes() == (producer / "contracts/semantic-execution-v8.json").read_bytes(),
            "Installed wheel contract differs")
    receipts = []
    if replay_sources:
        from megatoken.data.native_v8 import validate_v8_artifact

        cases = json.loads(gzip.decompress(base64.b64decode(
            (producer / "test/fixtures/semantic-protocol-region-v8.json.gz.b64").read_bytes())))["cases"]
        require(len(cases) == SPEC["sourceExamples"], "Original source fixture population changed")
        require(len({case["id"] for case in cases}) == len(cases), "Duplicate original source fixture")
        for case in cases:
            receipt = validate_v8_artifact(case["artifact"])
            require(all(receipt["checks"][key] == "passed" for key in ("replay", "contexts", "continuation")),
                    "Installed source replay failed: " + case["id"])
            receipts.append({"id": case["id"], "receipt": receipt})
    return {"importMode": "isolated-installed-wheel", "root": str(installed_root),
            "verifiedPythonFiles": len(package_files),
            "packageFilesSha256": hashlib.sha256(json.dumps(sorted(package_files)).encode()).hexdigest(),
            "contractSha256": sha(installed_contract), "sourceReceipts": receipts}


def attest(args):
    pair = identity(args.producer, args.native, args.producer_revision, args.native_revision, args.native_policy)
    for suffix in ("", ".resolution.json"):
        target = args.out / ("semantic-native-policy-v8.json" + suffix)
        with target.open("xb") as stream:
            stream.write(Path(str(args.native_policy) + suffix).read_bytes())
    retained_policy(args.out, args.native_policy)
    environment = read(args.producer / "profiles/release-environment.lock.json")
    require(platform.python_version() == environment["python"], "Python runtime differs from lock")
    node = subprocess.check_output(["node", "--version"], text=True).strip().removeprefix("v")
    require(node == (args.producer / ".nvmrc").read_text().strip() == environment["node"], "Node runtime differs")
    clock = Path("/proc/self/ns/time")
    require(clock.is_symlink(), "Recovery needs the real kernel time namespace")
    lock = args.producer / "tools/native-consumer/requirements.lock"
    expected = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", lock.read_text(), re.M))
    require(expected, "Dependency lock is empty")
    packages = {name: importlib.metadata.version(name) for name in expected}
    require(packages == expected, "Installed dependency versions differ from the hashed lock")
    report = {"schema": "semantic-v8-combined-pair/1", "lane": args.lane, "pair": pair,
              "github": {key: os.environ.get(key) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_WORKFLOW_REF", "GITHUB_JOB")},
              "runtime": {"node": node, "python": platform.python_version(), "packages": packages,
                          "requirementsLockSha256": sha(lock), "clockIdentity": os.readlink(clock)},
              "payloads": payload_parity(args.producer, args.native),
              "installed": installed_consumer(args.producer, args.native, args.lane == "promise"),
              "fixtureTestImports": "Exact source checkout; wheel module and contract bytes independently matched"}
    write(args.out / "pair-identity.json", report)
    print(json.dumps({"lane": args.lane, "pair": pair, "installedSourceCases": len(report["installed"]["sourceReceipts"])}))


def verify_junit(path, kind, expected):
    tree = ET.parse(path)
    cases = list(tree.getroot().iter("testcase"))
    require(cases, "JUnit contains no actual testcase leaves: " + str(path))
    seen, counts = set(), Counter()
    for case in cases:
        require(not any(case.find(tag) is not None for tag in ("failure", "error", "skipped")),
                "Required test failed, errored or skipped: " + str(case.attrib))
        if kind == "producer":
            source = "test/" + Path(case.get("file", "")).name
        else:
            parts = case.get("classname", "").split(".")
            require(len(parts) >= 2 and parts[0] == "tests", "Missing native testcase module")
            source = "tests/" + parts[1] + ".py"
        key = (source, case.get("classname"), case.get("name"))
        require(case.get("name") and key not in seen, "Duplicate or unnamed JUnit leaf: " + str(key))
        seen.add(key)
        counts[source] += 1
    require(dict(counts) == expected, "Actual per-file leaves differ: " + json.dumps({"actual": counts, "expected": expected}))
    return {"cases": len(cases), "files": dict(counts), "failures": 0, "errors": 0, "skipped": 0, "xmlSha256": sha(path)}


def command(argv, cwd, log, env):
    print(json.dumps({"command": argv, "cwd": str(cwd)}), flush=True)
    with log.open("x") as output:
        with subprocess.Popen(argv, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, bufsize=1) as process:
            for line in process.stdout:
                output.write(line)
                sys.stdout.write(line)
            code = process.wait()
    require(code == 0, "Required command exited " + str(code) + ": " + str(log))


def verify_promise_packets(root):
    populations = [
        ("promise-adoption-source-evidence.json", 15, 15, 423, 65, None),
        ("promise-mutation-profile-evidence.json", 24, 5, 96, None, 19),
        ("promise-object-profile-evidence.json", 22, 5, 51, None, 17),
        ("async-return-adoption-composition-evidence.json", 2, 2, 78, 9, None),
    ]
    result = []
    for name, total, eligible, contexts, cuts, refused in populations:
        packet = read(root / name)
        require([packet[key] for key in ("sourceCases", "actualNativeCases", "generatedContexts")] == [total, eligible, contexts],
                "Source/native population changed: " + name)
        cases, receipts = packet["cases"], packet["nativeReceipts"]
        require(len(cases) == len(receipts) == eligible, "Missing original source or native receipt: " + name)
        names = {case["name"] for case in cases}
        require(len(names) == eligible and names == {receipt["name"] for receipt in receipts}, "Source/receipt identity differs: " + name)
        require(sum(len(case["exported"]["contexts"]) for case in cases) == contexts, "Context packet count differs: " + name)
        require(sum(receipt["counts"]["contexts"] for receipt in receipts) == contexts, "Native context count differs: " + name)
        by_name = {case["name"]: len(case["exported"]["contexts"]) for case in cases}
        require(all(receipt["counts"]["contexts"] == by_name[receipt["name"]] for receipt in receipts),
                "A native receipt belongs to another source context population: " + name)
        require(packet["moduleAdmission"] is False and packet["trainingAdmission"] is False and packet["optimizerUpdates"] == 0,
                "Source composition cannot infer broader admission: " + name)
        if cuts is not None:
            require(packet["snapshotCuts"] == cuts, "Restored source cut count differs: " + name)
        if refused is not None:
            observations = packet["observations"]
            require(packet["refusedSources"] == refused and packet["eligibleSources"] == eligible,
                    "Refusal population changed: " + name)
            require(len(observations) == total and sum(row["refused"] is True for row in observations) == refused,
                    "Missing original refusal observations: " + name)
            require(all(type(row["refused"]) is bool for row in observations)
                    and {row["name"] for row in observations if not row["refused"]} == names,
                    "Eligible source observations differ from replayed cases: " + name)
        result.append({"file": name, "sourceCases": total, "actualNativeCases": eligible, "contexts": contexts,
                       "restoreCuts": cuts, "refusedSources": refused, "sha256": sha(root / name)})
    mutation = read(root / "promise-mutation-profile-evidence.json")
    require(mutation["sourceAdmissionWasAlreadyRefusing"] is True and mutation["directCompilerProfileRefusalAdded"] is True,
            "Earlier descriptor defect classification changed")
    shared = read(root / "promise-adoption-shared-realm-public.json")
    require(len(shared["states"]) == 2 and len(shared["artifact"]["contexts"]) == 19, "Shared realm FIFO proof changed")
    return result


def verify_controlled_position_proof(path, expected_native):
    packet = read(path)
    require(packet["schema"] == "semantic-v8-controlled-position-evidence/1",
            "Missing original controlled position evidence")
    require(packet["sourceCommit"] == expected_native,
            "Controlled position evidence belongs to another native checkout")
    updates, total = packet["optimizerUpdates"], packet["totalOptimizerUpdatesExecuted"]
    require(type(updates) is int and 1 <= updates <= 8 and type(total) is int and total == updates + 1,
            "Controlled optimizer update counts differ from the executed two-phase test")
    boundaries = packet["boundaries"]
    require(boundaries == {"sourceAdmission": "injected fixture receipt",
                           "tokenizerAdmission": "injected byte-fallback fixture",
                           "sourcePopulation": "one controlled prepared fixture, not the 64-source support population"},
            "Controlled fixture evidence cannot grant production admission")
    inventory, comparison = packet["independentPreparedPositionInventory"], packet["comparison"]
    require(type(inventory["physicalTargetRecordCount"]) is int and inventory["physicalTargetRecordCount"] == 4
            and comparison["exactOnePassPreparedTextPositions"] is True
            and comparison["positiveWeightPositionCountsMatch"] is True,
            "Missing independent exact-position comparison")
    phase = packet["phaseTransition"]
    require((phase["from"], phase["to"]) == ("SC", "SE")
            and phase["previousObjectiveArchived"] is True and phase["newStageExposureStartsEmpty"] is True,
            "Missing controlled phase transition")
    for exposure, start, end, count in ((packet["optimizerPositionExposure"], 0, updates, updates),
                                        (phase["positionExposure"], updates, total, 1)):
        require(all(type(exposure[key]) is int and exposure[key] == value for key, value in
                    (("startingGlobalStep", start), ("lastGlobalStep", end), ("optimizerUpdates", count))),
                "Controlled position exposure does not match actual optimizer steps")
    for metadata, step, name in ((packet["checkpointMetadata"], updates, "SC"),
                                 (phase["checkpointMetadata"], total, "SE")):
        require(type(metadata["global_step"]) is int and metadata["global_step"] == step and metadata["phase"] == name,
                "Controlled checkpoint does not match emitted position evidence")
    require(packet["routerInternalPositionCoverage"] == "unmeasured" and packet["learnedSuccess"] is None,
            "Controlled fixture cannot infer learned quality or router coverage")
    return {"file": path.name, "sha256": sha(path), "sourceCommit": packet["sourceCommit"],
            "boundaries": boundaries, "firstPhaseOptimizerUpdates": updates,
            "phaseTransitionOptimizerUpdates": 1, "totalOptimizerUpdatesExecuted": total,
            "routerInternalPositionCoverage": "unmeasured", "learnedSuccess": None}


def lane_environment(args):
    environment = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    return {**environment, "RUNNER_TEMP": str(args.out), "SEMANTIC_V8_NATIVE_POLICY": str(args.native_policy),
            "MEGATOKEN_ROOT": str(args.native), "MEGATOKEN_PYTHON": sys.executable,
            "PYTHONPATH": str(args.native / "src"), "PYTHONDONTWRITEBYTECODE": "1",
            "TRACING_JS_SELF_ROOT": str(args.producer), "MEGATOKEN_NATIVE_SOURCE_PRODUCER": str(args.producer)}


def run_lane(args):
    original = read(args.out / "pair-identity.json")
    require(original["pair"] == identity(args.producer, args.native, args.producer_revision, args.native_revision,
                                         args.native_policy),
            "Pair changed after attestation")
    retained_policy(args.out, args.native_policy)
    env = lane_environment(args)
    results, controlled_training = {}, None
    for kind in ("native", "producer"):
        files = SPEC["lanes"][args.lane][kind]
        if not files:
            continue
        repo = args.native if kind == "native" else args.producer
        require(all((repo / file).is_file() for file in files), "A required test file is absent")
        xml = args.out / (kind + ".xml")
        if kind == "native":
            # Pytest owns this fresh directory; retain the test's original proof,
            # without uploading temporary model checkpoints as gate artifacts.
            with tempfile.TemporaryDirectory(prefix="combined-v8-native-", dir=args.out.parent) as temporary:
                temp = Path(temporary)
                argv = [sys.executable, "-m", "pytest", "-q", *files, "--junitxml=" + str(xml),
                        "--basetemp=" + str(temp / "pytest")]
                command(argv, repo, args.out / (kind + ".log"), env)
                if args.lane == "structural":
                    proofs = list(temp.rglob("position-proof.json"))
                    require(len(proofs) == 1, "Require the actual controlled position test's single emitted proof")
                    retained = args.out / "controlled-position-proof.json"
                    with retained.open("xb") as handle:
                        handle.write(proofs[0].read_bytes())
                    controlled_training = verify_controlled_position_proof(retained, args.native_revision)
        else:
            argv = ["node", "--experimental-vm-modules", "--test", "--test-concurrency=1", "--test-timeout=600000",
                    "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=junit",
                    "--test-reporter-destination=" + str(xml), *files]
            command(argv, repo, args.out / (kind + ".log"), env)
        results[kind] = verify_junit(xml, kind, files)
    packets = verify_promise_packets(args.out) if args.lane == "promise" else []
    require(original["pair"] == identity(args.producer, args.native, args.producer_revision, args.native_revision,
                                         args.native_policy),
            "Test execution changed the exact pair")
    retained_policy(args.out, args.native_policy)
    files = [{"path": str(path.relative_to(args.out)), "bytes": path.stat().st_size, "sha256": sha(path)}
             for path in sorted(args.out.rglob("*")) if path.is_file()]
    write(args.out / "lane-result.json", {"schema": "semantic-v8-combined-lane/1", "status": "passed",
          "lane": args.lane, "pair": original["pair"], "tests": results, "sourcePopulations": packets,
          "controlledTraining": controlled_training, "files": files})


def aggregate(args):
    policy, bindings = run_policy(args.producer, args.native_policy, args.native_revision)
    require(git(args.producer, "rev-parse", "HEAD") == args.producer_revision, "Aggregate producer checkout changed")
    require(not git(args.producer, "status", "--porcelain"), "Aggregate producer is not clean")
    reports, pair, controlled_training = {}, None, None
    for lane in SPEC["lanes"]:
        root = args.artifacts / ("combined-v8-" + lane)
        report = read(root / "lane-result.json")
        require(report["status"] == "passed" and report["lane"] == lane, "Missing successful required lane")
        require(report["pair"]["producer"]["revision"] == args.producer_revision, "Lane checked another producer")
        require(report["pair"]["producer"]["tree"] == git(args.producer, "rev-parse", "HEAD^{tree}"), "Lane checked another producer tree")
        require(report["pair"]["native"]["revision"] == policy["consumerRevision"], "Lane checked another native policy")
        require(all(report["pair"].get(key) == value for key, value in bindings.items()),
                "Lane policy or resolution bytes differ")
        retained_policy(root, args.native_policy)
        require(report["pair"]["gateSpecSha256"] == sha(SPEC_PATH), "Lane used another gate specification")
        require(pair is None or report["pair"] == pair, "Required lanes disagree about exact source trees")
        pair = report["pair"]
        for retained in report["files"]:
            path = (root / retained["path"]).resolve()
            require(path.is_relative_to(root.resolve()) and sha(path) == retained["sha256"], "Retained evidence bytes differ")
        for kind, expected in SPEC["lanes"][lane].items():
            if expected:
                require(verify_junit(root / (kind + ".xml"), kind, expected) == report["tests"][kind], "Lane counts differ")
        installed = read(root / "pair-identity.json")["installed"]
        require(installed["importMode"] == "isolated-installed-wheel", "Missing installed consumer attestation")
        if lane == "promise":
            require(len(installed["sourceReceipts"]) == SPEC["sourceExamples"], "Missing installed source replays")
            verify_promise_packets(root)
        if lane == "structural":
            controlled_training = verify_controlled_position_proof(root / "controlled-position-proof.json",
                                                                   policy["consumerRevision"])
            require(report["controlledTraining"] == controlled_training, "Controlled training summary differs")
        else:
            require(report["controlledTraining"] is None, "Controlled training evidence belongs to the structural lane")
        reports[lane] = report["tests"]
    model_cases = SPEC["lanes"].get("structural", {}).get("native", {}).get("tests/test_semantic_model_v8.py", 0)
    required_groups = {
        "recovery": {kind: sum(sum(groups[kind].values()) for lane, groups in SPEC["lanes"].items()
                               if lane != "promise") - (model_cases if kind == "native" else 0)
                     for kind in ("native", "producer")},
        "promise": {kind: sum(SPEC["lanes"].get("promise", {}).get(kind, {}).values())
                    for kind in ("native", "producer")},
        "modelSelectionEvidence": {"native": model_cases}}
    write(args.out, {"schema": "semantic-v8-combined-qualification/1", "status": "passed", "pair": pair,
          "lanes": reports, "requiredGroups": required_groups,
          "optimizerUpdates": None,
          "optimizerUpdateScope": "No global update tally across all tests; the emitted controlled position proof is counted below",
          "controlledTraining": controlled_training,
          "moduleAdmission": False, "trainingAdmission": False, "learnedQualityClaim": None})
    print(json.dumps({"status": "passed", "pair": pair, "lanes": list(reports)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("attest", "run", "aggregate"))
    parser.add_argument("--producer", type=Path, required=True)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--producer-revision", required=True)
    parser.add_argument("--native-revision", required=True)
    parser.add_argument("--native-policy", type=Path, required=True)
    parser.add_argument("--lane", choices=tuple(SPEC["lanes"]))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    args.producer = args.producer.resolve()
    args.out = args.out.resolve()
    args.native_policy = args.native_policy.resolve(strict=True)
    require(not args.native_policy.is_relative_to(args.producer), "Run policy must be outside the producer checkout")
    if args.command != "aggregate":
        require(args.native and args.native_revision and args.lane, "Lane requires the exact native checkout")
        args.native = args.native.resolve()
        require(not args.native_policy.is_relative_to(args.native), "Run policy must be outside the native checkout")
        args.out.mkdir(parents=True, exist_ok=True)
    else:
        require(args.artifacts is not None, "Aggregate needs all downloaded lane artifacts")
        args.artifacts = args.artifacts.resolve()
    {"attest": attest, "run": run_lane, "aggregate": aggregate}[args.command](args)


if __name__ == "__main__":
    main()
