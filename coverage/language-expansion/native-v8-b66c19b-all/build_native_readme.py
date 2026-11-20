"""Render documentation from complete, hash-bound final v8 evidence only."""

from collections import Counter
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import tarfile

PRODUCER = "b66c19be960f114b69787746b2487e6f23a73577"
CONSUMER = "6adf99f1301557ee5b95269581a3acd4162496b4"
PRODUCER_TREE = "447832396b33feea21d39c8d2b7b54b1a5659dc3"
CONSUMER_TREE = "730ad8d23892e0d927ecc8446685058fe842df98"
POPULATIONS = {"all": 665, "gallery": 11, "interoperability": 23}
LABELS = {"all": "Expansion", "gallery": "Gallery", "interoperability": "Interoperability"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read(path):
    return json.loads(Path(path).read_bytes())


def check_artifacts(directory, report):
    for name, digest in report["artifacts"].items():
        require(Path(name).name == name, f"Unsafe artifact name: {name}")
        require(sha(directory / name) == digest, f"Artifact digest mismatch: {directory / name}")


def load_evidence(evidence_root, producer_root, consumer_validation, producer_validation, comparison=None):
    """Fail before retention if final measurements are absent or inconsistent."""
    evidence_root, producer_root = Path(evidence_root), Path(producer_root)
    consumer_validation, producer_validation = Path(consumer_validation), Path(producer_validation)
    comparison_path = Path(comparison) if comparison else evidence_root / "paired-serving-costs.json"
    policy_path = producer_root / "contracts/semantic-native-policy-v8.json"
    policy = read(policy_path)
    require(policy["consumerRevision"] == CONSUMER, "Native policy consumer")
    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(producer_root), *arguments], text=True).strip()
    require(git("rev-parse", "HEAD") == PRODUCER, "Producer revision")
    require(git("rev-parse", "HEAD^{tree}") == PRODUCER_TREE, "Producer tree")
    require(not git("status", "--porcelain", "--untracked-files=no"), "Producer tracked changes")
    bindings = {str(policy_path): sha(policy_path)}
    pops = {}
    for ident, expected in POPULATIONS.items():
        qdir, cdir = evidence_root / f"native-{ident}", evidence_root / f"costs-{ident}"
        qp, cp = qdir / "report.json", cdir / "report.json"
        q, c = read(qp), read(cp)
        require(q["schema"] == "semantic-v8-qualification/1" and c["schema"] == "semantic-v8-population-costs/1", f"{ident}: schema")
        require(q["producerRevision"] == c["producerRevision"] == PRODUCER, f"{ident}: producer")
        require(q["population"] == c["population"] == ident and q["inputs"] == c["inputs"] == "all", f"{ident}: selection")
        require(q["preparationOnly"] is False, f"{ident}: preparation-only")
        require(q["nativePolicy"] == c["qualification"]["nativePolicy"] == policy, f"{ident}: policy")
        require(q["declared"] == len(q["rows"]) == len(c["rows"]) == expected, f"{ident}: incomplete population")
        require(c["qualification"]["reportSha256"] == sha(qp), f"{ident}: qualification digest")
        require(c["qualification"]["populationDigest"] == q["populationDigest"], f"{ident}: population digest")
        qr, cr = {r["id"]: r for r in q["rows"]}, {r["id"]: r for r in c["rows"]}
        require(len(qr) == len(cr) == expected and qr.keys() == cr.keys(), f"{ident}: row identities")
        inventory = read(qdir / "population.json")
        require(inventory["producerRevision"] == PRODUCER and {t["fixture"]["id"] for t in inventory["tasks"]} == qr.keys(), f"{ident}: inventory")
        inventory_ids = [t["fixture"]["id"] for t in inventory["tasks"]]
        require(q["selectedCaseIds"] == inventory["selectedCaseIds"] == inventory_ids, f"{ident}: partial diagnostic selection")
        require([r["id"] for r in q["rows"]] == [r["id"] for r in c["rows"]] == inventory_ids, f"{ident}: case order")
        require(sum(r["source"] == "passed" for r in q["rows"]) == q["sourceQualified"], f"{ident}: source count")
        require(sum(r["native"] == "passed" for r in q["rows"]) == q["nativeAdmitted"], f"{ident}: native count")
        for row in q["rows"]:
            require((row["source"], row["native"]) == (cr[row["id"]]["source"], cr[row["id"]]["native"]), f"{ident}/{row['id']}: cost disposition")
            if row["native"] != "passed":
                continue
            receipt = row["nativeReceipt"]
            require(row["source"] == "passed" and receipt["admitted"] is True, f"{ident}/{row['id']}: admission")
            require(receipt["consumerRevision"] == CONSUMER, f"{ident}/{row['id']}: native consumer")
            require(receipt["sourceVerification"]["producerRevision"] == PRODUCER and receipt["sourceVerification"]["producerTreeClean"] is True, f"{ident}/{row['id']}: live source pin")
            require(all(receipt["checks"].get(k) == "passed" for k in ["replay", "contexts", "continuation", "masks", "sourceBinding", "tokenizer"]), f"{ident}/{row['id']}: native checks")
            require(receipt["optimizerSteps"] == 0 and receipt["learningClaim"] is None, f"{ident}/{row['id']}: learning scope")
            require(receipt["tokenizer"]["identity"] == policy["tokenizerIdentity"] and receipt["tokenizer"]["sha256"] == policy["tokenizerSha256"], f"{ident}/{row['id']}: native tokenizer")
            for key in ["contractDigest", "fixtureDigest", "interoperabilityDigest"]:
                require(receipt[key] == q[key] == policy[key], f"{ident}/{row['id']}: {key}")
        s = c["summary"]
        require(s["declared"] == expected and s["sourceQualified"] == q["sourceQualified"], f"{ident}: cost denominator")
        flat = [r for r in c["rows"] if (r.get("cost") or {}).get("measurement") == "passed"]
        native = [r for r in c["rows"] if (r.get("nativePacking") or {}).get("status") == "passed"]
        require(len(flat) == s["flat"]["tokenMeasuredEpisodes"], f"{ident}: flat count")
        require(len(native) == s["nativePacking"]["measuredEpisodes"] == q["nativeAdmitted"], f"{ident}: packing count")
        for key in ["generated", "terminal", "observedAndContext", "total"]:
            require(sum(r["cost"]["tokens"][key] for r in flat) == s["flat"]["tokens"][key], f"{ident}: flat {key}")
        require(sum(r["cost"]["detailedTokens"] for r in flat) == s["flat"]["tokens"]["detailed"], f"{ident}: detailed count")
        for key in ["generatedTokens", "observedTokens", "terminalTokens", "physicalRecords", "logicalRecords"]:
            require(sum(r["nativePacking"][key] for r in native) == s["nativePacking"][key], f"{ident}: packing {key}")
        require(s["model"]["status"] == s["nativeServing"]["status"] == "unmeasured", f"{ident}: measurement scope")
        require(q["model"] == "untested" and q["defaultPromotion"] == s["defaultPromotion"] == "not-qualified", f"{ident}: promotion scope")
        tokenizer = c["tokenizerEvidence"]
        require(tokenizer["identity"]["fingerprint"] == policy["tokenizerIdentity"] and tokenizer["identity"]["tokenizerSha256"] == policy["tokenizerSha256"], f"{ident}: tokenizer")
        require(tokenizer["qualification"]["consumerRevision"] == CONSUMER and tokenizer["qualification"]["consumerClean"] is True, f"{ident}: codec consumer")
        check_artifacts(qdir, q)
        check_artifacts(cdir, c)
        bindings.update({str(qp): sha(qp), str(cp): sha(cp)})
        pops[ident] = {"q": q, "c": c, "inventory": inventory}

    comp = read(comparison_path)
    manifest_path = evidence_root / "comparison-inputs.json"
    require(comp["schema"] == "semantic-paired-serving-costs/1" and comp["meterProducerRevision"] == PRODUCER, "Comparison schema/pin")
    require(comp["inputs"]["afterManifestSha256"] == sha(manifest_path), "Comparison manifest digest")
    require({r["id"] for r in comp["inputs"]["after"]} == set(pops), "Comparison populations")
    for r in comp["inputs"]["after"]:
        require(r["producerRevision"] == PRODUCER and r["nativePolicy"] == policy, "Comparison pins")
        require(r["costReportSha256"] == sha(evidence_root / f"costs-{r['id']}/report.json"), "Comparison cost binding")
        require(r["qualificationReportSha256"] == sha(evidence_root / f"native-{r['id']}/report.json"), "Comparison qualification binding")
    baseline_path = producer_root / "coverage/language-expansion/baseline-token-costs-135bd1f/report.json"
    baseline = read(baseline_path)
    require(comp["inputs"]["before"]["reportSha256"] == sha(baseline_path), "Baseline binding")
    require(comp["inputs"]["before"]["baseline"] == baseline["baseline"], "Baseline identity")
    current_codec = pops["all"]["c"]["tokenizerEvidence"]
    require(baseline["tokenizerEvidence"]["identity"] == current_codec["identity"], "Baseline tokenizer identity")
    require(baseline["tokenizerEvidence"]["qualification"]["codecSourceSha256"] == current_codec["qualification"]["codecSourceSha256"], "Baseline codec implementation")
    baseline_index_path = baseline_path.parent / "archive.json"
    baseline_index = read(baseline_index_path)["archive"]
    baseline_archive = baseline_path.parent / baseline_index["file"]
    require(sha(baseline_archive) == baseline_index["sha256"], "Baseline archive digest")
    historical_artifacts = {}
    with tarfile.open(baseline_archive, "r|xz") as tf:
        for member in tf:
            require(member.isfile(), "Unexpected baseline archive member")
            stream, digest = tf.extractfile(member), hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            historical_artifacts[member.name] = digest.hexdigest()
    require(historical_artifacts == {f["name"]: f["sha256"] for f in baseline_index["files"]}, "Baseline archive member digests")
    bindings.update({str(baseline_archive): sha(baseline_archive), str(baseline_index_path): sha(baseline_index_path)})
    paired = [r for r in comp["rows"] if r["status"] == "paired"]
    require(len(paired) == comp["summary"]["paired"], "Pair count")
    require(dict(Counter(r["status"] for r in comp["rows"])) == comp["summary"]["dispositions"], "Comparison dispositions")
    for r in paired:
        identity = r["identity"]
        require(identity["baselineSourceDigest"] == identity["currentSourceDigest"] and identity["baselineEntry"] == identity["currentEntry"] and identity["baselineRootedInput"]["digest"] == identity["currentRootedInput"]["digest"], f"{r['id']}: pairing identity")
        historical = r["artifacts"]["before"]
        require(historical_artifacts[historical["file"]] == historical["sha256"], f"{r['id']}: paired historical artifact")
        for key, directory in [("after", evidence_root / f"costs-{r['currentPopulation']}"), ("source", evidence_root / f"native-{r['currentPopulation']}")]:
            artifact = r["artifacts"][key]
            require(sha(directory / artifact["file"]) == artifact["sha256"], f"{r['id']}: paired {key} artifact")
    for side in ["before", "after"]:
        for key, expected in comp["summary"][side].items():
            values = [r[side][key] for r in paired]
            require((max(values, default=0) if key.startswith("peak") else sum(values)) == expected, f"Comparison aggregate {side}/{key}")
    require([r["id"] for r in paired if r["after"]["flatTotalTokens"] > r["before"]["flatTotalTokens"]] == comp["summary"]["flatTokenRegressions"], "Regression inventory")
    bindings.update({str(comparison_path): sha(comparison_path), str(manifest_path): sha(manifest_path), str(baseline_path): sha(baseline_path)})

    reference_path = evidence_root / "reference/report.json"
    reference = read(reference_path)
    require(reference["producerRevision"] == PRODUCER, "Reference producer")
    check_artifacts(reference_path.parent, read(reference_path.parent / "artifacts.json"))
    cvp, pvp = consumer_validation / "summary.json", producer_validation / "summary.json"
    cv, pv = read(cvp), read(pvp)
    require(cv["passed"] is True and cv["pins"] == cv["finalPins"], "Consumer validation result or identity")
    for name, revision, tree in [("consumer", CONSUMER, CONSUMER_TREE), ("producer", PRODUCER, PRODUCER_TREE)]:
        pin = cv["pins"][name]
        require(pin["revision"] == revision and pin["tree"] == tree and pin["status"] == "", "Consumer validation pins")
    for check in cv["checks"]:
        require(check["exitCode"] == 0 and sha(consumer_validation / Path(check["log"]).name) == check["logSha256"], "Consumer validation log/result")
    require(pv["status"] == "passed" and pv["identityUnchanged"] is True, "Producer validation result or identity")
    for side in ["producerBefore", "producerAfter"]:
        require(pv[side]["revision"] == PRODUCER and pv[side]["tree"] == PRODUCER_TREE and pv[side]["trackedChanges"] == "", "Producer validation pin")
    for command in pv["commands"]:
        require(command["status"] == "passed" and command["exitCode"] == 0, "Producer validation result")
        for stream in ["stdout", "stderr"]:
            require(sha(producer_validation / command[stream]["path"]) == command[stream]["sha256"], "Producer validation log")
    bindings.update({str(reference_path): sha(reference_path), str(cvp): sha(cvp), str(pvp): sha(pvp)})
    return {"populations": pops, "comparison": comp, "comparisonPath": comparison_path, "baseline": baseline,
            "reference": reference, "consumerValidation": cv, "producerValidation": pv, "policy": policy, "bindings": bindings}


