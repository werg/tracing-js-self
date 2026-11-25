"""Inkling/Tinker boundary, with exact sampled-token provenance for RL.

The JS environment owns execution and grading. This module only renders messages,
samples complete assistant turns, and submits already graded training examples.
Heavy dependencies are imported on first use so offline harness tests stay small.
"""

from __future__ import annotations

import copy
import importlib.metadata
import math
from collections.abc import Mapping, Sequence
from types import SimpleNamespace
from typing import Any

DEFAULT_MODEL = "thinkingmachines/Inkling-2-Mini:peft:65536:free"
FREE_CONTEXT_TOKENS = 65536


class AdapterError(RuntimeError):
    """An actionable adapter failure, safe to include in a run report."""


class ContextOverflow(AdapterError):
    """The complete conversation does not fit; it must never be truncated."""


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _finite(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _seed(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < 2**31:
        raise ValueError("seed must be an integer in [0, 2147483647]")
    return value


def _json_value(value: Any) -> Any:
    """Keep thoughts and tool-call structure while removing SDK object wrappers."""
    if hasattr(value, "model_dump"):
        return _json_value(value.model_dump(mode="json"))
    if isinstance(value, Mapping):
        return {str(k): _json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"Cannot serialize SDK value of type {type(value).__name__}")


def assistant_text(message: Mapping[str, Any]) -> str:
    """Visible assistant text; reasoning stays in the stored message and tokens."""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, Mapping) and part.get("type") == "text"
        )
    return ""


def rl_token_arrays(sample: Mapping[str, Any], advantage: float) -> dict[str, list]:
    """Build the next-token shift from the *actual* rollout, never from text.

    Each turn has its own prompt, including only observations received so far.
    Prompt positions have zero advantage, including earlier model turns; the
    current sampled turn alone receives this trajectory's advantage.
    """
    if sample.get("provenance_error"):
        raise ValueError("Cannot train RL on a sample with a provenance_error")
    prompt = list(sample.get("prompt_tokens", []))
    tokens = list(sample.get("token_ids", []))
    logprobs = list(sample.get("logprobs", []))
    if not prompt or not tokens:
        raise ValueError("RL requires nonempty original prompt_tokens and token_ids")
    if any(isinstance(t, bool) or not isinstance(t, int) or t < 0 for t in prompt + tokens):
        raise ValueError("RL token IDs must be nonnegative integers")
    if len(logprobs) != len(tokens):
        raise ValueError("Every sampled token must retain its original sampling logprob")
    logprobs = [_finite(x, "sampling logprob") for x in logprobs]
    advantage = _finite(advantage, "advantage")
    sequence = prompt + tokens
    prefix_length = len(prompt) - 1
    return {
        "input_tokens": sequence[:-1],
        "target_tokens": sequence[1:],
        "logprobs": [0.0] * prefix_length + logprobs,
        "advantages": [0.0] * prefix_length + [advantage] * len(tokens),
    }


