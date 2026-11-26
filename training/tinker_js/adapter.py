"""Inkling/Tinker boundary, with exact sampled-token provenance for RL.

The JS environment owns execution and grading. This module only renders messages,
samples complete assistant turns, and submits already graded training examples.
Heavy dependencies are imported on first use so offline harness tests stay small.
"""

from __future__ import annotations

import copy
import importlib.metadata
import json
import math
import re
import statistics
import threading
from collections.abc import Mapping, Sequence
from types import SimpleNamespace
from typing import Any

DEFAULT_MODEL = "thinkingmachines/Inkling-2-Mini:peft:65536:free"
FREE_CONTEXT_TOKENS = 65536
MAX_CONTEXT_TOKENS = 1_048_576


def model_context_limit(model: str) -> int:
    """Infer the model's declared context limit from its Tinker model ID."""
    match = re.search(r":peft:(\d+)(?::|$)", model)
    if match:
        return int(match.group(1))
    if model == DEFAULT_MODEL:
        return FREE_CONTEXT_TOKENS
    return MAX_CONTEXT_TOKENS


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


def _tensor_values(value: Any) -> list:
    """Accept both SDK TensorData and injected test arrays."""
    if isinstance(value, (list, tuple)):
        return list(value)
    if hasattr(value, "tolist"):
        return list(value.tolist())
    if hasattr(value, "data"):
        return list(value.data)
    raise ValueError("Expected a one-dimensional token tensor")


def _log_ratio_metrics(sampling: Sequence[float], comparison: Sequence[float], prefix: str) -> dict:
    """Sample-based divergence diagnostics, never an exact distribution KL."""
    if len(sampling) != len(comparison) or not sampling:
        raise ValueError("Divergence requires aligned nonempty log probabilities")
    ratios = [_finite(p, "sampling logprob") - _finite(q, "comparison logprob")
              for p, q in zip(sampling, comparison)]
    # k3 = exp(-log(p/q)) - 1 + log(p/q). Clip only the exponential's
    # diagnostic domain, report it, and do not confuse this with PPO clipping.
    clipped = [max(-20.0, min(20.0, ratio)) for ratio in ratios]
    return {f"{prefix}_sampled_log_ratio_mean": statistics.fmean(ratios),
            f"{prefix}_kl_k3_estimate": statistics.fmean(math.exp(-x) - 1 + x for x in clipped),
            f"{prefix}_diagnostic_clipped_tokens": sum(a != b for a, b in zip(ratios, clipped)),
            f"{prefix}_scored_tokens": len(ratios)}


def _supervised_action_kind(text: str) -> str:
    """Classify the bridge's final-action grammar; this does not grade execution."""
    text = text.strip()
    fences = list(re.finditer(r"```(?:json)?\s*\n?([\s\S]*?)```", text))
    if fences:
        if len(fences) != 1 or fences[0].end() != len(text):
            return "unknown"
        text = fences[0].group(1)
    try:
        action = json.loads(text)
    except (ValueError, TypeError):
        return "unknown"
    if not isinstance(action, dict):
        return "unknown"
    if (set(action) == {"type", "operation", "arguments"} and action.get("type") == "call"
            and isinstance(action.get("operation"), str)):
        return "call_request"
    if (set(action) == {"type", "kind", "value", "arguments"} and action.get("type") == "complete"
            and isinstance(action.get("kind"), str) and action["kind"] in {"return", "throw"}):
        return "completion"
    return "unknown"