def num(value):
    return f"{value:,}"


def pct(value):
    return "unmeasured" if value is None else f"{100 * value:.2f}%"


def change(before, after):
    return "undefined (zero baseline)" if not before else f"{100 * (after / before - 1):+.2f}%"


def table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    return "\n".join(lines + ["| " + " | ".join(str(v).replace("|", "\\|").replace("\n", " ") for v in row) + " |" for row in rows])


def render(bundle, retained_root):
    retained_root = Path(retained_root)
    archive, report = read(retained_root / "archive.json"), read(retained_root / "report.json")
    pops, comp, ref = bundle["populations"], bundle["comparison"], bundle["reference"]
    require({r["id"] for r in archive["populations"]} == set(pops), "Retained population set")
    for row in report["populations"]:
        q, c = pops[row["id"]]["q"], pops[row["id"]]["c"]
        require((row["declared"], row["sourceQualified"], row["nativeAdmitted"]) == (q["declared"], q["sourceQualified"], q["nativeAdmitted"]), "Retained counts")
        require(row["costs"] == c["summary"], "Retained costs")
    require(report["comparison"]["summary"] == comp["summary"], "Retained comparison")
    values = {"PRODUCER": PRODUCER, "CONSUMER": CONSUMER, "PRODUCER_TREE": PRODUCER_TREE, "CONSUMER_TREE": CONSUMER_TREE}
    values["QUALIFICATION"] = table(["Population", "Declared", "Source qualified", "Native admitted", "Unqualified source / native"],
        [(LABELS[i], q["declared"], q["sourceQualified"], q["nativeAdmitted"], f"{q['declared'] - q['sourceQualified']} / {q['declared'] - q['nativeAdmitted']}") for i in pops for q in [pops[i]["q"]]])
    groups = {"Fixed families": [], "Script interactions": [], "Real source": [], "Evaluated modules": []}
    qr = {r["id"]: r for r in pops["all"]["q"]["rows"]}
    for t in pops["all"]["inventory"]["tasks"]:
        f = t["fixture"]
        group = "Fixed families" if f["family"].startswith("expansion:") else "Real source" if f["id"].startswith("real-utilities-") else "Evaluated modules" if t["kind"] == "module" else "Script interactions"
        groups[group].append(qr[f["id"]])
    require([len(v) for v in groups.values()] == [624, 12, 27, 2], "Expansion subgroup partition")
    values["SUBGROUPS"] = table(["Expansion subset", "Declared", "Source qualified", "Native admitted"], [(k, len(rows), sum(r["source"] == "passed" for r in rows), sum(r["native"] == "passed" for r in rows)) for k, rows in groups.items()])
    family_names = sorted({r["family"] for r in groups["Fixed families"]})
    families = [[r for r in groups["Fixed families"] if r["family"] == name] for name in family_names]
    require(len(families) == 26 and all(len(rows) == 24 for rows in families), "Fixed family denominators")
    fully_admitted = sum(all(r["source"] == r["native"] == "passed" for r in rows) for rows in families)
    values["FAMILY_SCOPE"] = f"{fully_admitted}/{len(families)} fixed families have source and native passes for all 24 declared executions. Complete per-family dispositions remain in [report.json](report.json)."
    ids = Counter(r["id"] for p in pops.values() for r in p["q"]["rows"])
    values["OVERLAPS"] = ", ".join(f"`{i}`" for i, n in sorted(ids.items()) if n > 1) or "none"
    rr, real = ref["reference"], ref["realSource"]
    values["REFERENCE"] = f"Independent reference checks at this producer passed {rr['positivePassed']}/{rr['positiveInputs']} positive inputs across {rr['positiveExecutions']} idiom executions and {rr['distinguishingPassed']}/{rr['distinguishingPairs']} distinguishing pairs. The reference suite covers {rr['families']} families. Its {ref['comprehension']['tasks']} comprehension tasks have model measurement status `{ref['comprehension']['status']}`."
    values["REAL_SOURCE"] = f"The fixed rule selects {real['selectedDenominator']} of {real['inventoryDenominator']} available real-source functions; the remaining {real['inventoryDenominator'] - real['selectedDenominator']} were not tested by this population."
    bad = [(i, r) for i in pops for r in pops[i]["q"]["rows"] if r["source"] != "passed" or r["native"] != "passed"]
    values["UNQUALIFIED"] = table(["Population", "Case", "Source", "Native", "Reason"], [(LABELS[i], f"`{r['id']}`", r["source"], r["native"], r.get("nativeReason") or r.get("reason") or "See retained attempt") for i, r in bad]) if bad else "All rows in these three declared inventories have successful source and native qualification. This statement is limited to their retained inputs and checked profiles."
    values["COVERAGE"] = table(["Population", "Episodes with compact regions", "Wholly detailed episodes", "Compact / detailed regions", "Compact / detailed records", "Detailed generated-token share"],
        [(LABELS[i], s["compactEpisodes"], s["whollyDetailedEpisodes"], f"{s['regionCoverage']['compact']:,} / {s['regionCoverage']['detailed']:,}", f"{s['regionCoverage']['compactRecords']:,} / {s['regionCoverage']['detailedRecords']:,}", pct(s["flat"]["tokens"]["detailedShare"])) for i in pops for s in [pops[i]["c"]["summary"]]])
    tokenizer = pops["all"]["c"]["tokenizerEvidence"]
    ti, tq = tokenizer["identity"], tokenizer["qualification"]
    values["TOKENIZER"] = f"`{ti['name']}` revision `{ti['revision']}`, tokenizer SHA-256 `{ti['tokenizerSha256']}`, identity `{ti['fingerprint']}`, codec SHA-256 `{tq['codecSourceSha256']}`. Codec version: `{ti['codecVersion']}`; vocabulary: {num(ti['vocabSize'])}; Python: {tq['pythonVersion']}; `tokenizers`: {tq['tokenizersVersion']}."
    values["FLAT"] = table(["Population", "Token measured / declared", "Generated", "EOS", "Submitted context", "Flat total", "Peak context"], [(LABELS[i], f"{s['flat']['tokenMeasuredEpisodes']}/{s['declared']}", *(num(t[k]) for k in ["generated", "terminal", "observedAndContext", "total", "peakContext"])) for i in pops for s in [pops[i]["c"]["summary"]] for t in [s["flat"]["tokens"]]])
    values["PACKING"] = table(["Population", "Native measured / declared", "Generated", "Observed/context", "Terminal", "Physical records", "Logical records"], [(LABELS[i], f"{n['measuredEpisodes']}/{s['declared']}", *(num(n[k]) for k in ["generatedTokens", "observedTokens", "terminalTokens", "physicalRecords", "logicalRecords"])) for i in pops for s in [pops[i]["c"]["summary"]] for n in [s["nativePacking"]]])
    base, den = bundle["baseline"], comp["denominators"]
    values["BASELINE_PRODUCER"], values["BASELINE_METER"] = base["baseline"]["producerRevision"], base["meterProducerRevision"]
    values["BASELINE_DENOMINATORS"] = f"The baseline declares {den['baselineRetainedDeclared']} rows, retains {den['baselineSerializerRetained']} serializers and measures {den['baselineTokenMeasured']} of them. The remaining {den['baselineRetainedDeclared'] - den['baselineTokenMeasured']} declared baseline rows are unmeasured."
    names = {"real": "Real source", "gallery": "Gallery", "interactions": "Script interactions", "all": "All matched rows"}
    values["COMPARISON"] = table(["Matched population", "Pairs", "Baseline generated", "Current generated", "Generated change", "Baseline flat total", "Current flat total", "Total change"], [(names.get(i, i), s["paired"], num(s["before"]["generatedTokens"]), num(s["after"]["generatedTokens"]), change(s["before"]["generatedTokens"], s["after"]["generatedTokens"]), num(s["before"]["flatTotalTokens"]), num(s["after"]["flatTotalTokens"]), change(s["before"]["flatTotalTokens"], s["after"]["flatTotalTokens"])) for i, s in [*comp["baselinePopulations"].items(), ("all", comp["summary"])]] )
    values["CONTEXT_COMPARISON"] = table(["Matched population", "Baseline submitted context", "Current submitted context", "Context change"], [(names.get(i, i), num(s["before"]["promptTokens"]), num(s["after"]["promptTokens"]), change(s["before"]["promptTokens"], s["after"]["promptTokens"])) for i, s in [*comp["baselinePopulations"].items(), ("all", comp["summary"])]] )
    before, after = comp["summary"]["before"], comp["summary"]["after"]
    paired = [r for r in comp["rows"] if r["status"] == "paired"]
    admitted = sum(next(q for q in pops[r["currentPopulation"]]["q"]["rows"] if q["id"] == r["id"])["native"] == "passed" for r in paired)
    values["PAIRED_CONTEXT"] = f"Across {len(paired)} matched rows, submitted context changes from {num(before['promptTokens'])} to {num(after['promptTokens'])} tokens ({change(before['promptTokens'], after['promptTokens'])}); generated targets change from {num(before['generatedTokens'])} to {num(after['generatedTokens'])} ({change(before['generatedTokens'], after['generatedTokens'])}). Detailed targets account for {pct(comp['summary']['detailedTokenShare']['after'])} of current generated tokens in this matched subset. {admitted}/{len(paired)} matched current rows have native admission."
    values["PAIRING_DISPOSITIONS"] = table(["Disposition", "Rows"], sorted(comp["summary"]["dispositions"].items()))
    regressions = [r for r in paired if r["after"]["flatTotalTokens"] > r["before"]["flatTotalTokens"]]
    values["FLAT_REGRESSIONS"] = table(["Case", "Baseline flat total", "Current flat total", "Change"], [(f"`{r['id']}`", num(r["before"]["flatTotalTokens"]), num(r["after"]["flatTotalTokens"]), change(r["before"]["flatTotalTokens"], r["after"]["flatTotalTokens"])) for r in regressions]) if regressions else "No matched pair has a flat-total increase."
    cv, pv = bundle["consumerValidation"], bundle["producerValidation"]
    unit = next(c for c in cv["checks"] if c["name"] == "unit")
    pc = {c["name"]: c for c in pv["commands"]}
    values["CONSUMER_VALIDATION"] = f"At these exact pins, the selected consumer suite passed {unit['testsRun']} tests across {len(cv['modules'])} modules, with {unit['failures']} failures, {unit['errors']} errors and {unit['skips']} skips. Ruff checks, Ruff format checks and `git diff --check` also passed."
    counts = pc["unit"]["counts"]
    values["PRODUCER_VALIDATION"] = f"The full producer `test/*.test.js` run at the same pin recorded {num(counts['tests'])} tests: {num(counts['pass'])} passed, {counts['skipped']} skipped and {counts['fail']} failed. All {pc['contracts']['counts']['checks']} contract generators and all {pc['reference']['counts']['checks']} reference fixtures passed."
    values["RUNTIME"] = f"Producer Node {pv['node']['version']}; consumer Python {cv['runtime']['python'].split()[0]}, `tokenizers` {cv['runtime']['tokenizers']} and {cv['runtime']['ruff']}."
    values["ARCHIVE_COUNTS"] = f"{len(archive['archives'])} deterministic archives contain {num(sum(len(a['files']) for a in archive['archives']))} uncompressed members. The largest archive is {num(max(a['compressedBytes'] for a in archive['archives']))} bytes; each part is bounded by {num(archive['maximumArchiveBytes'])} bytes."
    template = Path(__file__).with_name("README.template.md").read_text()
    rendered = re.sub(r"@@([A-Z_]+)@@", lambda match: values[match[1]], template)
    require(not re.search(r"@@[A-Z_]+@@", rendered), "Unresolved template value")
    return rendered


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["evidence-root", "producer-root", "consumer-validation", "producer-validation", "retained-root"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--comparison", type=Path)
    args = parser.parse_args()
    bundle = load_evidence(args.evidence_root, args.producer_root, args.consumer_validation, args.producer_validation, args.comparison)
    output = args.retained_root / "README.md"
    output.write_text(render(bundle, args.retained_root))
    print(json.dumps({"readme": str(output), "sha256": sha(output)}))


if __name__ == "__main__":
    main()