class TinkerAdapter:
    """Small synchronous adapter over the SDK's awaitable futures.

    ``runtime`` and ``service_client`` allow dependency-free tests with fakes.
    No client is created, and no network request occurs, during construction.
    Sampling keeps the model named in config exactly; there is no paid fallback.
    """

    backend_name = "tinker"

    def __init__(self, config: Mapping[str, Any] | None = None, *, runtime=None, service_client=None):
        self.config = dict(config or {})
        self.model = self.config.get("model", self.config.get("model_name", DEFAULT_MODEL))
        if not isinstance(self.model, str) or not self.model.strip():
            raise ValueError("model must be a nonempty Tinker model ID")
        self.effort = _finite(self.config.get("effort", 0.9), "effort")
        if not 0 <= self.effort < 1:
            raise ValueError("effort must be in [0, 1)")
        self.max_context_tokens = _positive_int(
            self.config.get("max_context_tokens", FREE_CONTEXT_TOKENS), "max_context_tokens"
        )
        if self.model == DEFAULT_MODEL and self.max_context_tokens > FREE_CONTEXT_TOKENS:
            raise ValueError("The configured free model has a 65536-token context limit")
        self.max_tokens = _positive_int(self.config.get("max_tokens", 4096), "max_tokens")
        self.temperature = _finite(self.config.get("temperature", 1.0), "temperature")
        if self.temperature < 0:
            raise ValueError("temperature must be nonnegative")
        self.learning_rate = _finite(self.config.get("learning_rate", 1e-4), "learning_rate")
        if self.learning_rate <= 0:
            raise ValueError("learning_rate must be positive")
        self.lora_rank = _positive_int(self.config.get("lora_rank", 32), "lora_rank")
        self.seed = _seed(self.config.get("seed", 0))
        self.timeout = _finite(self.config.get("request_timeout_seconds", 300), "request_timeout_seconds")
        if self.timeout <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        self._runtime = runtime
        self._service = service_client
        self.training_client = None
        self.sampling_client = None
        self.training_steps = 0
        self.sampling_revision = "base"

    def _sdk(self):
        if self._runtime is None:
            try:
                import tinker
                from tinker_cookbook import model_info
                from tinker_cookbook.renderers import TrainOnWhat, get_renderer
                from tinker_cookbook.supervised.common import datum_from_model_input_weights
                from tinker_cookbook.tokenizer_utils import get_tokenizer

                tokenizer = get_tokenizer(self.model)
                renderer_name = model_info.get_recommended_renderer_name(self.model)
                renderer = get_renderer(renderer_name, tokenizer)
                self._runtime = SimpleNamespace(
                    types=tinker.types,
                    renderer=renderer,
                    renderer_name=renderer_name,
                    tokenizer=tokenizer,
                    datum_builder=datum_from_model_input_weights,
                    customized=TrainOnWhat.CUSTOMIZED,
                    service_factory=tinker.ServiceClient,
                    rest_factory=tinker.RestClient,
                )
            except Exception as exc:
                raise AdapterError(
                    f"Could not load the Inkling SDK/renderer ({type(exc).__name__}). "
                    "Install the pinned training dependencies with Python 3.11+; "
                    "tml-renderers requires PyTorch >=2.10."
                ) from None
        return self._runtime

    def _client(self):
        if self._service is None:
            try:
                self._service = self._sdk().service_factory()
            except Exception as exc:
                raise AdapterError(
                    f"Tinker client initialization failed ({type(exc).__name__}). "
                    "Configure TINKER_API_KEY or Tinker CLI authentication."
                ) from None
        return self._service

    def _wait(self, future, operation: str):
        try:
            return future.result(timeout=self.timeout)
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            status_text = f", HTTP {status}" if isinstance(status, int) else ""
            raise AdapterError(
                f"Tinker {operation} failed ({type(exc).__name__}{status_text}). "
                "Check authentication, model access, a positive prepaid balance, and rate limits. "
                "No alternate model was selected. An interrupted update is not automatically replayed."
            ) from None

    def _budget(self, length: int, output_tokens: int = 0):
        if length + output_tokens > self.max_context_tokens:
            raise ContextOverflow(
                f"Complete sequence needs {length} input + {output_tokens} reserved output tokens; "
                f"limit is {self.max_context_tokens}. Split the dataset example or reduce the "
                "generation budget; conversation history was not truncated."
            )

    def check(self, remote: bool = False) -> dict:
        """Check imports/rendering, optionally query model access without compute."""
        sdk = self._sdk()
        versions = {}
        for package in ("tinker", "tinker-cookbook", "tml-renderers", "torch"):
            try:
                versions[package] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                versions[package] = "not installed (injected runtime)"
        result = {
            "model": self.model,
            "renderer": sdk.renderer_name,
            "effort": self.effort,
            "max_context_tokens": self.max_context_tokens,
            "versions": versions,
        }
        # Rendering here catches tokenizer binary/ABI failures before a run starts.
        prompt = sdk.renderer.build_generation_prompt(
            [{"role": "user", "content": "Return 1."}], effort=self.effort
        )
        self._budget(len(prompt.to_ints()), self.max_tokens)
        if remote:
            capabilities = self._wait(sdk.rest_factory().get_server_capabilities(), "capability check")
            supported = {item.model_name for item in capabilities.supported_models}
            if self.model not in supported:
                raise AdapterError(
                    f"Configured model {self.model!r} is not available to this account. "
                    "No alternate model was selected."
                )
            result["model_available"] = True
        return result

    def create_training_client(self, checkpoint: str | None = None):
        if checkpoint:
            future = self._client().create_training_client_from_state_with_optimizer(
                path=checkpoint, base_model=self.model
            )
        else:
            future = self._client().create_lora_training_client(
                base_model=self.model, rank=self.lora_rank, seed=self.seed
            )
        self.training_client = self._wait(future, "training client creation")
        # Sampling is changed only by an explicit refresh, so baseline evaluation
        # can use the base model while the new learner is initialized separately.
        return self.training_client

    def create_sampling_client(self, checkpoint: str | None = None):
        kwargs = {"model_path": checkpoint} if checkpoint else {"base_model": self.model}
        self.sampling_client = self._wait(self._client().create_sampling_client(**kwargs), "sampling client creation")
        self.sampling_revision = checkpoint or "base"
        return self.sampling_client

    def refresh_sampler(self):
        if self.training_client is None:
            raise AdapterError("Create a training client before refreshing the sampler")
        self.sampling_client = self._wait(
            self.training_client.save_weights_and_get_sampling_client(), "sampler refresh"
        )
        self.sampling_revision = f"training-step-{self.training_steps}"
        return self.sampling_client

    @staticmethod
    def _messages(messages: Sequence[Mapping[str, Any]], *, training: bool = False) -> list[dict]:
        if not isinstance(messages, (list, tuple)) or not messages:
            raise ValueError("messages must be a nonempty list")
        result = []
        for message in messages:
            if not isinstance(message, Mapping) or not isinstance(message.get("role"), str):
                raise ValueError("Every message requires a role")
            item = copy.deepcopy(dict(message))
            if training:
                # External observations NEVER carry loss, even if an imported
                # dataset mistakenly marks a tool/user message as trainable.
                item["trainable"] = item["role"] == "assistant" and item.get("trainable", True) is not False
            result.append(item)
        if training and not any(item["trainable"] for item in result):
            raise ValueError("Supervised examples require a trainable assistant message")
        return result

    def render_sft(self, messages: Sequence[Mapping[str, Any]]) -> list:
        sdk = self._sdk()
        prepared = self._messages(messages, training=True)
        rendered = sdk.renderer.build_supervised_examples(
            prepared, train_on_what=sdk.customized, effort=self.effort
        )
        if not rendered:
            raise ValueError("Renderer produced no supervised examples")
        datums = []
        for model_input, weights in rendered:
            tokens = model_input.to_ints()
            self._budget(len(tokens))
            if len(tokens) < 2 or len(weights) != len(tokens):
                raise ValueError("Renderer produced misaligned supervised tokens/weights")
            weight_values = list(weights.tolist() if hasattr(weights, "tolist") else weights)
            if any(_finite(x, "supervised weight") < 0 for x in weight_values):
                raise ValueError("Supervised weights must be nonnegative")
            if sum(weight_values[1:]) <= 0:
                raise ValueError("Rendered example has no trainable target tokens")
            # No max_length: the helper's optional truncation would create an
            # incomplete teacher execution, which must be rejected instead.
            datums.append(sdk.datum_builder(model_input, weights, reduction="mean"))
        return datums

    def _generation_prompt(self, messages: Sequence[Mapping[str, Any]], max_tokens: int | None = None):
        prompt = self._sdk().renderer.build_generation_prompt(self._messages(messages), effort=self.effort)
        prompt_tokens = list(prompt.to_ints())
        if not prompt_tokens:
            raise ValueError("Renderer produced an empty generation prompt")
        budget = self.max_tokens if max_tokens is None else _positive_int(max_tokens, "max_tokens")
        self._budget(len(prompt_tokens), budget)
        return prompt, prompt_tokens, budget

    def validate_prompt(self, messages: Sequence[Mapping[str, Any]], max_tokens: int | None = None) -> dict:
        """Check the actual prompt and reserved output without creating a client."""
        _, prompt_tokens, budget = self._generation_prompt(messages, max_tokens)
        return {"prompt_tokens": len(prompt_tokens), "reserved_output_tokens": budget,
                "total_tokens": len(prompt_tokens) + budget, "limit": self.max_context_tokens}

    def sample(self, messages: Sequence[Mapping[str, Any]], max_tokens: int | None = None, seed: int | None = None) -> dict:
        sdk = self._sdk()
        prompt, prompt_tokens, budget = self._generation_prompt(messages, max_tokens)
        if self.sampling_client is None:
            self.create_sampling_client()
        params = {"max_tokens": budget, "temperature": self.temperature, "stop": sdk.renderer.get_stop_sequences()}
        if seed is not None:
            params["seed"] = _seed(seed)
        response = self._wait(
            self.sampling_client.sample(prompt=prompt, num_samples=1, sampling_params=sdk.types.SamplingParams(**params)),
            "sampling",
        )
        # Once a response arrives, even a broken response must retain its full
        # generation cost. Never raise and lose its tokens during validation.
        sequences = list(response.sequences)
        tokens = [token for sequence in sequences for token in sequence.tokens]
        logprobs = [value for sequence in sequences for value in (sequence.logprobs or [])]
        provenance_errors = []
        if len(sequences) != 1:
            provenance_errors.append("Expected exactly one sampled sequence")
        if len(logprobs) != len(tokens) or any(
            isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
            for x in logprobs
        ):
            provenance_errors.append("Every sampled token must retain a finite sampling logprob")
        # JSON cannot faithfully represent NaN/Infinity. Retain an explicit
        # missing marker, and refuse to use this record for an RL update.
        logprobs = [float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None for x in logprobs]
        if len(tokens) > budget:
            provenance_errors.append("Sample exceeds the requested generation budget")
        message = {"role": "assistant", "content": ""}
        termination_name = "malformed"
        clean = False
        parse_error = None
        if len(sequences) == 1:
            try:
                parsed, termination = sdk.renderer.parse_response(tokens)
                message = _json_value(parsed)
                termination_name = str(getattr(termination, "value", termination))
                clean = bool(getattr(termination, "is_clean", termination_name in {"stop_sequence", "eos"}))
            except Exception as exc:
                parse_error = f"Renderer parsing failed ({type(exc).__name__})"
        stop_reason = str(sequences[0].stop_reason) if len(sequences) == 1 else "invalid_response"
        complete = bool(tokens) and clean and not provenance_errors and stop_reason not in {"length", "max_tokens", "max_length"}
        record = {
            "message": message,
            "text": assistant_text(message),
            "prompt_tokens": prompt_tokens,
            "token_ids": tokens,
            "logprobs": logprobs,
            "stop_reason": stop_reason,
            "parse_termination": termination_name,
            "complete": complete,
            "generated_tokens": len(tokens),
            "model": self.model,
            "sampler_revision": self.sampling_revision,
        }
        if provenance_errors:
            record["provenance_error"] = "; ".join(provenance_errors)
        if parse_error:
            record["parse_error"] = parse_error
        return record

    def _update(self, datums: list, loss_fn: str, learning_rate: float | None) -> dict:
        if not datums:
            raise ValueError("Cannot update with an empty training batch")
        rate = self.learning_rate if learning_rate is None else _finite(learning_rate, "learning_rate")
        if rate <= 0:
            raise ValueError("learning_rate must be positive")
        if self.training_client is None:
            self.create_training_client()
        # Submit in order before waiting, as required by SDK pipelining. SDK
        # futures handle retry/idempotency; never resubmit a timed-out update.
        forward = self.training_client.forward_backward(datums, loss_fn=loss_fn)
        optimizer = self.training_client.optim_step(self._sdk().types.AdamParams(learning_rate=rate))
        forward_result = self._wait(forward, "forward/backward")
        self._wait(optimizer, "optimizer step")
        self.training_steps += 1
        return {"step": self.training_steps, "examples": len(datums), "loss_fn": loss_fn, "metrics": _json_value(forward_result.metrics)}

    def sft_train(self, examples: Sequence[Mapping[str, Any]], learning_rate: float | None = None) -> dict:
        datums = []
        for example in examples:
            datums.extend(self.render_sft(example["messages"]))
        return self._update(datums, "cross_entropy", learning_rate)

    def rl_train(self, trajectories: Sequence[Mapping[str, Any]], learning_rate: float | None = None, loss_fn: str = "importance_sampling") -> dict:
        if loss_fn not in {"importance_sampling", "ppo", "cispo"}:
            raise ValueError("RL loss_fn must be importance_sampling, ppo, or cispo")
        sdk = self._sdk()
        datums = []
        for trajectory in trajectories:
            advantage = _finite(trajectory["advantage"], "advantage")
            for sample in trajectory["samples"]:
                arrays = rl_token_arrays(sample, advantage)
                self._budget(len(arrays["input_tokens"]) + 1)
                datums.append(sdk.types.Datum(
                    model_input=sdk.types.ModelInput.from_ints(arrays.pop("input_tokens")),
                    loss_fn_inputs=arrays,
                ))
        return self._update(datums, loss_fn, learning_rate)

    def checkpoint(self, name: str) -> dict:
        if self.training_client is None:
            raise AdapterError("Create a training client before saving a checkpoint")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("checkpoint name must be nonempty")
        training = self._wait(self.training_client.save_state(name=name), "training checkpoint save")
        sampler = self._wait(self.training_client.save_weights_for_sampler(name=name), "sampler checkpoint save")
        return {"training_path": training.path, "sampler_path": sampler.path, "step": self.training_steps}
