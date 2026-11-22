#!/usr/bin/env python3
"""Audit retained original GitHub artifacts without rerunning or editing them."""
from __future__ import annotations

import base64
from collections import Counter
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def audit(root):
    manifest = json.loads((root / "manifest.json").read_text())
    originals = {}
    for row in manifest["files"]:
        retained = (root / row["path"]).read_bytes()
        require(len(retained) == row["bytes"] and digest(retained) == row["sha256"], "Retained file changed: " + row["path"])
        if row.get("encoding") == "gzip-base64":
            retained = gzip.decompress(base64.b64decode(retained, validate=False))
            require(len(retained) == row["originalBytes"] and digest(retained) == row["originalSha256"],
                    "Original bytes changed: " + row["path"])
        name = row.get("originalPath", row["path"])
        require(name not in originals, "Duplicate retained original: " + name)
        originals[name] = retained

    def read(name):
        return json.loads(originals[name])

    run, jobs = read("original-run.json"), read("original-jobs.json")["jobs"]
    require(run["id"] == manifest["runId"] and run["head_sha"] == manifest["producerRevision"], "Wrong original workflow run")
    require(run["status"] == "completed" and run["conclusion"] == "success", "Workflow did not complete successfully")
    spec, policy = read("original-gate-spec.json"), read("original-native-policy.json")
    require(policy["consumerRevision"] == manifest["nativeRevision"], "Original policy pins another native source")
    required_jobs = {"Required " + lane + " controls" for lane in spec["lanes"]} | {"Required exact combined pair"}
    require({job["name"] for job in jobs} == required_jobs and len(jobs) == 7, "Missing or duplicate required job")
    require(all(job["status"] == "completed" and job["conclusion"] == "success" for job in jobs), "A required job was not successful")
    require(all(originals.get("jobs/" + str(job["id"]) + ".log") for job in jobs), "A complete original job log is absent")
    artifacts = read("original-artifacts.json")["artifacts"]
    expected_artifacts = {"combined-v8-" + lane for lane in spec["lanes"]} | {"combined-v8-qualification"}
    require({a["name"] for a in artifacts} == expected_artifacts and len(artifacts) == 7, "Missing or duplicate original artifact")
    archives = {}
    for item in artifacts:
        raw = originals["archives/" + item["name"] + ".zip"]
        require(item["workflow_run"]["id"] == run["id"] and item["workflow_run"]["head_sha"] == run["head_sha"], "Artifact belongs to another run")
        require(len(raw) == item["size_in_bytes"] and "sha256:" + digest(raw) == item["digest"], "Original ZIP differs from GitHub metadata")
        archive = zipfile.ZipFile(io.BytesIO(raw))
        require(len(set(archive.namelist())) == len(archive.namelist()), "Duplicate ZIP entry")
        archives[item["name"]] = archive

    source_files = read("original-native-module-manifest.json")
    require(source_files["revision"] == policy["consumerRevision"], "Native module manifest belongs to another commit")
    require(len(source_files["files"]) == 267, "Native module population changed")
    require(source_files["packageFilesSha256"] == digest(json.dumps(sorted(source_files["files"])).encode()), "Module manifest hash differs")
    expected_packages = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", originals["original-requirements.lock"].decode(), re.M))
    fixture = read("original-protocol-fixture.json")["cases"]
    require(len(fixture) == spec["sourceExamples"] == 23, "Original source fixture population changed")
    source_contexts = {case["id"]: len(case["artifact"]["contexts"]) for case in fixture}
    require(len(source_contexts) == 23 and sum(source_contexts.values()) == 849, "Original source contexts changed")
    lanes, pair, installed_sources, controlled = {}, None, None, None
    for lane, expected in spec["lanes"].items():
        archive = archives["combined-v8-" + lane]
        report = json.loads(archive.read("lane-result.json"))
        identity = json.loads(archive.read("pair-identity.json"))
        current = report["pair"]
        require(report["status"] == "passed" and report["lane"] == lane, "Wrong successful lane record")
        require(identity["pair"] == current and identity["lane"] == lane, "Lane identity differs")
        require(identity["github"]["GITHUB_RUN_ID"] == str(run["id"])
                and identity["github"]["GITHUB_SHA"] == manifest["producerRevision"], "Attestation belongs to another hosted run")
        require(current["producer"] == {"revision": manifest["producerRevision"], "tree": manifest["producerTree"]}, "Wrong producer commit or tree")
        require(current["native"] == {"revision": manifest["nativeRevision"], "tree": manifest["nativeTree"]}, "Wrong native commit or tree")
        require(current["policySha256"] == digest(originals["original-native-policy.json"]), "Policy bytes differ")
        require(current["gateSpecSha256"] == digest(originals["original-gate-spec.json"]), "Gate specification differs")
        require(pair is None or pair == current, "Lanes use different exact source pairs")
        pair = current
        for key in ("contractDigest", "fixtureDigest", "interoperabilityDigest"):
            require(current[key] == policy[key] == spec[key], "Paired digest differs: " + key)
        for row in report["files"]:
            raw = archive.read(row["path"])
            require(len(raw) == row["bytes"] and digest(raw) == row["sha256"], "Retained lane file differs")
        counts = {}
        for kind, files in expected.items():
            if not files:
                continue
            xml = archive.read(kind + ".xml")
            cases = list(ET.fromstring(xml).iter("testcase"))
            observed, unique = Counter(), set()
            for case in cases:
                require(not any(case.find(tag) is not None for tag in ("failure", "error", "skipped")), "Failed, errored, or skipped required case")
                if kind == "producer":
                    source = "test/" + Path(case.get("file", "")).name
                else:
                    module = case.get("classname", "").split(".")
                    require(len(module) >= 2 and module[0] == "tests", "Missing native module identity")
                    source = "tests/" + module[1] + ".py"
                identity_key = (source, case.get("classname"), case.get("name"))
                require(case.get("name") and identity_key not in unique, "Unnamed or duplicate test leaf")
                unique.add(identity_key)
                observed[source] += 1
            require(dict(observed) == files, "Actual per-file leaves differ: " + lane + "/" + kind)
            actual = {"cases": len(cases), "files": dict(observed), "failures": 0, "errors": 0, "skipped": 0, "xmlSha256": digest(xml)}
            require(actual == report["tests"][kind], "Reported test count does not match original XML")
            counts[kind] = actual
        runtime = identity["runtime"]
        require(runtime["python"] == "3.12.14" and runtime["node"] == "24.22.3", "Runtime differs from exact qualification")
        require(runtime["packages"] == expected_packages and runtime["packages"]["pytest"] == "8.4.2", "Dependency lock differs")
        require(runtime["requirementsLockSha256"] == digest(originals["original-requirements.lock"]), "Dependency lock bytes differ")
        require(re.fullmatch(r"time:\[[0-9]+\]", runtime["clockIdentity"]) is not None, "Real kernel clock identity is missing")
        installed = identity["installed"]
        require(installed["importMode"] == "isolated-installed-wheel" and installed["verifiedPythonFiles"] == 267, "Installed wheel proof is missing")
        require(installed["packageFilesSha256"] == source_files["packageFilesSha256"], "Installed source module hashes differ")
        wheels = [name for name in archive.namelist() if name.endswith(".whl")]
        require(len(wheels) == 1, "Expected one original wheel")
        with zipfile.ZipFile(io.BytesIO(archive.read(wheels[0]))) as wheel:
            modules = sorted([name, digest(wheel.read(name))] for name in wheel.namelist() if name.startswith("megatoken/") and name.endswith(".py"))
            require(modules == source_files["files"], "Original wheel modules differ from the exact native source")
            require(digest(wheel.read("megatoken/data/contracts/semantic-execution-v8.json")) == installed["contractSha256"], "Installed wheel contract differs")
            require(len(identity["payloads"]) == len(spec["payloads"]) == 7, "Seven paired payloads are required")
            for row, expected_payload in zip(identity["payloads"], spec["payloads"]):
                require(all(row[key] == value for key, value in expected_payload.items()), "Payload identity changed")
                native_bytes = originals["payloads/native/" + row["native"]]
                require(digest(native_bytes) == row["nativeSha256"], "Native payload bytes differ")
                source = gzip.decompress(base64.b64decode(native_bytes)) if row["encoding"] == "gzip-base64" else native_bytes
                require(source == originals["payloads/producer/" + row["source"]]
                        and len(source) == row["sourceBytes"] and digest(source) == row["sourceSha256"], "Producer/native payload parity differs")
        receipts = installed["sourceReceipts"]
        if lane == "promise":
            require(len(receipts) == 23 and {row["id"] for row in receipts} == set(source_contexts), "Missing installed source receipt")
            for row in receipts:
                require(row["receipt"]["counts"]["contexts"] == source_contexts[row["id"]], "Installed receipt context population differs")
                require(all(row["receipt"]["checks"][key] == "passed" for key in ("replay", "contexts", "continuation")), "Installed native source replay failed")
            installed_sources = {"cases": len(receipts), "contexts": sum(source_contexts.values())}
            populations = []
            for name, total, eligible, contexts, cuts in (
                ("promise-adoption-source-evidence.json", 15, 15, 423, 65),
                ("promise-mutation-profile-evidence.json", 24, 5, 96, None),
                ("promise-object-profile-evidence.json", 22, 5, 51, None),
                ("async-return-adoption-composition-evidence.json", 2, 2, 78, 9),
            ):
                packet = json.loads(archive.read(name))
                require([packet[key] for key in ("sourceCases", "actualNativeCases", "generatedContexts")] == [total, eligible, contexts], "Promise source population differs")
                require(len(packet["cases"]) == len(packet["nativeReceipts"]) == eligible, "Promise source/native receipt missing")
                source_counts = {row["name"]: len(row["exported"]["contexts"]) for row in packet["cases"]}
                require(len(source_counts) == eligible and sum(source_counts.values()) == contexts, "Promise source contexts differ")
                require({row["name"] for row in packet["nativeReceipts"]} == set(source_counts), "Promise receipt identity differs")
                require(all(row["counts"]["contexts"] == source_counts[row["name"]] for row in packet["nativeReceipts"]), "Promise receipt counts differ")
                require(packet["moduleAdmission"] is False and packet["trainingAdmission"] is False and type(packet["optimizerUpdates"]) is int and packet["optimizerUpdates"] == 0, "Promise source cohort scope changed")
                if cuts is not None:
                    require(packet["snapshotCuts"] == cuts, "Source restore cuts differ")
                if total != eligible:
                    observations = packet["observations"]
                    require(packet["refusedSources"] == total - eligible and packet["eligibleSources"] == eligible, "Promise refusal counts differ")
                    require(len(observations) == total and sum(row["refused"] is True for row in observations) == total - eligible, "Promise refusal observations missing")
                populations.append({"file": name, "sources": total, "nativeCases": eligible, "contexts": contexts, "restoreCuts": cuts})
            shared = json.loads(archive.read("promise-adoption-shared-realm-public.json"))
            require(len(shared["states"]) == 2 and len(shared["artifact"]["contexts"]) == 19, "Shared realm evidence differs")
            installed_sources["additionalSourcePopulations"] = populations
            installed_sources["sharedRealm"] = {"owners": 2, "contexts": 19}
        else:
            require(not receipts, "Unexpected source replay receipt outside Promise lane")
        if lane == "structural" and manifest["requiresControlledPositionProof"]:
            raw = archive.read("controlled-position-proof.json")
            packet = json.loads(raw)
            first, total = packet["optimizerUpdates"], packet["totalOptimizerUpdatesExecuted"]
            require(packet["sourceCommit"] == manifest["nativeRevision"], "Controlled position proof belongs to another source")
            require(type(first) is int and 1 <= first <= 8 and type(total) is int and total == first + 1, "Controlled position update counts differ")
            require(packet["phaseTransition"]["positionExposure"]["optimizerUpdates"] == 1, "Controlled transition update is missing")
            require(packet["boundaries"]["sourceAdmission"] == "injected fixture receipt" and packet["boundaries"]["tokenizerAdmission"] == "injected byte-fallback fixture", "Fixture admission boundary changed")
            controlled = report["controlledTraining"]
            require(controlled["sha256"] == digest(raw) and controlled["sourceCommit"] == packet["sourceCommit"], "Controlled packet identity differs")
            require(controlled["firstPhaseOptimizerUpdates"] == first and controlled["phaseTransitionOptimizerUpdates"] == 1 and controlled["totalOptimizerUpdatesExecuted"] == total, "Controlled packet summary differs")
        lanes[lane] = counts

    qualification = json.loads(archives["combined-v8-qualification"].read("combined-v8-qualification.json"))
    require(qualification["status"] == "passed" and qualification["pair"] == pair and qualification["lanes"] == lanes, "Original aggregate differs from lane evidence")
    require(qualification["requiredGroups"] == manifest["requiredGroups"], "Required group totals differ")
    require(qualification["moduleAdmission"] is False and qualification["trainingAdmission"] is False and qualification["learnedQualityClaim"] is None, "Aggregate admission scope changed")
    correction = None
    if manifest["requiresControlledPositionProof"]:
        require(qualification["optimizerUpdates"] is None and qualification["controlledTraining"] == controlled, "Corrected aggregate lost controlled update evidence")
        require("No global update tally" in qualification["optimizerUpdateScope"], "Global update scope is missing")
    else:
        require(type(qualification["optimizerUpdates"]) is int and qualification["optimizerUpdates"] == 0, "Original unsupported zero was retrospectively edited")
        correction = {"originalAggregateOptimizerUpdates": 0, "claimSupported": False,
                      "actualGlobalOptimizerUpdates": None,
                      "reason": "The structural group executes controlled fixture optimization; this old gate did not retain its emitted position-proof.json. The original artifact is preserved, and the reporting correction is separate."}
    total = {kind: sum(group.get(kind, {}).get("cases", 0) for group in lanes.values()) for kind in ("native", "producer")}
    require(total == {kind: sum(group[kind] for group in manifest["requiredGroups"].values())
                      for kind in ("native", "producer")}, "Actual total leaves differ")
    return {"schema": "semantic-v8-original-hosted-artifact-audit/1", "runId": run["id"],
            "status": "test-evidence-verified" if correction is None else "test-evidence-verified-with-reporting-correction",
            "pair": pair, "requiredJobs": len(jobs), "originalArtifacts": len(artifacts),
            "counts": {**total, "total": sum(total.values()), "failures": 0, "errors": 0, "skipped": 0},
            "installedPythonModules": 267, "installedSources": installed_sources,
            "controlledTraining": controlled, "globalOptimizerUpdates": None,
            "originalReportingCorrection": correction, "moduleAdmission": False,
            "trainingAdmission": False, "learnedQualityClaim": None}


if __name__ == "__main__":
    print(json.dumps(audit(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent), indent=2, sort_keys=True))
