#!/usr/bin/env python3
"""Isolated Python reference execution process.

Reads a JSON task request from stdin, executes guest Python code in this
isolated process with intercepted external operations and optional sys.settrace
compact causal tracing, and writes one JSON response to stdout.
"""

from __future__ import annotations

import asyncio
import builtins
import inspect
import io
import json
import os
from pathlib import Path
import pathlib
import random
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any

# Save unpatched stdlib callables BEFORE install_replay_io_hooks modifies any of them.
_ORIG_OS_MKDIR = os.mkdir
_ORIG_OS_MAKEDIRS = os.makedirs
_ORIG_OS_REMOVE = os.remove
_ORIG_OS_UNLINK = os.unlink
_ORIG_OS_RMDIR = os.rmdir
_ORIG_OS_RENAME = os.rename
_ORIG_OS_REPLACE = os.replace
_ORIG_PATH_MKDIR = pathlib.Path.mkdir
_ORIG_PATH_UNLINK = pathlib.Path.unlink
_ORIG_PATH_RENAME = pathlib.Path.rename
_ORIG_PATH_REPLACE = pathlib.Path.replace
_ORIG_SHUTIL_COPY = shutil.copy
_ORIG_SHUTIL_COPY2 = shutil.copy2
_ORIG_SHUTIL_COPYFILE = shutil.copyfile
_ORIG_SHUTIL_MOVE = shutil.move
_ORIG_SHUTIL_RMTREE = shutil.rmtree
_ORIG_TEMPFILE_GETTEMPDIR = tempfile.gettempdir
_ORIG_TEMPFILE_MKDTEMP = tempfile.mkdtemp
_ORIG_TEMPFILE_TEMPDIR = tempfile.TemporaryDirectory
_ORIG_TEMPFILE_NAMED = tempfile.NamedTemporaryFile
_ORIG_SUBPROCESS_POPEN = subprocess.Popen

# Ensure training/ package root is importable regardless of PYTHONPATH.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_TRAINING_DIR = str(_REPO_ROOT / "training")
if _TRAINING_DIR not in sys.path:
    sys.path.insert(0, _TRAINING_DIR)

from tinker_py.codebase import (  # noqa: E402
    CODE_LOAD_OPERATION,
    MultiFilePythonTracer,
    load_virtual_entry_module,
    normalize_codebase_files,
    serve_code_load,
)
from tinker_py.codec import (  # noqa: E402
    decode_readable,
    describe_graph,
    encode_exception,
    encode_readable,
)
from tinker_py.http_tools import install_replay_http_hooks  # noqa: E402
from tinker_py.io_tools import (  # noqa: E402
    build_io_exception,
    build_subprocess_exception,
    install_replay_io_hooks,
    is_guest_caller,
)
from tinker_py.tracer import TraceLimitError, create_python_tracer  # noqa: E402

PY_HOST_METHODS: dict[str, str] = {
    "fs_read_text": "fs.readText",
    "fs_write_text": "fs.writeText",
    "http_get": "http.get",
    "http_request": "http.request",
    "kv_get": "kv_get",
    "kv_set": "kv_set",
}


class _BrokerError(BaseException):
    """Infrastructure/fixture error that guest `except Exception:` cannot swallow."""

    def __init__(self, message: str, category: str = "reference_process_failure") -> None:
        super().__init__(message)
        self.category = category


class _TimeoutError(BaseException):
    """Wall-clock timeout error."""


class _HostProxy:
    def __init__(self, invoke_fn: Any, extra_methods: dict[str, str]) -> None:
        self._invoke = invoke_fn
        self._methods = dict(PY_HOST_METHODS)
        self._methods.update(extra_methods)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._methods:
            op = self._methods[name]
            return lambda *args: self._invoke(op, list(args))
        raise AttributeError(f"host has no method {name!r}")


def _build_guest_exception(value: Any) -> Exception:
    if isinstance(value, dict) and isinstance(value.get("name"), str):
        exc_cls = getattr(builtins, value["name"], None)
        if isinstance(exc_cls, type) and issubclass(exc_cls, Exception):
            return exc_cls(str(value.get("message", "")))
        return RuntimeError(f"{value['name']}: {value.get('message', '')}")
    return RuntimeError(str(value))