def _sft_forward_diagnostics(layouts: list[dict], outputs: Any, long_threshold: int) -> dict:
    """Aggregate existing forward logprobs using the exact submitted weights.

    Output/mask misalignment is a diagnostics failure, never grounds to retry an
    optimizer step that has already completed. Metadata remains available.
    """
    logprobs = None
    unavailable = None
    try:
        if outputs is None or len(outputs) != len(layouts):
            raise ValueError("forward output count does not match submitted datums")
        values = [_tensor_values(output["logprobs"]) for output in outputs]
        for layout, scores in zip(layouts, values):
            if len(scores) != len(layout["weights"]):
                raise ValueError("forward log probabilities are not target-token aligned")
            for score, weight in zip(scores, layout["weights"]):
                if weight > 0:
                    _finite(score, "supervised target logprob")
        logprobs = values
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        unavailable = str(error)

    def empty() -> dict:
        return {"trainable_tokens": 0, "prediction_weight": 0.0,
                "weighted_nll_sum": 0.0 if logprobs is not None else None}

    total = empty()
    grouped = {"by_action": {}, "by_execution_length": {}, "by_tier": {}, "by_feature": {}}
    masked = 0
    masked_nonassistant = 0
    for index, layout in enumerate(layouts):
        for position, weight in enumerate(layout["weights"]):
            if weight <= 0:
                masked += 1
                masked_nonassistant += layout["roles"][position] not in {"model", "unknown"}
                continue
            labels = {"by_action": [layout["actions"][position]],
                      "by_execution_length": [layout["length_band"]],
                      "by_tier": [layout["tier"]],
                      "by_feature": layout["features"] or ["unlabeled"]}
            buckets = [total]
            for group, names in labels.items():
                for name in names:
                    buckets.append(grouped[group].setdefault(name, empty()))
            for bucket in buckets:
                bucket["trainable_tokens"] += 1
                bucket["prediction_weight"] += weight
                if logprobs is not None:
                    bucket["weighted_nll_sum"] -= weight * logprobs[index][position]

    for bucket in [total, *(bucket for groups in grouped.values() for bucket in groups.values())]:
        weight = bucket["prediction_weight"]
        bucket["weighted_mean_nll"] = bucket["weighted_nll_sum"] / weight if logprobs is not None and weight else None
        bucket["weighted_mean_target_logprob"] = -bucket["weighted_mean_nll"] if bucket["weighted_mean_nll"] is not None else None
    return {"loss_available": logprobs is not None, "unavailable_reason": unavailable,
            "source": "existing forward_backward token logprobs and original datum prediction weights"
                      if logprobs is not None else "submitted-target metadata only; forward loss diagnostics unavailable",
            "meaning": "Teacher-target negative log likelihood, not execution accuracy",
            "action_scope": "Entire assistant message classified by its valid final action; unrecognized formats remain unknown",
            "length_scope": "Positive-weight target tokens per original execution example across its rendered datums",
            "long_execution_threshold_tokens": long_threshold,
            "feature_scope": "Features are overlapping labels; action, length, and tier groups are disjoint partitions",
            "executions": len({layout["execution_index"] for layout in layouts}), "datums": len(layouts),
            "action_boundaries_available_datums": sum(layout["boundaries_available"] for layout in layouts),
            "masked_target_tokens": masked, "masked_nonassistant_tokens": masked_nonassistant,
            "total": total, **grouped}


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
    target_tokens = list(sample.get("target_tokens") or [])
    target_logprobs = list(sample.get("target_logprobs") or [])
    target_advantage = _finite(sample.get("target_advantage", 0.0), "target_advantage")
    if target_tokens and abs(target_advantage) > 1e-12:
        if any(isinstance(t, bool) or not isinstance(t, int) or t < 0 for t in target_tokens):
            raise ValueError("RL target token IDs must be nonnegative integers")
        if len(target_logprobs) != len(target_tokens):
            raise ValueError("Every target action token must retain its scored logprob")
        target_logprobs = [_finite(x, "target action logprob") for x in target_logprobs]
        sequence = prompt + tokens + target_tokens
        prefix_length = len(prompt) - 1
        return {
            "input_tokens": sequence[:-1],
            "target_tokens": sequence[1:],
            "logprobs": [0.0] * prefix_length + logprobs + target_logprobs,
            "advantages": [0.0] * prefix_length + [advantage] * len(tokens) + [target_advantage] * len(target_tokens),
        }
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
            self.config.get("max_context_tokens", model_context_limit(self.model)), "max_context_tokens"
        )
        limit = model_context_limit(self.model)
        if self.max_context_tokens > limit:
            raise ValueError(f"Configured model {self.model!r} has a {limit}-token context limit")
        self.rl_token_normalization = self.config.get("rl_token_normalization", "none")
        if self.rl_token_normalization not in {"none", "trajectory"}:
            raise ValueError("rl_token_normalization must be none or trajectory")
        self.max_tokens = _positive_int(self.config.get("max_tokens", 4096), "max_tokens")
        self.temperature = _finite(self.config.get("temperature", 1.0), "temperature")
        if self.temperature < 0:
            raise ValueError("temperature must be nonnegative")
        self.learning_rate = _finite(self.config.get("learning_rate", 1e-4), "learning_rate")
        if self.learning_rate <= 0:
            raise ValueError("learning_rate must be positive")
        self.sft_weighting = self.config.get("sft_weighting", "example")
        if self.sft_weighting not in {"example", "token"}:
            raise ValueError("sft_weighting must be example or token")
        self.sft_diagnostic_long_tokens = _positive_int(
            self.config.get("sft_diagnostic_long_tokens", 512), "sft_diagnostic_long_tokens")
        self.reference_kl_coef = _finite(self.config.get("reference_kl_coef", 0.0), "reference_kl_coef")
        self.reference_kl_clip = _finite(self.config.get("reference_kl_clip", 20.0), "reference_kl_clip")
        if self.reference_kl_coef < 0 or self.reference_kl_clip <= 0:
            raise ValueError("reference_kl_coef must be nonnegative and reference_kl_clip positive")
        self.lora_rank = _positive_int(self.config.get("lora_rank", 32), "lora_rank")
        self.seed = _seed(self.config.get("seed", 0))
        self.timeout = _finite(self.config.get("request_timeout_seconds", 300), "request_timeout_seconds")
        if self.timeout <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        self._runtime = runtime
        self._injected_runtime = runtime is not None
        self._service = service_client
        self.training_client = None
        self.sampling_client = None
        self.training_steps = 0
        self.sampling_revision = "base"
        self.reference_client = None
        self.reference_checkpoint = None
        self._token_pieces: dict[int, str] = {}
        self._lock = threading.RLock()
        self.training_identity: dict = {}

    def _sdk(self):
        if self._runtime is not None:
            return self._runtime
        with self._lock:
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

    def _retry_idempotent(self, call, operation: str, attempts: int = 3):
        """Retry transient failures only on idempotent checkpoint/sampler calls, never optimizer updates."""
        import time
        last_error = None
        for attempt in range(attempts):
            try:
                return self._wait(call(), operation)
            except AdapterError as exc:
                last_error = exc
                if self._injected_runtime or attempt + 1 >= attempts:
                    raise
                time.sleep(min(2.0 * (2 ** attempt), 15.0))
        raise last_error

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
        self.training_client = None
        if checkpoint:
            future = self._client().create_training_client_from_state_with_optimizer(
                path=checkpoint, base_model=self.model
            )
        else:
            future = self._client().create_lora_training_client(
                base_model=self.model, rank=self.lora_rank, seed=self.seed
            )
        client = self._wait(future, "training client creation")
        self.training_identity = self._verify_training_identity(client, checkpoint)
        self.training_client = client
        # Sampling is changed only by an explicit refresh, so baseline evaluation
        # can use the base model while the new learner is initialized separately.
        return self.training_client

    def _verify_training_identity(self, client, checkpoint: str | None) -> dict:
        """Check SDK-cached model identity before accepting a fresh/restored learner."""
        getter = getattr(client, "get_info", None)
        if not callable(getter):
            if self._injected_runtime:
                return {"verified": False, "reason": "injected test client has no cached get_info"}
            raise AdapterError("Training client has no cached get_info; model identity could not be verified before training")
        try:
            info = getter()  # SDK get_info is synchronous cached metadata, not model compute.
            field = lambda value, name, default=None: value.get(name, default) if isinstance(value, Mapping) else getattr(value, name, default)
            reported = field(field(info, "model_data"), "model_name")
            rank = field(info, "lora_rank")
        except Exception as error:
            raise AdapterError(f"Could not read cached training model identity ({type(error).__name__}); no update was sent") from None
        if not isinstance(reported, str) or not reported:
            raise AdapterError("Training client did not report its base model; no update was sent")
        # Tinker may report the canonical base without a ':peft:...' routing
        # qualification. No other suffix stripping or fuzzy alias is accepted.
        if reported.split(":peft:", 1)[0] != self.model.split(":peft:", 1)[0]:
            raise AdapterError(f"Training checkpoint base model {reported!r} differs from configured model {self.model!r}; no update was sent")
        if rank is not None and (isinstance(rank, bool) or not isinstance(rank, int) or rank != self.lora_rank):
            raise AdapterError(f"Training checkpoint LoRA rank {rank!r} differs from configured rank {self.lora_rank}; no update was sent")
        return {"verified": True, "configured_model": self.model, "reported_model": reported,
                "lora_rank": rank, "restored_checkpoint": checkpoint is not None}

    def create_sampling_client(self, checkpoint: str | None = None):
        kwargs = {"model_path": checkpoint} if checkpoint else {"base_model": self.model}
        self.sampling_client = self._retry_idempotent(
            lambda: self._client().create_sampling_client(**kwargs), "sampling client creation"
        )
        self.sampling_revision = checkpoint or "base"
        return self.sampling_client

    def refresh_sampler(self):
        if self.training_client is None:
            raise AdapterError("Create a training client before refreshing the sampler")
        self.sampling_client = self._retry_idempotent(
            lambda: self.training_client.save_weights_and_get_sampling_client(), "sampler refresh"
        )
        self.sampling_revision = f"training-step-{self.training_steps}"
        return self.sampling_client

    def set_reference_checkpoint(self, checkpoint: str):
        """Bind optional KL shaping to one fixed SFT sampler, independently of refreshes."""
        if not isinstance(checkpoint, str) or not checkpoint.startswith("tinker://"):
            raise ValueError("reference checkpoint must be a Tinker sampler checkpoint")
        if self.reference_checkpoint is not None and self.reference_checkpoint != checkpoint:
            raise ValueError("The fixed reference checkpoint cannot change within a run")
        if self.reference_client is None:
            self.reference_client = self._wait(
                self._client().create_sampling_client(model_path=checkpoint), "reference sampler creation")
        self.reference_checkpoint = checkpoint
        return self.reference_client

    def score_sample(self, sample: Mapping[str, Any], *, sampler=None) -> list[float]:
        """Score the actual prompt + completion IDs; never reconstruct them from text."""
        rl_token_arrays(sample, 0.0)  # Validate complete original provenance first.
        prompt = list(sample["prompt_tokens"])
        tokens = list(sample["token_ids"])
        self._budget(len(prompt) + len(tokens))
        client = sampler or self.sampling_client
        if client is None:
            client = self.create_sampling_client()
        values = self._wait(client.compute_logprobs(
            self._sdk().types.ModelInput.from_ints(prompt + tokens),
            prompt_logprobs_last_n=len(tokens)), "completion logprob scoring")
        if len(values) != len(prompt) + len(tokens):
            raise AdapterError("Scoring returned misaligned prompt/completion log probabilities")
        return [_finite(value, "scored completion logprob") for value in values[len(prompt):]]

    def thinking_token_ids(self) -> tuple[int, int, int]:
        """Return (message_model_id, content_thinking_id, end_message_id) for tml_v0."""
        cached = getattr(self, "_thinking_ids", None)
        if cached is not None:
            return cached
        with self._lock:
            sdk = self._sdk()
            tokenizer = sdk.tokenizer
            if tokenizer is None or not hasattr(tokenizer, "decode"):
                raise AdapterError("Likelihood reasoning RL requires a tokenizer with tml_v0 special tokens")
            probe = [
                {"role": "user", "content": "x"},
                {"role": "assistant", "content": [{"type": "thinking", "thinking": "y"}, {"type": "text", "text": "z"}]},
            ]
            model_input, _weights = sdk.renderer.build_supervised_example(probe)
            wanted = ("<|message_model|>", "<|content_thinking|>", "<|end_message|>")
            found: dict[str, int] = {}
            for tid in model_input.to_ints():
                piece = tokenizer.decode([int(tid)])
                if piece in wanted:
                    found[piece] = int(tid)
            missing = [piece for piece in wanted if piece not in found]
            if missing:
                raise AdapterError(f"Could not locate tml_v0 thinking special tokens: {missing}")
            resolved = (found["<|message_model|>"], found["<|content_thinking|>"], found["<|end_message|>"])
            self._thinking_ids = resolved
            return resolved

    def extract_turn_targets(self, messages: Sequence[Mapping[str, Any]]) -> list[dict]:
        """Decompose a recorded conversation into per-turn (thinking_prompt, target_action_tokens)."""
        msg_model_id, content_thinking_id, _end_message_id = self.thinking_token_ids()
        sdk = self._sdk()

        def _strip_thinking(msg: Mapping[str, Any]) -> dict:
            if msg.get("role") != "assistant":
                return dict(msg)
            out = {k: v for k, v in msg.items() if k != "content"}
            if msg.get("tool_calls"):
                out["content"] = ""
            else:
                content = msg.get("content", "")
                if isinstance(content, list):
                    visible = "".join(
                        part.get("text", "") for part in content
                        if isinstance(part, Mapping) and part.get("type") == "text"
                    )
                    out["content"] = visible
                else:
                    out["content"] = content
            return out

        turns: list[dict] = []
        with self._lock:
            for idx, msg in enumerate(messages):
                if msg.get("role") != "assistant":
                    continue
                prefix_messages = [_strip_thinking(m) for m in messages[:idx]]
                action_msg = _strip_thinking(msg)
                prefix_tokens = list(sdk.renderer.build_generation_prompt(prefix_messages, effort=self.effort).to_ints())
                model_input, weights = sdk.renderer.build_supervised_example(prefix_messages + [action_msg])
                full_ids = list(model_input.to_ints())
                w_list = [float(w) for w in _tensor_values(weights)]
                # Target action tokens are the positive-weight suffix for the final assistant message.
                first_target = next((i for i, wt in enumerate(w_list) if wt > 0), None)
                if first_target is None:
                    continue
                # Find the start of the last assistant turn (in case earlier turns also had positive weights).
                last_zero = max((i for i in range(len(w_list)) if w_list[i] <= 0), default=-1)
                target_start = last_zero + 1
                target_action_tokens = full_ids[target_start:]
                if not target_action_tokens:
                    continue
                tool_calls = msg.get("tool_calls") or []
                op_name = (tool_calls[0].get("function", {}).get("name") if tool_calls else None) or "complete"
                turns.append({
                    "turn_index": len(turns),
                    "message_index": idx,
                    "prefix_tokens": prefix_tokens,
                    "thinking_prompt_tokens": prefix_tokens + [msg_model_id, content_thinking_id],
                    "target_action_tokens": target_action_tokens,
                    "is_tool_call": bool(tool_calls),
                    "operation": op_name,
                })
        return turns

    def sample_thinking_and_score_target(
        self,
        turn_target: Mapping[str, Any],
        *,
        seed: int,
        max_tokens: int | None = None,
        temperature: float | None = None,
        scorer=None,
    ) -> dict:
        """Sample one <|content_thinking|> block stopping at <|end_message|>, then score exact log P(target | prefix, z)."""
        _msg_model_id, _content_thinking_id, end_message_id = self.thinking_token_ids()
        thinking_prompt = list(turn_target["thinking_prompt_tokens"])
        target_tokens = list(turn_target["target_action_tokens"])
        budget = self.max_tokens if max_tokens is None else _positive_int(max_tokens, "max_tokens")
        temp = self.temperature if temperature is None else _finite(temperature, "temperature")
        if temp < 0:
            raise ValueError("temperature must be nonnegative")
        # Reserve room for both the sampled thought and the appended target action tokens.
        max_thought_budget = min(budget, self.max_context_tokens - len(thinking_prompt) - len(target_tokens))
        if max_thought_budget <= 0:
            raise ContextOverflow(
                f"Prompt ({len(thinking_prompt)}) + target ({len(target_tokens)}) exceeds context limit {self.max_context_tokens}"
            )
        sdk = self._sdk()
        client = self.sampling_client
        if client is None:
            client = self.create_sampling_client()
        revision = self.sampling_revision
        params = sdk.types.SamplingParams(
            max_tokens=max_thought_budget,
            temperature=temp,
            seed=_seed(seed),
            stop=[end_message_id],
        )
        response = self._wait(
            client.sample(sdk.types.ModelInput.from_ints(thinking_prompt), num_samples=1, sampling_params=params),
            "thinking block sampling",
        )
        if not response.sequences:
            raise AdapterError("Tinker returned no sampled sequences for thinking block")
        seq = response.sequences[0]
        z_tokens = [int(t) for t in seq.tokens]
        z_logprobs_raw = list(seq.logprobs) if seq.logprobs is not None else []
        provenance_error = None
        z_logprobs: list[float] = []
        if not z_tokens:
            provenance_error = "empty thinking sample"
        elif len(z_logprobs_raw) != len(z_tokens):
            provenance_error = "missing thinking sampling logprobs"
        else:
            try:
                z_logprobs = [_finite(x, "thinking logprob") for x in z_logprobs_raw]
            except ValueError as err:
                provenance_error = str(err)

        terminated = (provenance_error is None) and bool(z_tokens) and (z_tokens[-1] == end_message_id)
        target_logprobs = None
        target_logprob_sum = None
        target_logprob_mean = None
        if terminated:
            score_client = scorer or client
            full_ids = thinking_prompt + z_tokens + target_tokens
            self._budget(len(full_ids))
            values = self._wait(
                score_client.compute_logprobs(
                    sdk.types.ModelInput.from_ints(full_ids),
                    prompt_logprobs_last_n=len(target_tokens),
                ),
                "target action logprob scoring",
            )
            if len(values) != len(full_ids):
                raise AdapterError("Target scoring returned misaligned log probabilities")
            target_logprobs = [_finite(v, "target action logprob") for v in values[-len(target_tokens):]]
            target_logprob_sum = sum(target_logprobs)
            target_logprob_mean = target_logprob_sum / len(target_logprobs)

        return {
            "prompt_tokens": thinking_prompt,
            "token_ids": z_tokens,
            "logprobs": z_logprobs,
            "target_tokens": target_tokens,
            "target_logprobs": target_logprobs,
            "target_logprob_sum": target_logprob_sum,
            "target_logprob_mean": target_logprob_mean,
            "terminated": terminated,
            "truncated": not terminated,
            "provenance_error": provenance_error,
            "generated_tokens": len(z_tokens),
            "sampler_revision": revision,
            "operation": turn_target.get("operation"),
            "is_tool_call": bool(turn_target.get("is_tool_call")),
            "turn_index": turn_target.get("turn_index", 0),
            "token_categories": {
                "reasoning": len(z_tokens), "trace": 0, "protocol": 0, "other": 0, "unclassified": 0,
            },
        }

    def token_accounting(self, tokens: Sequence[int]) -> dict[str, int]:
        """Partition original TML tokens, conservatively retaining unknown boundaries.

        No re-tokenized length is ever substituted for actual generated tokens.
        A token crossing prose/action boundaries is 'other'. Unicode segments
        whose individual decoding is not additive remain unclassified.
        """
        counts = {name: 0 for name in ("reasoning", "trace", "protocol", "other", "unclassified")}
        tokenizer = self._sdk().tokenizer
        if tokenizer is None or not hasattr(tokenizer, "decode"):
            counts["unclassified"] = len(tokens)
            return counts
        try:
            pieces = []
            for token in tokens:
                if token not in self._token_pieces:
                    if len(self._token_pieces) >= 65536:
                        self._token_pieces.clear()
                    self._token_pieces[token] = tokenizer.decode([token])
                pieces.append(self._token_pieces[token])
            mode = "unclassified"
            text_tokens: list[int] = []
            text_pieces: list[str] = []

            def flush_text():
                if not text_tokens:
                    return
                text = tokenizer.decode(text_tokens)
                if "".join(text_pieces) != text:
                    counts["unclassified"] += len(text_tokens)
                else:
                    spans = []
                    import json
                    for match in re.finditer(r"```(?:json)?\s*\n?([\s\S]*?)```", text):
                        try:
                            value = json.loads(match.group(1))
                            if isinstance(value, dict) and value.get("type") in {"call", "complete"}:
                                spans.append((match.start(), match.end()))
                        except ValueError:
                            pass
                    if not spans:
                        try:
                            value = json.loads(text)
                            if isinstance(value, dict) and value.get("type") in {"call", "complete"}:
                                spans = [(0, len(text))]
                        except ValueError:
                            pass
                    offset = 0
                    for piece in text_pieces:
                        end = offset + len(piece)
                        inside = any(offset >= a and end <= b for a, b in spans)
                        overlap = any(offset < b and end > a for a, b in spans)
                        counts["protocol" if inside else "other" if overlap else "trace"] += 1
                        offset = end
                text_tokens.clear()
                text_pieces.clear()

            for token, piece in zip(tokens, pieces):
                if piece in {"<|message_model|>", "<|end_message|>", "<|content_model_end_sampling|>"}:
                    flush_text()
                    counts["protocol"] += 1
                    mode = "header" if piece == "<|message_model|>" else "unclassified"
                elif piece in {"<|content_thinking|>", "<|content_text|>", "<|content_invoke_tool_json|>"}:
                    flush_text()
                    counts["protocol"] += 1
                    mode = ("reasoning" if piece == "<|content_thinking|>"
                            else "text" if piece == "<|content_text|>"
                            else "protocol")
                elif mode == "header":
                    # Tool recipient name between <|message_model|> and <|content_invoke_tool_json|>.
                    counts["protocol"] += 1
                elif mode == "text":
                    text_tokens.append(token)
                    text_pieces.append(piece)
                else:
                    counts[mode] += 1
            flush_text()
            if sum(counts.values()) != len(tokens):
                raise ValueError("Token partition does not sum to the sampled length")
            return counts
        except Exception:
            return {name: len(tokens) if name == "unclassified" else 0 for name in counts}

    def _messages(self, messages: Sequence[Mapping[str, Any]], *, training: bool = False) -> list[dict]:
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
                # At effort == 0.0, Inkling disables thinking; flatten structured
                # thinking+text parts so SFT never conflicts with effort=0.
                if self.effort == 0.0 and item["role"] == "assistant" and isinstance(item.get("content"), list):
                    parts = []
                    for part in item["content"]:
                        if isinstance(part, Mapping) and part.get("type") == "thinking" and part.get("thinking"):
                            parts.append(part["thinking"])
                        elif isinstance(part, Mapping) and part.get("type") == "text" and part.get("text"):
                            parts.append(part["text"])
                    item["content"] = "\n".join(parts)
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
            datums.append(sdk.datum_builder(model_input, weights,
                                           reduction="mean" if self.sft_weighting == "example" else "none"))
        return datums

    def _sft_layout(self, datum, metadata: Mapping[str, Any], execution_index: int,
                    execution_tokens: int) -> dict:
        """Map actual shifted target IDs to TML message-level action categories."""
        weights = [_finite(value, "supervised prediction weight")
                   for value in _tensor_values(datum.loss_fn_inputs["weights"])]
        targets = _tensor_values(datum.loss_fn_inputs["target_tokens"])
        if (len(weights) != len(targets) or any(weight < 0 for weight in weights)
                or not math.isfinite(sum(weights))):
            raise ValueError("Supervised diagnostic weights must align with the original target IDs")
        actions, roles = ["unknown"] * len(targets), ["unknown"] * len(targets)
        available = False
        tokenizer = self._sdk().tokenizer
        if tokenizer is not None and hasattr(tokenizer, "decode"):
            try:
                inputs = datum.model_input.to_ints()
                if len(inputs) != len(targets) or inputs[1:] != targets[:-1] or not targets:
                    raise ValueError("Supervised input/target shift is not intact")
                tokens = inputs + [targets[-1]]
                pieces = [tokenizer.decode([token]) for token in tokens]
                starts = [(index, piece[len("<|message_"):-2]) for index, piece in enumerate(pieces)
                          if re.fullmatch(r"<\|message_[a-z_]+\|>", piece)]
                full_actions, full_roles = ["unknown"] * len(tokens), ["unknown"] * len(tokens)
                available = any(role == "model" for _, role in starts)
                # Inkling encodes one assistant turn with thinking as consecutive
                # <|message_model|> frames (<|content_thinking|> then <|content_text|>)
                # ending at <|content_model_end_sampling|>. Group them into one turn so
                # thinking tokens inherit their turn's action classification.
                ordinal = 0
                while ordinal < len(starts):
                    start, role = starts[ordinal]
                    end = starts[ordinal + 1][0] if ordinal + 1 < len(starts) else len(tokens)
                    if role != "model":
                        full_roles[start:end] = [role] * (end - start)
                        ordinal += 1
                        continue
                    turn_end_ordinal = ordinal
                    while (turn_end_ordinal + 1 < len(starts)
                           and starts[turn_end_ordinal + 1][1] == "model"
                           and "<|content_model_end_sampling|>" not in pieces[starts[turn_end_ordinal][0]:starts[turn_end_ordinal + 1][0]]):
                        turn_end_ordinal += 1
                    turn_end = starts[turn_end_ordinal + 1][0] if turn_end_ordinal + 1 < len(starts) else len(tokens)
                    full_roles[start:turn_end] = ["model"] * (turn_end - start)
                    text_parts, text_ids = [], []
                    in_text = False
                    has_tool_invoke = False
                    def flush():
                        if text_ids:
                            text_parts.append(tokenizer.decode(text_ids))
                            text_ids.clear()
                    for token, piece in zip(tokens[start + 1:turn_end], pieces[start + 1:turn_end]):
                        if re.fullmatch(r"<\|[^|]+\|>", piece):
                            flush()
                            if piece == "<|content_invoke_tool_json|>":
                                has_tool_invoke = True
                            in_text = piece == "<|content_text|>"
                        elif in_text:
                            text_ids.append(token)
                    flush()
                    kind = "call_request" if has_tool_invoke else _supervised_action_kind("".join(text_parts))
                    full_actions[start:turn_end] = [kind] * (turn_end - start)
                    ordinal = turn_end_ordinal + 1
                actions, roles = full_actions[1:], full_roles[1:]
            except (AttributeError, KeyError, TypeError, ValueError, UnicodeError):
                available = False
                actions, roles = ["unknown"] * len(targets), ["unknown"] * len(targets)
        if any(weight > 0 and role not in {"model", "unknown"} for weight, role in zip(weights, roles)):
            raise ValueError("Renderer assigned prediction weight to a non-assistant TML message; no update was sent")
        tier = metadata.get("tier")
        tier = str(tier) if isinstance(tier, int) and not isinstance(tier, bool) and tier > 0 else "unknown"
        features = metadata.get("features", [])
        features = sorted({feature for feature in features if isinstance(feature, str) and feature}) if isinstance(features, list) else []
        return {"weights": weights, "actions": actions, "roles": roles,
                "boundaries_available": available, "execution_index": execution_index,
                "length_band": "long" if execution_tokens >= self.sft_diagnostic_long_tokens else "short",
                "tier": tier, "features": features}

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
        with self._lock:
            prompt, prompt_tokens, budget = self._generation_prompt(messages, max_tokens)
            if self.sampling_client is None:
                self.create_sampling_client()
            client = self.sampling_client
            revision = self.sampling_revision
            params = {"max_tokens": budget, "temperature": self.temperature, "stop": sdk.renderer.get_stop_sequences()}
            if seed is not None:
                params["seed"] = _seed(seed)
            sampling_params = sdk.types.SamplingParams(**params)
        # Network sampling runs unlocked so concurrent rollout threads pipeline I/O.
        response = self._wait(
            client.sample(prompt=prompt, num_samples=1, sampling_params=sampling_params),
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
        with self._lock:
            if len(sequences) == 1:
                try:
                    parsed, termination = sdk.renderer.parse_response(tokens)
                    message = _json_value(parsed)
                    termination_name = str(getattr(termination, "value", termination))
                    clean = bool(getattr(termination, "is_clean", termination_name in {"stop_sequence", "eos"}))
                except Exception as exc:
                    parse_error = f"Renderer parsing failed ({type(exc).__name__})"
            accounting = self.token_accounting(tokens)
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
            "sampler_revision": revision,
            "token_accounting": accounting,
        }
        if provenance_errors:
            record["provenance_error"] = "; ".join(provenance_errors)
        if parse_error:
            record["parse_error"] = parse_error
        return record

    def _update(self, datums: list, loss_fn: str, learning_rate: float | None,
                loss_fn_config: Mapping[str, float | str] | None = None,
                diagnostic_samples: Sequence[Mapping[str, Any]] | None = None,
                sft_layouts: list[dict] | None = None) -> dict:
        if not datums:
            raise ValueError("Cannot update with an empty training batch")
        rate = self.learning_rate if learning_rate is None else _finite(learning_rate, "learning_rate")
        if rate <= 0:
            raise ValueError("learning_rate must be positive")
        if self.training_client is None:
            self.create_training_client()
        # Submit in order before waiting, as required by SDK pipelining. SDK
        # futures handle retry/idempotency; never resubmit a timed-out update.
        options = {"loss_fn_config": dict(loss_fn_config)} if loss_fn_config else {}
        forward = self.training_client.forward_backward(datums, loss_fn=loss_fn, **options)
        optimizer = self.training_client.optim_step(self._sdk().types.AdamParams(learning_rate=rate))
        forward_result = self._wait(forward, "forward/backward")
        self._wait(optimizer, "optimizer step")
        self.training_steps += 1
        metrics = _json_value(forward_result.metrics)
        if diagnostic_samples:
            try:
                outputs = forward_result.loss_fn_outputs
                if len(outputs) != len(diagnostic_samples):
                    raise ValueError("Learner output count differs from sampled turns")
                sampling, learner = [], []
                for output, sample in zip(outputs, diagnostic_samples):
                    values = _tensor_values(output["logprobs"])
                    prefix = len(sample["prompt_tokens"]) - 1
                    extra_tokens = sample.get("target_tokens") if abs(sample.get("target_advantage", 0.0)) > 1e-12 else None
                    sample_len = len(sample["token_ids"]) + (len(extra_tokens) if extra_tokens else 0)
                    if len(values) != prefix + sample_len:
                        raise ValueError("Learner log probabilities are misaligned")
                    sampling.extend(sample["logprobs"])
                    if extra_tokens:
                        sampling.extend(sample["target_logprobs"])
                    learner.extend(values[prefix:])
                metrics.update(_log_ratio_metrics(sampling, learner, "sampler_learner"))
                metrics["sampled_surprisal_mean"] = -statistics.fmean(sampling)
                metrics["learner_diagnostics_available"] = True
            except (AttributeError, KeyError, TypeError, ValueError):
                # The optimizer has already committed. Report unavailable diagnostics
                # without converting a completed update into a retryable failure.
                metrics["learner_diagnostics_available"] = False
        if sft_layouts is not None:
            try:
                metrics["sft_diagnostics"] = _sft_forward_diagnostics(
                    sft_layouts, getattr(forward_result, "loss_fn_outputs", None), self.sft_diagnostic_long_tokens)
            except Exception as error:
                # Diagnostics must not turn a committed optimizer update into a
                # retryable failure, including for unexpected future SDK output.
                metrics["sft_diagnostics"] = {"loss_available": False,
                    "source": "metadata only; diagnostic aggregation failed after completed optimizer step",
                    "unavailable_reason": type(error).__name__, "datums": len(sft_layouts)}
        return {"step": self.training_steps, "examples": len(datums), "loss_fn": loss_fn,
                "loss_fn_config": dict(loss_fn_config or {}), "learning_rate": rate,
                "training_identity": self.training_identity, "metrics": metrics}

    def sft_train(self, examples: Sequence[Mapping[str, Any]], learning_rate: float | None = None) -> dict:
        datums, layouts = [], []
        for index, example in enumerate(examples):
            rendered = self.render_sft(example["messages"])
            execution_tokens = sum(sum(weight > 0 for weight in _tensor_values(datum.loss_fn_inputs["weights"]))
                                   for datum in rendered)
            metadata = example.get("metadata", {})
            metadata = metadata if isinstance(metadata, Mapping) else {}
            layouts.extend(self._sft_layout(datum, metadata, index, execution_tokens) for datum in rendered)
            datums.extend(rendered)
        return self._update(datums, "cross_entropy", learning_rate, sft_layouts=layouts)

    def score_supervision(self, examples: Sequence[Mapping[str, Any]]) -> dict:
        """Forward-only live learnability diagnostic with exactly the SFT target mask."""
        datums = [datum for example in examples for datum in self.render_sft(example["messages"])]
        if not datums:
            raise ValueError("Cannot score empty supervision")
        if self.training_client is None:
            self.create_training_client()
        result = self._wait(self.training_client.forward(datums, loss_fn="cross_entropy"),
                            "supervision forward scoring")
        if len(result.loss_fn_outputs) != len(datums):
            raise AdapterError("Supervision scoring returned a different number of examples")
        scores, count = [], 0
        for datum, output in zip(datums, result.loss_fn_outputs):
            weights = _tensor_values(datum.loss_fn_inputs["weights"])
            logprobs = _tensor_values(output["logprobs"])
            if len(weights) != len(logprobs):
                raise AdapterError("Supervision scoring returned misaligned log probabilities")
            total = sum(weights)
            if total <= 0:
                raise AdapterError("Supervision scoring has no weighted targets")
            scores.append(sum(_finite(lp, "learner logprob") * w for lp, w in zip(logprobs, weights)) / total)
            count += sum(w > 0 for w in weights)
        return {"mean_example_target_logprob": statistics.fmean(scores), "per_example": scores,
                "examples": len(scores), "trainable_tokens": count, "model_compute": True}

    def rl_train(self, trajectories: Sequence[Mapping[str, Any]], learning_rate: float | None = None,
                 loss_fn: str = "importance_sampling",
                 loss_fn_config: Mapping[str, float | str] | None = None) -> dict:
        if loss_fn not in {"importance_sampling", "ppo", "cispo"}:
            raise ValueError("RL loss_fn must be importance_sampling, ppo, or cispo")
        loss_fn_config = dict(loss_fn_config or {})
        allowed = {"clip_low_threshold", "clip_high_threshold"} if loss_fn == "ppo" else set()
        if set(loss_fn_config) - allowed:
            raise ValueError("Unsupported loss configuration for the selected RL loss")
        for key, value in loss_fn_config.items():
            value = _finite(value, key)
            if (key == "clip_low_threshold" and not 0 < value <= 1
                    or key == "clip_high_threshold" and value < 1):
                raise ValueError("PPO thresholds must bracket an importance ratio of one")
            loss_fn_config[key] = value
        if self.reference_kl_coef and self.reference_client is None:
            raise AdapterError("Set a fixed SFT reference checkpoint before using reference KL")
        sdk = self._sdk()
        datums, samples, reference_values, sampling_values = [], [], [], []
        shaping_clipped = 0
        traj_lengths = [sum(len(s.get("token_ids", [])) for s in trajectory["samples"]) for trajectory in trajectories]
        mean_traj_len = statistics.fmean(traj_lengths) if traj_lengths else 1.0
        for trajectory, traj_len in zip(trajectories, traj_lengths):
            advantage = _finite(trajectory["advantage"], "advantage")
            if self.rl_token_normalization == "trajectory" and traj_len > 0:
                advantage = advantage * (mean_traj_len / traj_len)
            for sample in trajectory["samples"]:
                arrays = rl_token_arrays(sample, advantage)
                self._budget(len(arrays["input_tokens"]) + 1)
                if self.reference_kl_coef:
                    reference = self.score_sample(sample, sampler=self.reference_client)
                    prefix = len(sample["prompt_tokens"]) - 1
                    for offset, (old, ref) in enumerate(zip(sample["logprobs"], reference)):
                        ratio = old - ref
                        bounded = max(-self.reference_kl_clip, min(self.reference_kl_clip, ratio))
                        shaping_clipped += ratio != bounded
                        arrays["advantages"][prefix + offset] -= self.reference_kl_coef * bounded
                    reference_values.extend(reference)
                    sampling_values.extend(sample["logprobs"])
                samples.append(sample)
                datums.append(sdk.types.Datum(
                    model_input=sdk.types.ModelInput.from_ints(arrays.pop("input_tokens")),
                    loss_fn_inputs=arrays,
                ))
        result = self._update(datums, loss_fn, learning_rate, loss_fn_config, samples)
        if reference_values:
            result["metrics"].update(_log_ratio_metrics(sampling_values, reference_values, "sft_reference"))
            result["metrics"].update({"reference_kl_coef": self.reference_kl_coef,
                "reference_kl_shaping_clipped_tokens": shaping_clipped,
                "reference_checkpoint": self.reference_checkpoint,
                "reference_scoring_requests": len(samples)})
        return result

    def checkpoint(self, name: str, *, ttl_seconds: int | None = None) -> dict:
        if self.training_client is None:
            raise AdapterError("Create a training client before saving a checkpoint")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("checkpoint name must be nonempty")
        import inspect
        save_kwargs = {}
        if ttl_seconds is not None:
            ttl = _positive_int(ttl_seconds, "ttl_seconds")
            if "ttl_seconds" in inspect.signature(self.training_client.save_state).parameters:
                save_kwargs["ttl_seconds"] = ttl
        sampler_kwargs = {}
        if ttl_seconds is not None and "ttl_seconds" in inspect.signature(self.training_client.save_weights_for_sampler).parameters:
            sampler_kwargs["ttl_seconds"] = ttl
        training = self._retry_idempotent(
            lambda: self.training_client.save_state(name=name, **save_kwargs), "training checkpoint save"
        )
        sampler = self._retry_idempotent(
            lambda: self.training_client.save_weights_for_sampler(name=name, **sampler_kwargs), "sampler checkpoint save"
        )
        return {"training_path": training.path, "sampler_path": sampler.path, "step": self.training_steps}
