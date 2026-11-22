"""Strict, read-only admission for diagnostic V6 trainer-boundary capture."""
from __future__ import annotations

import hashlib
from pathlib import Path


def semantic_v6_capture_config(checkpoint_config, train_config_type, *, producer_root=None):
    """Build a separately disclosed, read-only SE admission config for V6 capture.

    The checkpoint can be a P1 diagnostic checkpoint with no semantic experiment
    budget. Current V6 preparation correctly rejects such a config. This helper
    binds the capture to the canonical declaration derived from the historical
    effectful cases and the repository's existing engineering receipt; it does
    not create or rewrite qualification or training-result evidence.
    """
    root = Path(producer_root or Path(__file__).resolve().parents[1]).resolve()
    cohort = root / 'docs/evidence/semantic-v4/effectful-tracks-events-capture-cohort.json'
    receipt = root / 'contracts/semantic-engineering-completion.json'
    if not cohort.is_file() or not receipt.is_file():
        raise FileNotFoundError('V6 capture requires the frozen effectful cohort and engineering receipt')
    capture = dict(checkpoint_config)
    capture.update(
        phase='SE',
        microbatch_episodes=1,
        max_accumulation_windows=1,
        semantic_v7_policy=None,
        semantic_v8_policy=None,
        semantic_experiment={
            'schema': 'semantic-training-experiment/4',
            'regime': 'fixed-examples',
            'limit': 1,
            'representation': 'compact',
            'cohort': str(cohort),
            'engineering_receipt': str(receipt),
            'max_token_overshoot': 0,
        },
    )
    config = train_config_type.from_dict(capture, expand_data=False)
    # Use the consumer's real semantic admission validation. This is a read-only
    # capture allowance and is not an optimizer exposure or a new qualification.
    from megatoken.training.semantic_budget import SemanticExperimentConfig

    experiment = SemanticExperimentConfig(**config.semantic_experiment)
    cohort_digest = experiment.preflight(phase=config.phase)
    return config, {
        'scope': 'read-only V6 conditional capture; no optimizer exposure',
        'phase': config.phase,
        'representation': experiment.representation,
        'cohort': str(cohort),
        'cohortDigest': cohort_digest,
        'engineeringReceipt': str(receipt),
        'engineeringReceiptSha256': hashlib.sha256(receipt.read_bytes()).hexdigest(),
        'optimizerSteps': 0,
    }