def _apply_resource_limits(timeout_ms: int) -> None:
    cpu_seconds = max(2, int((timeout_ms + 999) // 1000) + 2)
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
        new_soft = min(cpu_seconds, hard) if hard != resource.RLIM_INFINITY else cpu_seconds
        resource.setrlimit(resource.RLIMIT_CPU, (new_soft, hard))
    except (OSError, ValueError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (OSError, ValueError):
        pass
    if hasattr(signal, "SIGALRM"):
        def _on_alarm(_signum: int, _frame: Any) -> None:
            raise _TimeoutError(f"Python reference execution exceeded {timeout_ms}ms")

        signal.signal(signal.SIGALRM, _on_alarm)
        signal.setitimer(signal.ITIMER_REAL, max(0.1, timeout_ms / 1000.0))


def _cancel_alarm() -> None:
    if hasattr(signal, "SIGALRM"):
        signal.setitimer(signal.ITIMER_REAL, 0.0)


def _json_dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def _norm_path(path: Any) -> str:
    if isinstance(path, int):
        raise PermissionError("Raw file descriptors are not supported in guest code")
    return os.fsdecode(os.fspath(path))


def _norm_subprocess_args(args: Any) -> str | list[str]:
    if isinstance(args, (str, bytes, os.PathLike)):
        return os.fsdecode(os.fspath(args))
    if isinstance(args, (list, tuple)):
        return [
            os.fsdecode(os.fspath(item)) if isinstance(item, (str, bytes, os.PathLike)) else str(item)
            for item in args
        ]
    return str(args)


def _coerce_stream(
    raw: Any,
    *,
    captured: bool,
    text_mode: bool,
    encoding: str | None,
    errors: str | None,
) -> str | bytes | None:
    if not captured:
        return None
    if raw is None:
        raw = "" if text_mode else b""
    if text_mode:
        if isinstance(raw, bytes):
            return raw.decode(encoding or "utf-8", errors=errors or "replace")
        return str(raw)
    if isinstance(raw, str):
        return raw.encode(encoding or "utf-8", errors=errors or "surrogateescape")
    return bytes(raw)


def _install_expanded_io_hooks(invoke: Any, io_depth: list[int]) -> Any:
    """Install expanded virtual FS, shutil, tempfile, and subprocess.Popen replay hooks."""
    temp_counter = [0]
    popen_counter = [0]
    pending_temp_files: list[Any] = []

    def _next_temp_path(
        suffix: str | None = None,
        prefix: str | None = None,
        dir: Any = None,  # noqa: A002
    ) -> str:
        base = _norm_path(dir) if dir is not None else "/tmp"
        pfx = "tmp" if prefix is None else str(prefix)
        sfx = "" if suffix is None else str(suffix)
        temp_counter[0] += 1
        name = f"{pfx}_{temp_counter[0]:04d}{sfx}"
        return f"{base.rstrip('/')}/{name}" if base != "/" else f"/{name}"

    # -------------------- os.* FS hooks --------------------
    def _os_mkdir(path: Any, mode: int = 0o777, *, dir_fd: Any = None) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_MKDIR(path, mode, dir_fd=dir_fd)
        invoke("fs.mkdir", [_norm_path(path)], build_io_exception)

    def _os_makedirs(name: Any, mode: int = 0o777, exist_ok: bool = False) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_MAKEDIRS(name, mode, exist_ok=exist_ok)
        try:
            invoke("fs.mkdir", [_norm_path(name)], build_io_exception)
        except FileExistsError:
            if not exist_ok:
                raise

    def _os_remove(path: Any, *, dir_fd: Any = None) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_REMOVE(path, dir_fd=dir_fd)
        invoke("fs.unlink", [_norm_path(path)], build_io_exception)

    def _os_unlink(path: Any, *, dir_fd: Any = None) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_UNLINK(path, dir_fd=dir_fd)
        invoke("fs.unlink", [_norm_path(path)], build_io_exception)

    def _os_rmdir(path: Any, *, dir_fd: Any = None) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_RMDIR(path, dir_fd=dir_fd)
        invoke("fs.unlink", [_norm_path(path)], build_io_exception)

    def _os_rename(src: Any, dst: Any, *, src_dir_fd: Any = None, dst_dir_fd: Any = None) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_RENAME(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        invoke("fs.rename", [_norm_path(src), _norm_path(dst)], build_io_exception)

    def _os_replace(src: Any, dst: Any, *, src_dir_fd: Any = None, dst_dir_fd: Any = None) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_OS_REPLACE(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        invoke("fs.rename", [_norm_path(src), _norm_path(dst)], build_io_exception)

    os.mkdir = _os_mkdir  # type: ignore[assignment]
    os.makedirs = _os_makedirs  # type: ignore[assignment]
    os.remove = _os_remove  # type: ignore[assignment]
    os.unlink = _os_unlink  # type: ignore[assignment]
    os.rmdir = _os_rmdir  # type: ignore[assignment]
    os.rename = _os_rename  # type: ignore[assignment]
    os.replace = _os_replace  # type: ignore[assignment]

    # -------------------- pathlib.Path hooks --------------------
    def _path_mkdir(self: pathlib.Path, mode: int = 0o777, parents: bool = False, exist_ok: bool = False) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_PATH_MKDIR(self, mode=mode, parents=parents, exist_ok=exist_ok)
        try:
            invoke("fs.mkdir", [str(self)], build_io_exception)
        except FileExistsError:
            if not exist_ok:
                raise

    def _path_unlink(self: pathlib.Path, missing_ok: bool = False) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_PATH_UNLINK(self, missing_ok=missing_ok)
        try:
            invoke("fs.unlink", [str(self)], build_io_exception)
        except FileNotFoundError:
            if not missing_ok:
                raise

    def _path_rename(self: pathlib.Path, target: Any) -> pathlib.Path:
        if not is_guest_caller(io_depth):
            return _ORIG_PATH_RENAME(self, target)
        dst = _norm_path(target)
        invoke("fs.rename", [str(self), dst], build_io_exception)
        return pathlib.Path(dst)

    def _path_replace(self: pathlib.Path, target: Any) -> pathlib.Path:
        if not is_guest_caller(io_depth):
            return _ORIG_PATH_REPLACE(self, target)
        dst = _norm_path(target)
        invoke("fs.rename", [str(self), dst], build_io_exception)
        return pathlib.Path(dst)

    pathlib.Path.mkdir = _path_mkdir  # type: ignore[method-assign]
    pathlib.Path.unlink = _path_unlink  # type: ignore[method-assign]
    pathlib.Path.rename = _path_rename  # type: ignore[method-assign]
    pathlib.Path.replace = _path_replace  # type: ignore[method-assign]

    # -------------------- shutil hooks --------------------
    def _shutil_copyfile(src: Any, dst: Any, *, follow_symlinks: bool = True) -> Any:
        if not is_guest_caller(io_depth):
            return _ORIG_SHUTIL_COPYFILE(src, dst, follow_symlinks=follow_symlinks)
        src_p = _norm_path(src)
        dst_p = _norm_path(dst)
        raw = invoke("fs.readBytes", [src_p], build_io_exception)
        data = raw if isinstance(raw, bytes) else (raw.encode("utf-8") if isinstance(raw, str) else bytes(raw))
        invoke("fs.writeBytes", [dst_p, data], build_io_exception)
        return dst

    def _shutil_copy(src: Any, dst: Any, *, follow_symlinks: bool = True) -> Any:
        if not is_guest_caller(io_depth):
            return _ORIG_SHUTIL_COPY(src, dst, follow_symlinks=follow_symlinks)
        src_p = _norm_path(src)
        dst_p = _norm_path(dst)
        if dst_p.endswith("/"):
            dst_p = os.path.join(dst_p, os.path.basename(src_p))
        raw = invoke("fs.readBytes", [src_p], build_io_exception)
        data = raw if isinstance(raw, bytes) else (raw.encode("utf-8") if isinstance(raw, str) else bytes(raw))
        invoke("fs.writeBytes", [dst_p, data], build_io_exception)
        return dst_p

    def _shutil_copy2(src: Any, dst: Any, *, follow_symlinks: bool = True) -> Any:
        if not is_guest_caller(io_depth):
            return _ORIG_SHUTIL_COPY2(src, dst, follow_symlinks=follow_symlinks)
        src_p = _norm_path(src)
        dst_p = _norm_path(dst)
        if dst_p.endswith("/"):
            dst_p = os.path.join(dst_p, os.path.basename(src_p))
        raw = invoke("fs.readBytes", [src_p], build_io_exception)
        data = raw if isinstance(raw, bytes) else (raw.encode("utf-8") if isinstance(raw, str) else bytes(raw))
        invoke("fs.writeBytes", [dst_p, data], build_io_exception)
        return dst_p

    def _shutil_move(src: Any, dst: Any, copy_function: Any = _shutil_copy2) -> Any:
        if not is_guest_caller(io_depth):
            return _ORIG_SHUTIL_MOVE(src, dst, copy_function=copy_function)
        src_p = _norm_path(src)
        dst_p = _norm_path(dst)
        if dst_p.endswith("/"):
            dst_p = os.path.join(dst_p, os.path.basename(src_p))
        invoke("fs.rename", [src_p, dst_p], build_io_exception)
        return dst_p

    def _shutil_rmtree(
        path: Any,
        ignore_errors: bool = False,
        onerror: Any = None,
        *,
        onexc: Any = None,
        dir_fd: Any = None,
    ) -> None:
        if not is_guest_caller(io_depth):
            return _ORIG_SHUTIL_RMTREE(path, ignore_errors=ignore_errors, onerror=onerror, onexc=onexc, dir_fd=dir_fd)
        p = _norm_path(path)
        try:
            invoke("fs.unlink", [p], build_io_exception)
        except OSError as exc:
            if ignore_errors:
                return
            if callable(onexc):
                onexc(_shutil_rmtree, p, exc)
                return
            if callable(onerror):
                onerror(_shutil_rmtree, p, (type(exc), exc, exc.__traceback__))
                return
            raise

    shutil.copyfile = _shutil_copyfile  # type: ignore[assignment]
    shutil.copy = _shutil_copy  # type: ignore[assignment]
    shutil.copy2 = _shutil_copy2  # type: ignore[assignment]
    shutil.move = _shutil_move  # type: ignore[assignment]
    shutil.rmtree = _shutil_rmtree  # type: ignore[assignment]

    # -------------------- tempfile hooks --------------------
    def _tempfile_gettempdir() -> str:
        if not is_guest_caller(io_depth):
            return _ORIG_TEMPFILE_GETTEMPDIR()
        return "/tmp"

    def _tempfile_mkdtemp(
        suffix: str | None = None,
        prefix: str | None = None,
        dir: Any = None,  # noqa: A002
    ) -> str:
        if not is_guest_caller(io_depth):
            return _ORIG_TEMPFILE_MKDTEMP(suffix=suffix, prefix=prefix, dir=dir)
        path = _next_temp_path(suffix=suffix, prefix=prefix, dir=dir)
        invoke("fs.mkdir", [path], build_io_exception)
        return path

    class _VirtualTemporaryDirectory:
        def __init__(
            self,
            suffix: str | None = None,
            prefix: str | None = None,
            dir: Any = None,  # noqa: A002
            ignore_cleanup_errors: bool = False,
            *,
            delete: bool = True,
        ) -> None:
            self.name = _next_temp_path(suffix=suffix, prefix=prefix, dir=dir)
            self._ignore_cleanup_errors = bool(ignore_cleanup_errors)
            self._delete = bool(delete)
            self._cleaned = False
            invoke("fs.mkdir", [self.name], build_io_exception)

        def __enter__(self) -> str:
            return self.name

        def cleanup(self) -> None:
            if self._cleaned:
                return
            self._cleaned = True
            try:
                invoke("fs.unlink", [self.name], build_io_exception)
            except OSError:
                if not self._ignore_cleanup_errors:
                    raise

        def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
            if self._delete:
                self.cleanup()
            return False

        def __repr__(self) -> str:
            return f"<TemporaryDirectory {self.name!r}>"

    class _TempDirMeta(type):
        def __instancecheck__(cls, instance: Any) -> bool:
            return isinstance(instance, (_ORIG_TEMPFILE_TEMPDIR, _VirtualTemporaryDirectory))

    class _HookedTemporaryDirectory(metaclass=_TempDirMeta):
        def __new__(
            cls,
            suffix: str | None = None,
            prefix: str | None = None,
            dir: Any = None,  # noqa: A002
            ignore_cleanup_errors: bool = False,
            *,
            delete: bool = True,
        ) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_TEMPFILE_TEMPDIR(
                    suffix=suffix,
                    prefix=prefix,
                    dir=dir,
                    ignore_cleanup_errors=ignore_cleanup_errors,
                    delete=delete,
                )
            return _VirtualTemporaryDirectory(
                suffix=suffix,
                prefix=prefix,
                dir=dir,
                ignore_cleanup_errors=ignore_cleanup_errors,
                delete=delete,
            )

    class _VirtualNamedTemporaryFile:
        def __init__(
            self,
            *,
            path_str: str,
            mode: str,
            encoding: str | None,
            newline: str | None,
            delete: bool,
            delete_on_close: bool,
        ) -> None:
            self.name = path_str
            self.mode = mode
            self.delete = bool(delete)
            self.delete_on_close = bool(delete_on_close)
            self._is_binary = "b" in mode
            self.encoding = None if self._is_binary else (encoding or "utf-8")
            self._stream: io.BytesIO | io.StringIO = (
                io.BytesIO()
                if self._is_binary
                else io.StringIO("", newline="" if newline is None else newline)
            )
            self._dirty = False
            self._ever_committed = False
            self._unlinked = False
            self._closed = False

        def _commit_if_needed(self, force: bool = False) -> None:
            if not self._dirty and (self._ever_committed or not force):
                return
            payload = self._stream.getvalue()
            op = "fs.writeBytes" if self._is_binary else "fs.writeText"
            invoke(op, [self.name, payload], build_io_exception)
            self._dirty = False
            self._ever_committed = True

        def _unlink_if_needed(self) -> None:
            if self.delete and not self._unlinked:
                self._unlinked = True
                invoke("fs.unlink", [self.name], build_io_exception)

        def write(self, data: str | bytes | bytearray | memoryview) -> int:
            if self._closed:
                raise ValueError("I/O operation on closed file.")
            self._dirty = True
            if self._is_binary:
                raw = bytes(data) if isinstance(data, (bytes, bytearray, memoryview)) else data.encode("utf-8")  # type: ignore[union-attr]
                return self._stream.write(raw)  # type: ignore[arg-type]
            if not isinstance(data, str):
                raise TypeError(f"write() argument must be str, not {type(data).__name__}")
            return self._stream.write(data)  # type: ignore[arg-type]

        def writelines(self, lines: Any) -> None:
            for line in lines:
                self.write(line)

        def read(self, size: int | None = -1) -> str | bytes:
            return self._stream.read(size)

        def readline(self, size: int = -1) -> str | bytes:
            return self._stream.readline(size)

        def readlines(self, hint: int = -1) -> list[str] | list[bytes]:
            return self._stream.readlines(hint)

        def seek(self, offset: int, whence: int = 0) -> int:
            return self._stream.seek(offset, whence)

        def tell(self) -> int:
            return self._stream.tell()

        def flush(self) -> None:
            if self._closed:
                raise ValueError("I/O operation on closed file.")
            self._commit_if_needed(force=True)

        def readable(self) -> bool:
            return "+" in self.mode or "r" in self.mode

        def writable(self) -> bool:
            return any(ch in self.mode for ch in ("w", "a", "x", "+"))

        def seekable(self) -> bool:
            return True

        @property
        def closed(self) -> bool:
            return self._closed

        def __iter__(self) -> Any:
            return iter(self._stream)

        def __next__(self) -> Any:
            return next(self._stream)

        def close(self) -> None:
            if self._closed:
                return
            try:
                self._commit_if_needed(force=True)
            finally:
                self._closed = True
                self._stream.close()
            if self.delete and self.delete_on_close:
                self._unlink_if_needed()

        def __enter__(self) -> "_VirtualNamedTemporaryFile":
            return self

        def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
            self.close()
            if self.delete and not self.delete_on_close:
                self._unlink_if_needed()
            return False

    def _tempfile_named(
        mode: str = "w+b",
        buffering: int = -1,
        encoding: str | None = None,
        newline: str | None = None,
        suffix: str | None = None,
        prefix: str | None = None,
        dir: Any = None,  # noqa: A002
        delete: bool = True,
        *,
        errors: str | None = None,
        delete_on_close: bool = True,
    ) -> Any:
        if not is_guest_caller(io_depth):
            return _ORIG_TEMPFILE_NAMED(
                mode=mode,
                buffering=buffering,
                encoding=encoding,
                newline=newline,
                suffix=suffix,
                prefix=prefix,
                dir=dir,
                delete=delete,
                errors=errors,
                delete_on_close=delete_on_close,
            )
        path = _next_temp_path(suffix=suffix, prefix=prefix, dir=dir)
        handle = _VirtualNamedTemporaryFile(
            path_str=path,
            mode=mode,
            encoding=encoding,
            newline=newline,
            delete=delete,
            delete_on_close=delete_on_close,
        )
        pending_temp_files.append(handle)
        return handle

    tempfile.gettempdir = _tempfile_gettempdir  # type: ignore[assignment]
    tempfile.mkdtemp = _tempfile_mkdtemp  # type: ignore[assignment]
    tempfile.TemporaryDirectory = _HookedTemporaryDirectory  # type: ignore[misc,assignment]
    tempfile.NamedTemporaryFile = _tempfile_named  # type: ignore[assignment]

    # -------------------- subprocess.Popen hook --------------------
    class _VirtualPopen:
        def __init__(
            self,
            args: Any,
            bufsize: int = -1,
            executable: Any = None,
            stdin: Any = None,
            stdout: Any = None,
            stderr: Any = None,
            preexec_fn: Any = None,
            close_fds: bool = True,
            shell: bool = False,
            cwd: Any = None,
            env: Any = None,
            universal_newlines: bool | None = None,
            startupinfo: Any = None,
            creationflags: int = 0,
            restore_signals: bool = True,
            start_new_session: bool = False,
            pass_fds: Any = (),
            *,
            encoding: str | None = None,
            errors: str | None = None,
            text: bool | None = None,
            **_extra: Any,
        ) -> None:
            del bufsize, executable, preexec_fn, close_fds, startupinfo, creationflags
            del restore_signals, start_new_session, pass_fds
            popen_counter[0] += 1
            self.args = args
            self.pid = 1000 + popen_counter[0]
            self.returncode: int | None = None
            self._shell = bool(shell)
            self._cwd = _norm_path(cwd) if cwd is not None else None
            self._env = {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else None
            self._stdin_cfg = stdin
            self._stdout_cfg = stdout
            self._stderr_cfg = stderr
            self._text_mode = bool(text or encoding or errors or universal_newlines)
            self._encoding = encoding
            self._errors = errors
            self._executed = False
            self._raw_stdout: str | bytes | None = None
            self._raw_stderr: str | bytes | None = None
            self._stdout_io: io.StringIO | io.BytesIO | None = None
            self._stderr_io: io.StringIO | io.BytesIO | None = None
            self.stdin: io.StringIO | io.BytesIO | None = (
                (io.StringIO() if self._text_mode else io.BytesIO())
                if stdin == subprocess.PIPE
                else None
            )

        def _ensure_executed(self, input_data: Any = None) -> None:
            if self._executed:
                return
            self._executed = True
            norm_args = _norm_subprocess_args(self.args)
            req_dict: dict[str, Any] = {"args": norm_args, "shell": self._shell}
            if self._cwd is not None:
                req_dict["cwd"] = self._cwd
            if self._env is not None:
                req_dict["env"] = self._env
            eff_input = input_data
            if eff_input is None and self.stdin is not None:
                written = self.stdin.getvalue()
                if written:
                    eff_input = written
            if eff_input is not None:
                req_dict["input"] = (
                    eff_input.decode(self._encoding or "utf-8", errors=self._errors or "replace")
                    if isinstance(eff_input, (bytes, bytearray))
                    else str(eff_input)
                )
            res = invoke(
                "shell.exec",
                [req_dict],
                lambda err_val: build_subprocess_exception(err_val, cmd=self.args),
            )
            if not isinstance(res, dict):
                raise RuntimeError(f"Expected dict result from shell.exec, got {type(res).__name__}")
            self.returncode = int(res.get("returncode", 0))
            capture_stdout = self._stdout_cfg == subprocess.PIPE
            merge_stderr = self._stderr_cfg == subprocess.STDOUT
            capture_stderr = self._stderr_cfg == subprocess.PIPE and not merge_stderr
            self._raw_stdout = _coerce_stream(
                res.get("stdout"),
                captured=capture_stdout,
                text_mode=self._text_mode,
                encoding=self._encoding,
                errors=self._errors,
            )
            self._raw_stderr = _coerce_stream(
                res.get("stderr"),
                captured=capture_stderr,
                text_mode=self._text_mode,
                encoding=self._encoding,
                errors=self._errors,
            )
            if capture_stdout:
                self._stdout_io = (
                    io.StringIO(str(self._raw_stdout))
                    if self._text_mode
                    else io.BytesIO(bytes(self._raw_stdout))  # type: ignore[arg-type]
                )
            if capture_stderr:
                self._stderr_io = (
                    io.StringIO(str(self._raw_stderr))
                    if self._text_mode
                    else io.BytesIO(bytes(self._raw_stderr))  # type: ignore[arg-type]
                )

        @property
        def stdout(self) -> io.StringIO | io.BytesIO | None:
            if self._stdout_cfg != subprocess.PIPE:
                return None
            self._ensure_executed()
            return self._stdout_io

        @property
        def stderr(self) -> io.StringIO | io.BytesIO | None:
            if self._stderr_cfg != subprocess.PIPE:
                return None
            self._ensure_executed()
            return self._stderr_io

        def communicate(self, input: Any = None, timeout: float | None = None) -> tuple[Any, Any]:  # noqa: A002
            del timeout
            self._ensure_executed(input_data=input)
            return self._raw_stdout, self._raw_stderr

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            self._ensure_executed()
            assert self.returncode is not None
            return self.returncode

        def poll(self) -> int | None:
            self._ensure_executed()
            return self.returncode

        def terminate(self) -> None:
            if self.returncode is None:
                self.returncode = -15
                self._executed = True

        def kill(self) -> None:
            if self.returncode is None:
                self.returncode = -9
                self._executed = True

        def __enter__(self) -> "_VirtualPopen":
            return self

        def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
            if not self._executed:
                self.wait()
            if self._stdout_io is not None:
                self._stdout_io.close()
            if self._stderr_io is not None:
                self._stderr_io.close()
            if self.stdin is not None:
                self.stdin.close()
            return False

    class _PopenMeta(type):
        def __instancecheck__(cls, instance: Any) -> bool:
            return isinstance(instance, (_ORIG_SUBPROCESS_POPEN, _VirtualPopen))

    class _HookedPopen(metaclass=_PopenMeta):
        def __new__(cls, *args: Any, **kwargs: Any) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_SUBPROCESS_POPEN(*args, **kwargs)
            return _VirtualPopen(*args, **kwargs)

    subprocess.Popen = _HookedPopen  # type: ignore[misc,assignment]

    def flush_expanded_io() -> None:
        for fh in list(pending_temp_files):
            if not fh.closed:
                fh.close()
        pending_temp_files.clear()

    return flush_expanded_io


def main() -> int:
    real_stdout = sys.stdout
    real_stderr = sys.stderr
    real_stdin = sys.stdin
    real_argv = list(sys.argv)
    phase = "input"
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        if not isinstance(req, dict):
            raise TypeError("Worker input must be a JSON object")

        cli_cfg = req.get("cli")
        if cli_cfg is not None and not isinstance(cli_cfg, dict):
            raise TypeError("Optional cli field must be a JSON object")
        is_cli_mode = cli_cfg is not None

        files_raw = req.get("files")
        is_multifile = isinstance(files_raw, dict) and len(files_raw) > 0
        norm_files: dict[str, str] = {}
        norm_entry_file: str = ""
        norm_initial_loaded: list[str] = []
        if is_multifile:
            entry_file_raw = req.get("entryFile")
            if not isinstance(entry_file_raw, str) or not entry_file_raw:
                raise TypeError("entryFile required for multi-file task")
            norm_files, norm_entry_file, norm_initial_loaded = normalize_codebase_files(
                files_raw,
                entry_file_raw,
                req.get("initialLoadedFiles"),
            )
            source = norm_files[norm_entry_file]
        else:
            source = req.get("source")
            if not isinstance(source, str) or not source:
                raise TypeError("Nonempty source required")

        raw_entry = req.get("entry")
        cli_run_main = is_cli_mode and (raw_entry is None or raw_entry == "" or raw_entry == "__main__")
        if cli_run_main:
            entry = "__main__"
        else:
            entry = raw_entry if raw_entry is not None else "run"
            if not isinstance(entry, str) or not entry.isidentifier():
                raise TypeError("Valid entry identifier required")

        timeout_ms = int(req.get("timeoutMs", 10000))
        max_steps = int(req.get("maxSteps", 100000))
        trace_enabled = bool(req.get("trace", False))
        random_mode = req.get("randomMode", "seeded")
        random_seed = req.get("randomSeed", 17)
        native_bindings = req.get("nativeBindings") or []
        fixture_raw = req.get("fixture") or {"calls": []}
        fixture_calls_raw = fixture_raw.get("calls") or []

        args = decode_readable(req.get("args", []))
        if not isinstance(args, list):
            raise TypeError("Entry arguments must be a list")

        # Decode expected fixture calls upfront.
        expected_calls: list[dict[str, Any]] = []
        for idx, call in enumerate(fixture_calls_raw):
            op = call.get("operation")
            if not isinstance(op, str) or not op:
                raise TypeError(f"Fixture call {idx} missing operation")
            call_args = decode_readable(call.get("arguments", []))
            if not isinstance(call_args, list):
                raise TypeError(f"Fixture call {idx} arguments must be a list")
            call_status = call.get("status", "fulfilled")
            if call_status not in ("fulfilled", "rejected"):
                raise TypeError(f"Fixture call {idx} invalid status")
            call_result = decode_readable(call.get("result"))
            expected_calls.append({
                "operation": op,
                "arguments": call_args,
                "argumentGraph": describe_graph(call_args),
                "status": call_status,
                "result": call_result,
            })

        effects: list[dict[str, Any]] = []
        call_index = 0
        effect_seq = 0
        infrastructure_failures: list[tuple[str, str]] = []

        tracer: Any = None

        def _emit_code_load(load_req: dict[str, Any]) -> None:
            nonlocal effect_seq
            if tracer is not None and trace_enabled:
                tracer.next_turn()
            load_result = serve_code_load(norm_files, [load_req])
            cid = effect_seq
            effect_seq += 1
            effects.append({
                "kind": "dispatch",
                "call": cid,
                "operation": CODE_LOAD_OPERATION,
                "arguments": describe_graph([load_req]),
            })
            effects.append({
                "kind": "settlement",
                "call": cid,
                "operation": CODE_LOAD_OPERATION,
                "status": "fulfilled",
                "result": describe_graph([load_result], allow_exceptions=True),
            })

        max_trace_events = max(50_000, min(max_steps * 5, 1_000_000))
        if is_multifile:
            tracer = MultiFilePythonTracer(
                norm_files,
                norm_entry_file,
                initial_loaded_files=norm_initial_loaded,
                on_code_load=_emit_code_load,
                entry_name=entry,
                record_trace=trace_enabled,
                max_events=max_trace_events,
            )
        elif trace_enabled:
            tracer = create_python_tracer(
                source,
                entry_name=entry,
                max_events=max_trace_events,
            )

        def invoke(
            operation: str,
            call_args: list[Any],
            exc_builder: Any = None,
        ) -> Any:
            nonlocal call_index, effect_seq
            if tracer is not None and trace_enabled:
                tracer.next_turn()
            try:
                actual_graph = describe_graph(call_args)
            except Exception as exc:
                infrastructure_failures.append(
                    ("reference_instrumentation_unsupported", f"Unrepresentable call arguments for {operation}: {exc}")
                )
                raise _BrokerError(str(exc), "reference_instrumentation_unsupported") from exc

            if call_index >= len(expected_calls):
                msg = f"Unexpected external call #{call_index + 1}: {operation}"
                infrastructure_failures.append(("reference_process_failure", msg))
                raise _BrokerError(msg)

            expected = expected_calls[call_index]
            if expected["operation"] != operation or expected["argumentGraph"] != actual_graph:
                msg = f"External call #{call_index + 1} mismatch: got {operation}, expected {expected['operation']}"
                infrastructure_failures.append(("reference_process_failure", msg))
                raise _BrokerError(msg)

            call_index += 1
            cid = effect_seq
            effect_seq += 1
            result_val = expected["result"]
            status = expected["status"]
            effects.append({
                "kind": "dispatch",
                "call": cid,
                "operation": operation,
                "arguments": actual_graph,
            })
            effects.append({
                "kind": "settlement",
                "call": cid,
                "operation": operation,
                "status": status,
                "result": describe_graph([result_val], allow_exceptions=True),
            })
            if status == "rejected":
                if callable(exc_builder):
                    raise exc_builder(result_val)
                raise _build_guest_exception(result_val)
            # Return a fresh copy via encode/decode so guest mutations of returned
            # containers cannot corrupt fixture expectations.
            return decode_readable(encode_readable(result_val, allow_exceptions=True))

        # Patch external platform interfaces before compiling/executing guest code.
        io_depth = [0]
        has_http_fixture = any(c["operation"] == "http.request" for c in expected_calls)
        all_sources_iter = tuple(norm_files.values()) if is_multifile else (source,)
        enable_urllib = has_http_fixture or any(("urllib" in s) or ("urlopen" in s) for s in all_sources_iter)
        enable_requests = has_http_fixture or any("requests" in s for s in all_sources_iter)
        if enable_urllib or enable_requests:
            install_replay_http_hooks(
                invoke,
                enable_urllib=enable_urllib,
                enable_requests=enable_requests,
            )

        real_time = time.time
        real_monotonic = time.monotonic
        real_random = random.random

        def _platform_print(*print_args: Any, **_kwargs: Any) -> None:
            invoke("platform.print", list(print_args))

        def _platform_time() -> Any:
            if not is_guest_caller(io_depth):
                return real_time()
            return invoke("platform.time", [])

        def _platform_monotonic() -> Any:
            if not is_guest_caller(io_depth):
                return real_monotonic()
            return invoke("platform.time", [])

        time.time = _platform_time  # type: ignore[assignment]
        time.monotonic = _platform_monotonic  # type: ignore[assignment]

        uses_tool_random = random_mode == "tool" or any(
            c["operation"] == "platform.random" for c in expected_calls
        )
        if uses_tool_random:
            def _platform_random() -> Any:
                if not is_guest_caller(io_depth):
                    return real_random()
                return invoke("platform.random", [])

            random.random = _platform_random  # type: ignore[assignment]
        else:
            if not isinstance(random_seed, int) or isinstance(random_seed, bool) or not (0 <= random_seed <= 0xFFFFFFFF):
                raise TypeError("randomSeed must be uint32")
            random.seed(random_seed)

        extra_host: dict[str, str] = {}
        for c in expected_calls:
            op = c["operation"]
            if op.startswith("demo."):
                extra_host[op[5:]] = op
        host_obj = _HostProxy(invoke, extra_host)

        guest_builtins = dict(vars(builtins))
        has_platform_print_fixture = any(c["operation"] == "platform.print" for c in expected_calls)
        if not is_cli_mode or has_platform_print_fixture:
            guest_builtins["print"] = _platform_print
        flush_io = install_replay_io_hooks(
            invoke,
            io_depth=io_depth,
            guest_builtins=guest_builtins,
        )
        flush_expanded_io = _install_expanded_io_hooks(invoke, io_depth)

        extra_guest_globals: dict[str, Any] = {"host": host_obj}
        for binding in native_bindings:
            bname = binding.get("name")
            if isinstance(bname, str) and bname.isidentifier():
                extra_guest_globals[bname] = (lambda _op: (lambda *a: invoke(_op, list(a))))(bname)

        phase = "compile"
        if not is_multifile:
            guest_globals: dict[str, Any] = {
                "__builtins__": guest_builtins,
                "__name__": "__main__" if cli_run_main else "__guest__",
                **extra_guest_globals,
            }
            code = compile(source, "<guest>", "exec")

        _apply_resource_limits(timeout_ms)
        phase = "execute"
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        sys.stdout = stdout_buf
        if is_cli_mode:
            cli_argv_raw = cli_cfg.get("argv")
            if isinstance(cli_argv_raw, list):
                sys.argv = [str(a) for a in cli_argv_raw]
            else:
                sys.argv = [norm_entry_file if is_multifile else "script.py"]
            sys.stdin = io.StringIO(str(cli_cfg.get("stdin", "")))
            sys.stderr = stderr_buf
        kind = "return"
        result_value: Any = None
        cli_exit_code = 0
        try:
            if cli_run_main:
                if tracer is not None:
                    sys.settrace(tracer.trace_dispatch)
                try:
                    if is_multifile:
                        load_virtual_entry_module(
                            norm_files,
                            norm_entry_file,
                            guest_builtins,
                            {**extra_guest_globals, "__name__": "__main__"},
                        )
                    else:
                        exec(code, guest_globals)
                    flush_io()
                    flush_expanded_io()
                except SystemExit as exc:
                    code_val = exc.code
                    if code_val is None:
                        cli_exit_code = 0
                    elif isinstance(code_val, int) and not isinstance(code_val, bool):
                        cli_exit_code = int(code_val)
                    else:
                        stderr_buf.write(str(code_val) + "\n")
                        cli_exit_code = 1
                    result_value = cli_exit_code
                    flush_io()
                    flush_expanded_io()
                except Exception as exc:
                    kind = "throw"
                    result_value = encode_exception(exc)
                    cli_exit_code = 1
                finally:
                    if tracer is not None:
                        sys.settrace(None)
            else:
                if is_multifile:
                    entry_mod, _finder = load_virtual_entry_module(
                        norm_files,
                        norm_entry_file,
                        guest_builtins,
                        extra_guest_globals,
                    )
                    entry_fn = getattr(entry_mod, entry, None)
                else:
                    exec(code, guest_globals)
                    entry_fn = guest_globals.get(entry)
                if not callable(entry_fn):
                    raise TypeError(f"Entry function {entry!r} is not defined or not callable")
                if tracer is not None:
                    sys.settrace(tracer.trace_dispatch)
                try:
                    if inspect.iscoroutinefunction(entry_fn):
                        result_value = asyncio.run(entry_fn(*args))
                    else:
                        raw_result = entry_fn(*args)
                        if inspect.isawaitable(raw_result):
                            result_value = asyncio.run(raw_result)
                        else:
                            result_value = raw_result
                    flush_io()
                    flush_expanded_io()
                except SystemExit as exc:
                    if not is_cli_mode:
                        raise
                    code_val = exc.code
                    if code_val is None:
                        cli_exit_code = 0
                    elif isinstance(code_val, int) and not isinstance(code_val, bool):
                        cli_exit_code = int(code_val)
                    else:
                        stderr_buf.write(str(code_val) + "\n")
                        cli_exit_code = 1
                    result_value = cli_exit_code
                    flush_io()
                    flush_expanded_io()
                except Exception as exc:
                    kind = "throw"
                    result_value = encode_exception(exc)
                    cli_exit_code = 1
                finally:
                    if tracer is not None:
                        sys.settrace(None)
        finally:
            sys.stdout = real_stdout
            sys.stderr = real_stderr
            sys.stdin = real_stdin
            sys.argv = real_argv
            _cancel_alarm()

        if infrastructure_failures:
            cat, msg = infrastructure_failures[0]
            raise _BrokerError(msg, cat)

        if call_index != len(expected_calls):
            raise _BrokerError(
                f"Expected {len(expected_calls)} external calls, but guest performed {call_index}",
                "reference_process_failure",
            )

        phase = "observe"
        outcome_graph = describe_graph([*args, result_value])
        outcome_readable = encode_readable({"arguments": args, "value": result_value})
        trace_turns = tracer.finalize() if (tracer is not None and trace_enabled) else None
        if trace_turns is not None:
            dispatch_count = sum(1 for e in effects if e["kind"] == "dispatch")
            if len(trace_turns) != dispatch_count + 1:
                raise _BrokerError(
                    f"Trace turn count {len(trace_turns)} != dispatches + 1 ({dispatch_count + 1})",
                    "reference_process_failure",
                )

        response: dict[str, Any] = {
            "schema": "python-reference/1",
            "outcome": {
                "kind": kind,
                "graph": outcome_graph,
                "readable": outcome_readable,
            },
            "effects": effects,
            "traceTurns": trace_turns,
        }
        if is_cli_mode:
            response["cli"] = {
                "stdout": stdout_buf.getvalue(),
                "stderr": stderr_buf.getvalue(),
                "exitCode": cli_exit_code,
            }
        real_stdout.write(_json_dump(response) + "\n")
        real_stdout.flush()
        return 0

    except (TraceLimitError, _TimeoutError) as exc:
        sys.stdout = real_stdout
        sys.stderr = real_stderr
        sys.stdin = real_stdin
        sys.argv = real_argv
        _cancel_alarm()
        real_stdout.write(
            _json_dump({
                "schema": "python-reference/1",
                "error": str(exc),
                "failure": {
                    "category": "reference_resource_limit",
                    "message": str(exc),
                    "phase": phase,
                },
            })
            + "\n"
        )
        real_stdout.flush()
        return 1
    except _BrokerError as exc:
        sys.stdout = real_stdout
        sys.stderr = real_stderr
        sys.stdin = real_stdin
        sys.argv = real_argv
        _cancel_alarm()
        real_stdout.write(
            _json_dump({
                "schema": "python-reference/1",
                "error": str(exc),
                "failure": {
                    "category": exc.category,
                    "message": str(exc),
                    "phase": phase,
                },
            })
            + "\n"
        )
        real_stdout.flush()
        return 1
    except Exception as exc:
        sys.stdout = real_stdout
        sys.stderr = real_stderr
        sys.stdin = real_stdin
        sys.argv = real_argv
        _cancel_alarm()
        category = (
            "reference_instrumentation_unsupported"
            if phase in ("compile", "observe")
            else "reference_process_failure"
        )
        real_stdout.write(
            _json_dump({
                "schema": "python-reference/1",
                "error": str(exc),
                "failure": {
                    "category": category,
                    "message": str(exc),
                    "phase": phase,
                },
            })
            + "\n"
        )
        real_stdout.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
