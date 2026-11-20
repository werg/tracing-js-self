"""Repeat the two bounded diagnostics using exact clean source checkouts."""

import argparse
import json
import os
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--training-producer", type=Path, required=True)
    parser.add_argument("--evaluation-producer", type=Path, required=True)
    parser.add_argument("--consumer", type=Path, required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pins = {
        args.training_producer: "653fd1ba0313d29c70bfa36ec004553d146de343",
        args.evaluation_producer: "62eb9436fee07d604a3017f5a8846a1fc786f7dd",
        args.consumer: "23cd47816f9b99bbdb2ec9a32dd455daf68b732b",
    }
    for directory, revision in pins.items():
        actual = subprocess.check_output(
            ["git", "-C", str(directory), "rev-parse", "HEAD"], text=True
        ).strip()
        dirty = subprocess.check_output(
            [
                "git",
                "-C",
                str(directory),
                "status",
                "--porcelain",
                "--untracked-files=all",
            ],
            text=True,
        ).strip()
        if actual != revision or dirty:
            raise ValueError(f"Expected exact clean checkout {revision}: {directory}")
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    evidence = args.evidence.resolve()
    env = {**os.environ, "PYTHONPATH": str(args.consumer.resolve() / "src")}
    commands = []

    def run(command, cwd, label):
        command = [str(value) for value in command]
        commands.append({"label": label, "argv": command, "cwd": str(cwd)})
        (output / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        with (
            (output / f"{label}.stdout.log").open("w") as stdout,
            (output / f"{label}.stderr.log").open("w") as stderr,
        ):
            subprocess.run(
                command, cwd=cwd, env=env, stdout=stdout, stderr=stderr, check=True
            )

    for case in ("compound-pure", "pure-helper"):
        run(
            [
                args.python,
                "scripts/admit_semantic_v8.py",
                "--input",
                evidence / "training-inputs" / f"{case}.json",
                "--output",
                output / f"{case}.admission.json",
                "--consumer-revision",
                pins[args.consumer],
                "--tokenizer-json",
                args.tokenizer.resolve(),
                "--producer-root",
                args.training_producer.resolve(),
                "--producer-revision",
                pins[args.training_producer],
            ],
            args.consumer.resolve(),
            f"admit-{case}",
        )
    inventory = {
        "cases": [
            {
                "id": case,
                "artifactPath": str(
                    evidence / "evaluation-source-62eb943" / f"{case}.source.json"
                ),
            }
            for case in ("compound-pure", "pure-helper")
        ]
    }
    (output / "cases.json").write_text(json.dumps(inventory, indent=2) + "\n")
    for label, train, heldout in (
        ("preliminary", "compound-pure", "pure-helper"),
        ("family-split", "pure-helper", "compound-pure"),
    ):
        fit = output / f"fit-{label}"
        run(
            [
                args.python,
                "scripts/fit_semantic_v8.py",
                "--artifact",
                evidence / "training-inputs" / f"{train}.json",
                "--admission",
                output / f"{train}.admission.json",
                "--heldout",
                evidence / "training-inputs" / f"{heldout}.json",
                "--tokenizer-json",
                args.tokenizer.resolve(),
                "--output",
                fit,
                "--seed",
                "17",
                "--max-steps",
                "4",
                "--max-tokens",
                "64",
                "--evaluate-every",
                "4",
                "--learning-rate",
                "0.02",
            ],
            args.consumer.resolve(),
            f"fit-{label}",
        )
        manifest = json.loads((fit / "fitted/manifest.json").read_text())
        frozen = output / f"frozen-{label}"
        run(
            [
                "node",
                "tools/run-semantic-v8-experiment.mjs",
                "freeze",
                "--input",
                output / "cases.json",
                "--out",
                frozen,
                "--model-id",
                "tiny-v8-decoder-four-step-diagnostic"
                if label == "preliminary"
                else "tiny-v8-family-split-four-step-diagnostic",
                "--model-revision",
                manifest["model_sha256"],
                "--settings",
                evidence / "plans/settings.json",
                "--checkpoint",
                manifest["model_sha256"],
                "--tokenizer",
                manifest["codec_fingerprint"],
                "--seed",
                "17",
                "--max-predictions",
                "4",
                "--max-generated",
                "4",
                "--max-outstanding",
                "4",
                "--max-stale-retries",
                "0",
                "--timeout-ms",
                "60000",
            ],
            args.evaluation_producer.resolve(),
            f"freeze-{label}",
        )
        run(
            [
                "node",
                "tools/run-semantic-v8-experiment.mjs",
                "run",
                "--study",
                frozen / "study.json",
                "--cases",
                frozen / "private-cases.json",
                "--out",
                output / f"study-{label}",
                "--megatoken",
                args.consumer.resolve(),
                "--served",
                fit / "fitted",
                "--python",
                args.python,
            ],
            args.evaluation_producer.resolve(),
            f"study-{label}",
        )
    print(output)


if __name__ == "__main__":
    main()
