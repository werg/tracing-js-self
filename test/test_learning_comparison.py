"""Synthetic analysis fixtures are not model or training performance evidence."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(os.environ.get("MEGATOKEN_ROOT", REPO.parent / "megatoken")) / "src"))
pytest.importorskip("megatoken")
import learning_comparison as comparison
from megatoken.data.host_operations import CONTRACT_DIGEST
from megatoken.training.semantic_evaluation import HARD_GATES, OUTCOMES, _current_execution_identity, _digest, freeze_cohort

BASE = {"checkpointIdentity": "a" * 64, "tokenizerIdentity": "c" * 64, "tokenizerSha256": "d" * 64,
        "trainingCheckpointSha256": "e" * 64, "manifestSha256": "f" * 64,
        "modelVersion": 0, "checkpointMetadataSha256": "9" * 64}


def cohort_for(families):
    cases = []
    for index, family in enumerate(families):
        request = {"program": {"source": "function run(x){return x+1;}"}, "arguments": [index]}
        expected = {"completion": {"kind": "return", "value": ["num", index + 1]},
                    "state": {"roots": [["num", index + 1]]}, "effects": [], "callbacks": [],
                    "cleanup": {"pendingEffects": 0, "pendingJobs": 0, "openHandlers": 0}}
        cases.append({"id": str(index), "family": family, "split": "test", "request": request, "expected": expected,
                      "referenceReceipt": {"status": "agreed", "requestDigest": _digest(request), "outcomeDigest": _digest(expected)}})
    return freeze_cohort(cases, name="common-support", thresholds={"wholeTaskSuccess": 0.9, "traceValid": 1})


def design_for(cohort, **updates):
    supply = {"schema": "semantic-learning-supply/1", "corpusIdentity": "4" * 64, "streamFingerprint": "5" * 64,
              "components": ["training-component", "validation-component"], "episodes": {"train": 2, "validation": 1},
              "nativeSupply": {"optimizerSteps": 0}}
    design = {"name": "synthetic-statistics-test", "mode": "confirmatory", "optimizerSeeds": [17, 29, 43],
              "baseKind": "newly-initialized", "minimumPracticalImprovement": 0.05,
              "minimumIndependentComponents": 2, "bootstrapReplicates": 1000, "consumerRevision": "1" * 40,
              "componentByFamily": {case["family"]: "component-" + case["family"] for case in cohort["cases"]},
              "trainingComponents": supply["components"], "trainingDesign": {"templateDigest": "3" * 64,
                  "supply": supply, "phase": "SC", "budget": {"regime": "fixed-examples", "limit": 2,
                      "maxTokenOvershoot": 0, "representation": "compact"}},
              "slices": {name: {"caseIds": [case["id"] for case in cohort["cases"]], "maximumRegression": 0}
                         for name in ("effects", "errors", "cleanup")}}
    design.update(updates)
    return design


def declaration_for(cohort, **updates):
    return comparison.freeze_declaration(cohort, design_for(cohort, **updates), BASE, frozen_at="2026-11-18T00:00:00Z")


def report_for(cohort, successes, *, seed=17, role="base"):
    rows = []
    for case, success in zip(cohort["cases"], successes, strict=True):
        rows.append({"caseId": case["id"], "family": case["family"], "wholeTaskSuccess": bool(success), "traceValid": True,
            "matches": dict.fromkeys(OUTCOMES, bool(success)), "hardGates": dict.fromkeys(HARD_GATES, 0),
            "costs": {"computeSeconds": 0.125, "peakMemoryBytes": 4096, "dispatches": 1, "queueDepth": 0, "leakedResources": 0},
            "latencySeconds": 0.25, "generatedTokens": 30, "observedTokens": 10,
            "generatedTokenBasis": "original-decoder-token-ids", "evidenceDigest": comparison.digest([case["id"], role, seed]),
            "costScope": {"computeSeconds": "case-wall-time", "peakMemoryBytes": "process-rss"},
            "failure": None if success else "outcome-or-hard-gate",
            "firstSemanticInconsistency": None if success else {"record": 4, "reason": "wrong value"},
            "failureEvidence": None if success else {"category": "semantic", "record": 4}})
    correct = sum(successes)
    return {"schema": "semantic-evaluation-report/5", "cohortDigest": cohort["digest"], "cohort": cohort["name"],
        "origin": "fixed-weights" if role == "base" else "trained", "seed": seed,
        "checkpointIdentity": BASE["checkpointIdentity"] if role == "base" else "b" * 64,
        "tokenizerIdentity": BASE["tokenizerIdentity"], "representation": "compact", "evaluationSplits": ["test"],
        "catalogDigest": CONTRACT_DIGEST, **_current_execution_identity(), "optimizerStepsDuringEvaluation": 0,
        "learnedSuccess": correct / len(rows) if role == "trained" else None,
        "summary": {"tasks": len(rows), "correctTasks": correct, "wholeTaskSuccess": correct / len(rows),
            "generatedTokens": len(rows) * 30, "observedTokens": len(rows) * 10, "computeSeconds": len(rows) * 0.125,
            "hardGates": dict.fromkeys(HARD_GATES, 0)}, "cases": rows}


def pairs_for(cohort, before, after, seeds=(17, 29, 43)):
    return [{"seed": seed, "base": report_for(cohort, before, seed=seed), "trained": report_for(cohort, after, seed=seed, role="trained"),
             "artifactBinding": {"schema": "semantic-verified-learning-arm/1", "seed": seed, "optimizerSteps": 2,
                "served": {"checkpointIdentity": "b" * 64}, "budget": {"syntheticTestFixture": True}}} for seed in seeds]


def test_family_weighting_does_not_let_episode_imbalance_determine_headline():
    cohort = cohort_for(["large"] * 100 + ["small"])
    result = comparison.compare_validated_runs(declaration_for(cohort), cohort, pairs_for(cohort, [False] * 101, [True] * 100 + [False]))
    assert result["meanAccuracy"]["trained"]["episodeWeightedAccuracy"] == 100 / 101
    assert result["meanAccuracy"]["trained"]["familyWeightedAccuracy"] == 0.5
    assert result["pairedImprovement"]["estimate"] == 0.5
    assert not result["accepted"]  # Only one of two independent components improves.


def test_correlated_declared_families_are_one_independent_unit():
    cohort = cohort_for([f"alias-{i}" for i in range(20)])
    declaration = declaration_for(cohort, componentByFamily={case["family"]: "one-shared-ancestor" for case in cohort["cases"]})
    result = comparison.compare_validated_runs(declaration, cohort, pairs_for(cohort, [False] * 20, [True] * 20))
    assert result["declaredFamilies"] == 20 and result["independentComponents"] == 1
    assert result["pairedImprovement"]["identifiable"] is False
    assert result["evidenceScope"] == "exploratory" and not result["accepted"]


def test_component_bootstrap_carries_all_member_families_together():
    cohort = cohort_for(["a", "a-clone", "b"])
    declaration = declaration_for(cohort, componentByFamily={"a": "ancestor-a", "a-clone": "ancestor-a", "b": "ancestor-b"})
    result = comparison.compare_validated_runs(declaration, cohort, pairs_for(cohort, [False] * 3, [True, True, False]))
    assert result["pairedImprovement"]["familiesPerComponent"] == [2, 1]
    assert result["pairedImprovement"]["estimate"] == 2 / 3
    assert result["pairedImprovement"]["lower"] == 0


def test_crossed_bootstrap_is_paired_deterministic_and_includes_seed_variation():
    settings = dict(confidence=0.95, repetitions=1000, seed=7)
    matrix = [[1] * 10, [0] * 10, [-1] * 10]
    result = comparison._interval(matrix, **settings)
    assert result == comparison._interval(matrix, **settings)
    assert result["estimate"] == 0 and result["lower"] < 0 < result["upper"]
    assert comparison._interval([[0] * 10] * 3, **settings)["upper"] == 0


def test_confirmatory_positive_fixture_and_predeclared_practical_threshold():
    cohort = cohort_for(["a", "b", "c"])
    result = comparison.compare_validated_runs(declaration_for(cohort), cohort, pairs_for(cohort, [False] * 3, [True] * 3))
    assert result["accepted"] and result["pairedImprovement"]["lower"] == 1
    # All components improve, but the predefined effect size is too small.
    cohort = cohort_for(["a", "a", "b", "b"])
    result = comparison.compare_validated_runs(declaration_for(cohort, minimumPracticalImprovement=0.75), cohort,
        pairs_for(cohort, [False] * 4, [True, False, True, False]))
    assert result["gates"]["positivePairedUncertaintyInterval"]
    assert not result["gates"]["practicalImprovement"] and not result["accepted"]


def test_one_seed_is_exploratory_and_missing_planned_seeds_are_refused():
    cohort = cohort_for(["a", "b"])
    result = comparison.compare_validated_runs(declaration_for(cohort, mode="exploratory", optimizerSeeds=[17]), cohort,
        pairs_for(cohort, [False] * 2, [True] * 2, seeds=[17]))
    assert result["evidenceScope"] == "exploratory" and not result["accepted"]
    with pytest.raises(ValueError, match="exactly one"):
        comparison.compare_validated_runs(declaration_for(cohort), cohort, pairs_for(cohort, [False] * 2, [True] * 2, seeds=[17]))
    with pytest.raises(ValueError, match="three planned"):
        declaration_for(cohort, optimizerSeeds=[17])


def test_declared_error_slice_regression_blocks_aggregate_gain():
    cohort = cohort_for(["a", "b", "error"])
    slices = {name: {"caseIds": ["2"], "maximumRegression": 0} for name in ("effects", "errors", "cleanup")}
    result = comparison.compare_validated_runs(declaration_for(cohort, slices=slices), cohort,
        pairs_for(cohort, [False, False, True], [True, True, False]))
    assert result["pairedImprovement"]["estimate"] > 0
    assert not result["gates"]["noDeclaredSliceRegression"] and not result["accepted"]
    assert result["slices"]["errors"]["meanDelta"] == -1


def test_critical_slices_need_predeclared_scope_and_empty_training_ancestry_is_refused():
    cohort = cohort_for(["a", "b"])
    with pytest.raises(ValueError, match="critical slice"):
        declaration_for(cohort, slices={})
    declaration = declaration_for(cohort, slices={}, excludedCriticalSlices={name: "Outside this frozen pure-task claim" for name in ("effects", "errors", "cleanup")})
    result = comparison.compare_validated_runs(declaration, cohort, pairs_for(cohort, [False] * 2, [True] * 2))
    assert set(result["criticalSliceStatus"].values()) == {"explicitly-out-of-scope"}
    with pytest.raises(ValueError, match="scanned prepared"):
        declaration_for(cohort, trainingComponents=[])


@pytest.mark.parametrize("mutation", [
    lambda pairs: pairs[0]["base"].update(origin="controlled"),
    lambda pairs: pairs[0]["trained"].update(seed=29),
    lambda pairs: pairs[0]["trained"].update(cohortDigest="0" * 64),
    lambda pairs: pairs[0]["trained"].update(checkpointIdentity="0" * 64),
    lambda pairs: pairs[0]["trained"].update(tokenizerIdentity="0" * 64),
    lambda pairs: pairs[0]["trained"]["cases"].pop(),
    lambda pairs: pairs[0]["trained"]["cases"].append(copy.deepcopy(pairs[0]["trained"]["cases"][0])),
    lambda pairs: pairs[0]["trained"]["cases"][0]["hardGates"].pop("unauthorizedEffects"),
    lambda pairs: pairs[0]["trained"]["cases"][0]["costs"].pop("computeSeconds"),
    lambda pairs: pairs[0]["trained"]["cases"][0]["matches"].update(effects=False),
    lambda pairs: pairs[0]["trained"]["cases"][0].update(evidenceDigest="G" * 64),
    lambda pairs: pairs[0]["trained"]["cases"][0].update(generatedTokenBasis="canonical-native-records"),
    lambda pairs: pairs[0]["trained"]["cases"][0].update(failure="hidden-failure"),
    lambda pairs: pairs[0]["trained"]["summary"].update(wholeTaskSuccess=0.5),
    lambda pairs: pairs[0]["trained"]["summary"].update(generatedTokens=0),
    lambda pairs: pairs[0]["trained"]["summary"].update(computeSeconds=0),
    lambda pairs: pairs[0]["artifactBinding"].update(optimizerSteps=0),
    lambda pairs: pairs.append(copy.deepcopy(pairs[0])),
])
def test_report_tampering_and_unmatched_arms_are_refused(mutation):
    cohort = cohort_for(["a", "b"])
    pairs = pairs_for(cohort, [False] * 2, [True] * 2)
    mutation(pairs)
    with pytest.raises(ValueError):
        comparison.compare_validated_runs(declaration_for(cohort), cohort, pairs)


def test_zero_success_preserves_cost_and_exact_first_failures():
    cohort = cohort_for(["a", "b"])
    result = comparison.compare_validated_runs(declaration_for(cohort), cohort, pairs_for(cohort, [False] * 2, [False] * 2))
    assert result["runs"][0]["base"]["costs"]["generatedTokens"] == 60
    assert result["runs"][0]["trained"]["costs"]["generatedTokensPerCorrectTask"] is None
    assert result["runs"][0]["failures"]["trained"][0]["firstSemanticInconsistency"] == {"record": 4, "reason": "wrong value"}
    assert not result["accepted"]


def test_changes_after_freeze_and_training_test_overlap_are_refused():
    cohort = cohort_for(["a", "b"])
    declaration = declaration_for(cohort)
    declaration["minimumPracticalImprovement"] = 0.001
    with pytest.raises(ValueError, match="changed"):
        comparison.verify_declaration(declaration, cohort)
    with pytest.raises(ValueError, match="overlaps"):
        declaration_for(cohort, trainingComponents=["component-a"])
