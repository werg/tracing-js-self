"""Native Python execution, sys.settrace compact tracing, and grading for Tinker."""

from .codec import (
    MAX_DEPTH,
    MAX_NODES,
    decode_readable,
    describe_graph,
    encode_exception,
    encode_readable,
    realize_graph,
)
from .execution import (
    PY_HOST_METHODS,
    PY_HOST_OPERATIONS,
    TINKER_PY_EXECUTION_SCHEMA,
    TINKER_REASONING_CHANNELS,
    TINKER_TRACE_FORMATS,
    audit_python_conversation,
    audit_python_supervision,
    create_python_session,
    export_python_example,
    initial_messages,
    normalized_py_source_hash,
    parse_student_action,
    prepare_python_task,
    readable_messages_from_python,
)
from .tracer import (
    CompactPythonTracer,
    TraceLimitError,
    create_python_tracer,
)

__all__ = [
    "CompactPythonTracer",
    "MAX_DEPTH",
    "MAX_NODES",
    "PY_HOST_METHODS",
    "PY_HOST_OPERATIONS",
    "TINKER_PY_EXECUTION_SCHEMA",
    "TINKER_REASONING_CHANNELS",
    "TINKER_TRACE_FORMATS",
    "TraceLimitError",
    "audit_python_conversation",
    "audit_python_supervision",
    "create_python_session",
    "create_python_tracer",
    "decode_readable",
    "describe_graph",
    "encode_exception",
    "encode_readable",
    "export_python_example",
    "initial_messages",
    "normalized_py_source_hash",
    "parse_student_action",
    "prepare_python_task",
    "readable_messages_from_python",
    "realize_graph",
]
