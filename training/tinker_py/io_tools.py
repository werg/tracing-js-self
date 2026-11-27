"""Stdlib I/O, environment, logging, subprocess, time, uuid, secrets, and sqlite3 hooks.

Provides symmetric replay and live-capture interception helpers mirroring
``http_tools.py`` with strict guest-frame and re-entrancy (``io_depth``) guarding.

Canonical tool contracts:
- Filesystem: ``fs.readText``, ``fs.readBytes``, ``fs.writeText``,
  ``fs.writeBytes``, ``fs.exists``, ``fs.isFile``, ``fs.isDir``, ``fs.listdir``
- Environment: ``env.get``
- Logging: ``platform.log``
- Subprocess: ``shell.exec``
- Wall-clock: ``platform.time`` (``datetime.now`` / ``utcnow`` / ``today``, ``date.today``)
- Identifiers / Secrets: ``platform.uuid``, ``platform.secrets``
"""

from __future__ import annotations

import builtins
from collections.abc import Callable, Iterator, MutableMapping
import datetime as _datetime_mod
import io
import logging as _logging_mod
import os
import pathlib
import re
import secrets as _secrets_mod
import sqlite3 as _sqlite3_mod
import subprocess as _subprocess_mod
import sys
import uuid as _uuid_mod
from typing import Any

from .codec import encode_exception, encode_readable

MAX_IO_BYTES = 128 * 1024
MAX_LIVE_CALLS = 64
DEFAULT_SUBPROCESS_TIMEOUT_S = 2.0

_ORIG_OPEN = io.open
_ORIG_BUILTIN_OPEN = builtins.open
_ORIG_DATETIME = _datetime_mod.datetime
_ORIG_DATE = _datetime_mod.date
_ORIG_TIMEZONE = _datetime_mod.timezone
_ORIG_OS_ENVIRON = os.environ
_ORIG_OS_GETENV = os.getenv
_ORIG_OS_LISTDIR = os.listdir
_ORIG_OS_PATH_EXISTS = os.path.exists
_ORIG_OS_PATH_ISFILE = os.path.isfile
_ORIG_OS_PATH_ISDIR = os.path.isdir
_ORIG_OS_SYSTEM = getattr(os, "system", None)
_ORIG_OS_POPEN = getattr(os, "popen", None)
_ORIG_OS_REMOVE = getattr(os, "remove", None)
_ORIG_OS_UNLINK = getattr(os, "unlink", None)
_ORIG_OS_RMDIR = getattr(os, "rmdir", None)
_ORIG_PATH_OPEN = pathlib.Path.open
_ORIG_PATH_READ_TEXT = pathlib.Path.read_text
_ORIG_PATH_WRITE_TEXT = pathlib.Path.write_text
_ORIG_PATH_READ_BYTES = pathlib.Path.read_bytes
_ORIG_PATH_WRITE_BYTES = pathlib.Path.write_bytes
_ORIG_PATH_EXISTS = pathlib.Path.exists
_ORIG_PATH_IS_FILE = pathlib.Path.is_file
_ORIG_PATH_IS_DIR = pathlib.Path.is_dir
_ORIG_PATH_ITERDIR = pathlib.Path.iterdir
_ORIG_SUBPROCESS_RUN = _subprocess_mod.run
_ORIG_SUBPROCESS_CHECK_OUTPUT = _subprocess_mod.check_output
_ORIG_UUID4 = _uuid_mod.uuid4
_ORIG_SECRETS_TOKEN_HEX = _secrets_mod.token_hex
_ORIG_SECRETS_TOKEN_URLSAFE = _secrets_mod.token_urlsafe
_ORIG_SECRETS_TOKEN_BYTES = _secrets_mod.token_bytes
_ORIG_SECRETS_RANDBELOW = _secrets_mod.randbelow
_ORIG_SECRETS_RANDBITS = _secrets_mod.randbits
_ORIG_SECRETS_CHOICE = _secrets_mod.choice
_ORIG_SQLITE_CONNECT = _sqlite3_mod.connect

_ORIG_LOGGING_FUNCS = {
    name: getattr(_logging_mod, name)
    for name in ("debug", "info", "warning", "warn", "error", "critical", "fatal", "exception", "log")
}
_ORIG_LOGGER_METHODS = {
    name: getattr(_logging_mod.Logger, name)
    for name in ("debug", "info", "warning", "warn", "error", "critical", "fatal", "exception", "log")
}


def is_guest_caller(
    io_depth: list[int] | None = None,
    *,
    allow_module_prefixes: tuple[str, ...] = (),
) -> bool:
    """Return True iff the active direct caller is guest code (``<guest>``) outside io_depth."""
    if io_depth is not None and io_depth[0] > 0:
        return False
    try:
        frame: Any = sys._getframe(2)
    except ValueError:
        return False
    if allow_module_prefixes:
        hops = 0
        while frame is not None and hops < 8:
            mod_name = str(frame.f_globals.get("__name__", "")).split(".")[0]
            if mod_name not in allow_module_prefixes:
                break
            frame = frame.f_back
            hops += 1
    if frame is None:
        return False
    fname = frame.f_code.co_filename
    return fname == "<guest>" or fname.startswith("<guest:")


def _normalize_path_arg(file: Any) -> str:
    if isinstance(file, int):
        raise PermissionError("Raw file descriptors are not supported in guest code")
    return os.fsdecode(os.fspath(file))


def _normalize_bounded_output(
    raw: str | bytes | bytearray | memoryview | None,
    max_bytes: int = MAX_IO_BYTES,
) -> str | bytes:
    if raw is None:
        return ""
    if isinstance(raw, str):
        raw_bytes = raw.encode("utf-8", errors="surrogatepass")
        if len(raw_bytes) <= max_bytes:
            return raw
        clipped = raw_bytes[:max_bytes]
        for trim in range(4):
            end = len(clipped) - trim
            if end <= 0:
                break
            try:
                return clipped[:end].decode("utf-8")
            except UnicodeDecodeError:
                continue
        return clipped.decode("utf-8", errors="replace")
    raw_bytes = bytes(raw)
    if len(raw_bytes) > max_bytes:
        raw_bytes = raw_bytes[:max_bytes]
    try:
        return raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return raw_bytes


def build_io_exception(value: Any) -> Exception:
    """Reconstruct a faithful builtin/OSError exception from a canonical rejected payload."""
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        return OSError(str(value))
    name = value["name"]
    msg = str(value.get("message", ""))
    if name == "UnicodeDecodeError":
        return UnicodeDecodeError("utf-8", b"", 0, 1, msg)
    exc_cls = getattr(builtins, name, None)
    if isinstance(exc_cls, type) and issubclass(exc_cls, Exception):
        return exc_cls(msg)
    return OSError(f"{name}: {msg}" if msg else name)


def build_subprocess_exception(value: Any, cmd: Any = None) -> Exception:
    """Reconstruct a faithful subprocess/OS exception from a rejected shell.exec payload."""
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        return _subprocess_mod.SubprocessError(str(value))
    name = value["name"]
    msg = str(value.get("message", ""))
    if name == "CalledProcessError":
        match = re.search(r"exit status (-?\d+)", msg)
        rc = int(match.group(1)) if match else 1
        return _subprocess_mod.CalledProcessError(rc, cmd)
    if name == "TimeoutExpired":
        match = re.search(r"after ([0-9.]+) seconds", msg)
        timeout_val = float(match.group(1)) if match else DEFAULT_SUBPROCESS_TIMEOUT_S
        return _subprocess_mod.TimeoutExpired(cmd, timeout_val)
    return build_io_exception(value)


def _parse_open_mode(mode: str) -> tuple[bool, bool, bool]:
    if not isinstance(mode, str) or not mode:
        raise ValueError(f"invalid mode: {mode!r}")
    is_binary = "b" in mode
    is_write = any(ch in mode for ch in ("w", "a", "x"))
    is_plus = "+" in mode
    return is_binary, is_write, is_plus


class _InterceptedFile:
    """In-memory file-like object backing intercepted ``open()`` / ``Path.open()`` calls."""

    def __init__(
        self,
        *,
        path_str: str,
        mode: str,
        is_binary: bool,
        is_write: bool,
        initial_data: str | bytes = "",
        commit_fn: Callable[[str | bytes], None] | None = None,
        encoding: str | None = None,
        newline: str | None = None,
    ) -> None:
        self.name = path_str
        self.mode = mode
        self.encoding = None if is_binary else (encoding or "utf-8")
        self._is_binary = is_binary
        self._is_write = is_write
        self._commit_fn = commit_fn
        self._committed = False
        self._closed = False
        if is_binary:
            raw = initial_data if isinstance(initial_data, (bytes, bytearray)) else str(initial_data).encode("utf-8")
            self._stream: io.BytesIO | io.StringIO = io.BytesIO(bytes(raw) if not is_write else b"")
        else:
            txt = initial_data if isinstance(initial_data, str) else bytes(initial_data).decode("utf-8")
            if is_write:
                self._stream = io.StringIO("", newline="" if newline is None else newline)
            else:
                self._stream = io.StringIO(txt, newline="\n" if newline is None else newline)

    def read(self, size: int | None = -1) -> str | bytes:
        return self._stream.read(size)

    def readline(self, size: int = -1) -> str | bytes:
        return self._stream.readline(size)

    def readlines(self, hint: int = -1) -> list[str] | list[bytes]:
        return self._stream.readlines(hint)

    def write(self, data: str | bytes | bytearray | memoryview) -> int:
        if not self._is_write and "+" not in self.mode:
            raise io.UnsupportedOperation("not writable")
        if self._closed:
            raise ValueError("I/O operation on closed file.")
        if self._is_binary:
            raw = bytes(data) if isinstance(data, (bytes, bytearray, memoryview)) else data.encode("utf-8")  # type: ignore[union-attr]
            return self._stream.write(raw)  # type: ignore[arg-type]
        if not isinstance(data, str):
            raise TypeError(f"write() argument must be str, not {type(data).__name__}")
        return self._stream.write(data)  # type: ignore[arg-type]

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        if self._closed:
            raise ValueError("I/O operation on closed file.")

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._stream.seek(offset, whence)

    def tell(self) -> int:
        return self._stream.tell()

    def readable(self) -> bool:
        return not self._is_write or "+" in self.mode

    def writable(self) -> bool:
        return self._is_write or "+" in self.mode

    def seekable(self) -> bool:
        return True

    @property
    def closed(self) -> bool:
        return self._closed

    def __iter__(self) -> Iterator[str] | Iterator[bytes]:
        return iter(self._stream)  # type: ignore[return-value]

    def __next__(self) -> str | bytes:
        return next(self._stream)  # type: ignore[return-value]

    def close(self) -> None:
        if self._closed:
            return
        try:
            if self._is_write and not self._committed and self._commit_fn is not None:
                self._committed = True
                payload = self._stream.getvalue()
                self._commit_fn(payload)
        finally:
            self._closed = True
            self._stream.close()

    def __enter__(self) -> "_InterceptedFile":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
        self.close()
        return False


class _InterceptedEnviron(MutableMapping[str, str]):
    """Overlay mapping for ``os.environ`` routing guest lookups through ``env.get``."""

    def __init__(
        self,
        orig_environ: MutableMapping[str, str],
        lookup_fn: Callable[[str], str | None],
        io_depth: list[int],
    ) -> None:
        self._orig = orig_environ
        self._lookup = lookup_fn
        self._io_depth = io_depth
        self._overlay: dict[str, str] = {}
        self._deleted: set[str] = set()

    def _guest_get(self, key: Any) -> tuple[bool, str | None]:
        k = str(key)
        if k in self._overlay:
            return True, self._overlay[k]
        if k in self._deleted:
            return False, None
        val = self._lookup(k)
        if val is None:
            return False, None
        return True, str(val)

    def __getitem__(self, key: str) -> str:
        if not is_guest_caller(self._io_depth):
            return self._orig[key]
        found, val = self._guest_get(key)
        if not found or val is None:
            raise KeyError(key)
        return val

    def get(self, key: str, default: Any = None) -> Any:
        if not is_guest_caller(self._io_depth):
            return self._orig.get(key, default)
        found, val = self._guest_get(key)
        return val if found else default

    def __contains__(self, key: object) -> bool:
        if not is_guest_caller(self._io_depth):
            return key in self._orig
        if not isinstance(key, str):
            return False
        found, _ = self._guest_get(key)
        return found

    def __setitem__(self, key: str, value: str) -> None:
        if not is_guest_caller(self._io_depth):
            self._orig[key] = value
            return
        k = str(key)
        v = str(value)
        self._deleted.discard(k)
        self._overlay[k] = v

    def __delitem__(self, key: str) -> None:
        if not is_guest_caller(self._io_depth):
            del self._orig[key]
            return
        k = str(key)
        if k in self._overlay:
            del self._overlay[k]
            self._deleted.add(k)
            return
        if k in self._deleted or self._lookup(k) is None:
            raise KeyError(key)
        self._deleted.add(k)

    def __iter__(self) -> Iterator[str]:
        if not is_guest_caller(self._io_depth):
            return iter(self._orig)
        return iter(self._overlay)

    def __len__(self) -> int:
        if not is_guest_caller(self._io_depth):
            return len(self._orig)
        return len(self._overlay)

    def copy(self) -> dict[str, str]:
        if not is_guest_caller(self._io_depth):
            return dict(self._orig)
        return dict(self._overlay)

    def __repr__(self) -> str:
        if not is_guest_caller(self._io_depth):
            return repr(self._orig)
        return f"environ({self._overlay!r})"


def _format_log_message(msg: Any, args: tuple[Any, ...]) -> str:
    if args:
        eff_args: Any = (
            args[0]
            if (len(args) == 1 and isinstance(args[0], MutableMapping | dict) and args[0])
            else args
        )
        try:
            return str(msg) % eff_args
        except Exception:
            return f"{msg} {' '.join(str(a) for a in args)}"
    return str(msg)


def _level_name(level: Any) -> str:
    if isinstance(level, int) and not isinstance(level, bool):
        return str(_logging_mod.getLevelName(level))
    return str(level)


def _normalize_subprocess_args(args: Any) -> str | list[str]:
    if isinstance(args, (str, bytes, os.PathLike)):
        return os.fsdecode(os.fspath(args))
    if isinstance(args, (list, tuple)):
        return [
            os.fsdecode(os.fspath(item)) if isinstance(item, (str, bytes, os.PathLike)) else str(item)
            for item in args
        ]
    return str(args)


def _coerce_subprocess_stream(
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


class _DateMeta(type):
    def __instancecheck__(cls, instance: Any) -> bool:
        return isinstance(instance, _ORIG_DATE)

    def __subclasscheck__(cls, subclass: type) -> bool:
        return issubclass(subclass, _ORIG_DATE)


class _DatetimeMeta(_DateMeta):
    def __instancecheck__(cls, instance: Any) -> bool:
        return isinstance(instance, _ORIG_DATETIME)

    def __subclasscheck__(cls, subclass: type) -> bool:
        return issubclass(subclass, _ORIG_DATETIME)


def _install_io_hooks_impl(
    backend: Callable[[str, list[Any], Callable[[Any], Exception] | None, Callable[[], tuple[Any, Any]] | None], Any],
    *,
    io_depth: list[int],
    guest_builtins: dict[str, Any] | None = None,
    live_mode: bool,
    max_io_bytes: int = MAX_IO_BYTES,
    default_subprocess_timeout: float = DEFAULT_SUBPROCESS_TIMEOUT_S,
    next_time_fn: Callable[[], float] | None = None,
    enable_fs: bool = True,
    enable_env: bool = True,
    enable_logging: bool = True,
    enable_subprocess: bool = True,
    enable_datetime: bool = True,
    enable_uuid: bool = True,
    enable_secrets: bool = True,
    enable_sqlite: bool = True,
) -> Callable[[], None]:
    pending_writes: list[_InterceptedFile] = []

    def flush_pending_io() -> None:
        for fh in list(pending_writes):
            if not fh.closed:
                fh.close()
        pending_writes.clear()

    def _run_open(
        file: Any,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
        closefd: bool = True,
        opener: Any = None,
    ) -> Any:
        del buffering, closefd, opener
        path_str = _normalize_path_arg(file)
        is_binary, is_write, is_plus = _parse_open_mode(mode)
        if is_write:
            op = "fs.writeBytes" if is_binary else "fs.writeText"

            def _commit(payload: str | bytes) -> None:
                def _live_write() -> tuple[None, None]:
                    if len(payload) > max_io_bytes:
                        raise RuntimeError("File write exceeds probe size limit")
                    open_kwargs: dict[str, Any] = {}
                    if not is_binary:
                        open_kwargs["encoding"] = encoding or "utf-8"
                        if errors is not None:
                            open_kwargs["errors"] = errors
                        if newline is not None:
                            open_kwargs["newline"] = newline
                    with _ORIG_OPEN(path_str, mode, **open_kwargs) as real_fh:
                        real_fh.write(payload)
                    return None, None

                backend(op, [path_str, payload], build_io_exception, _live_write if live_mode else None)

            handle = _InterceptedFile(
                path_str=path_str,
                mode=mode,
                is_binary=is_binary,
                is_write=True,
                commit_fn=_commit,
                encoding=encoding,
                newline=newline,
            )
            pending_writes.append(handle)
            return handle

        if is_plus:
            # Read+write mode: read initial data via fs.readText/Bytes, buffer writes until close.
            read_op = "fs.readBytes" if is_binary else "fs.readText"
            write_op = "fs.writeBytes" if is_binary else "fs.writeText"

            def _live_read() -> tuple[str | bytes, str | bytes]:
                open_kwargs: dict[str, Any] = {}
                if not is_binary:
                    open_kwargs["encoding"] = encoding or "utf-8"
                    if errors is not None:
                        open_kwargs["errors"] = errors
                    if newline is not None:
                        open_kwargs["newline"] = newline
                with _ORIG_OPEN(path_str, "rb" if is_binary else "r", **open_kwargs) as real_fh:
                    data = real_fh.read(max_io_bytes + 1)
                if len(data) > max_io_bytes:
                    raise RuntimeError("File read exceeds probe size limit")
                return data, data

            initial = backend(read_op, [path_str], build_io_exception, _live_read if live_mode else None)

            def _commit_plus(payload: str | bytes) -> None:
                def _live_write_plus() -> tuple[None, None]:
                    open_kwargs: dict[str, Any] = {}
                    if not is_binary:
                        open_kwargs["encoding"] = encoding or "utf-8"
                        if errors is not None:
                            open_kwargs["errors"] = errors
                    with _ORIG_OPEN(path_str, "wb" if is_binary else "w", **open_kwargs) as real_fh:
                        real_fh.write(payload)
                    return None, None

                backend(write_op, [path_str, payload], build_io_exception, _live_write_plus if live_mode else None)

            handle = _InterceptedFile(
                path_str=path_str,
                mode=mode,
                is_binary=is_binary,
                is_write=True,
                initial_data=initial,
                commit_fn=_commit_plus,
                encoding=encoding,
                newline=newline,
            )
            if is_binary:
                handle._stream = io.BytesIO(bytes(initial))
            else:
                handle._stream = io.StringIO(str(initial), newline="\n" if newline is None else newline)
            pending_writes.append(handle)
            return handle

        op = "fs.readBytes" if is_binary else "fs.readText"

        def _live_read_only() -> tuple[str | bytes, str | bytes]:
            open_kwargs: dict[str, Any] = {}
            if not is_binary:
                open_kwargs["encoding"] = encoding or "utf-8"
                if errors is not None:
                    open_kwargs["errors"] = errors
                if newline is not None:
                    open_kwargs["newline"] = newline
            with _ORIG_OPEN(path_str, mode, **open_kwargs) as real_fh:
                data = real_fh.read(max_io_bytes + 1)
            if len(data) > max_io_bytes:
                raise RuntimeError("File read exceeds probe size limit")
            return data, data

        content = backend(op, [path_str], build_io_exception, _live_read_only if live_mode else None)
        return _InterceptedFile(
            path_str=path_str,
            mode=mode,
            is_binary=is_binary,
            is_write=False,
            initial_data=content,
            encoding=encoding,
            newline=newline,
        )

    if enable_fs:
        def _hooked_builtin_open(
            file: Any,
            mode: str = "r",
            buffering: int = -1,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
            closefd: bool = True,
            opener: Any = None,
        ) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_BUILTIN_OPEN(file, mode, buffering, encoding, errors, newline, closefd, opener)
            return _run_open(file, mode, buffering, encoding, errors, newline, closefd, opener)

        def _hooked_io_open(
            file: Any,
            mode: str = "r",
            buffering: int = -1,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
            closefd: bool = True,
            opener: Any = None,
        ) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_OPEN(file, mode, buffering, encoding, errors, newline, closefd, opener)
            return _run_open(file, mode, buffering, encoding, errors, newline, closefd, opener)

        if guest_builtins is not None:
            guest_builtins["open"] = _hooked_builtin_open
        io.open = _hooked_io_open  # type: ignore[assignment]

        def _path_open(
            self: pathlib.Path,
            mode: str = "r",
            buffering: int = -1,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
        ) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_OPEN(self, mode, buffering, encoding, errors, newline)
            return _run_open(self, mode, buffering, encoding, errors, newline)

        def _path_read_text(
            self: pathlib.Path,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
        ) -> str:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_READ_TEXT(self, encoding=encoding, errors=errors, newline=newline)
            path_str = str(self)

            def _live() -> tuple[str, str]:
                data = _ORIG_PATH_READ_TEXT(self, encoding=encoding, errors=errors, newline=newline)
                if len(data.encode("utf-8", errors="surrogatepass")) > max_io_bytes:
                    raise RuntimeError("File read exceeds probe size limit")
                return data, data

            return str(backend("fs.readText", [path_str], build_io_exception, _live if live_mode else None))

        def _path_write_text(
            self: pathlib.Path,
            data: str,
            encoding: str | None = None,
            errors: str | None = None,
            newline: str | None = None,
        ) -> int:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_WRITE_TEXT(self, data, encoding=encoding, errors=errors, newline=newline)
            if not isinstance(data, str):
                raise TypeError(f"data must be str, not {type(data).__name__}")
            path_str = str(self)

            def _live() -> tuple[int, None]:
                if len(data.encode("utf-8", errors="surrogatepass")) > max_io_bytes:
                    raise RuntimeError("File write exceeds probe size limit")
                written = _ORIG_PATH_WRITE_TEXT(self, data, encoding=encoding, errors=errors, newline=newline)
                return written, None

            backend("fs.writeText", [path_str, data], build_io_exception, _live if live_mode else None)
            return len(data)

        def _path_read_bytes(self: pathlib.Path) -> bytes:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_READ_BYTES(self)
            path_str = str(self)

            def _live() -> tuple[bytes, bytes]:
                data = _ORIG_PATH_READ_BYTES(self)
                if len(data) > max_io_bytes:
                    raise RuntimeError("File read exceeds probe size limit")
                return data, data

            res = backend("fs.readBytes", [path_str], build_io_exception, _live if live_mode else None)
            return bytes(res) if not isinstance(res, bytes) else res

        def _path_write_bytes(self: pathlib.Path, data: Any) -> int:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_WRITE_BYTES(self, data)
            raw = bytes(data)
            path_str = str(self)

            def _live() -> tuple[int, None]:
                if len(raw) > max_io_bytes:
                    raise RuntimeError("File write exceeds probe size limit")
                written = _ORIG_PATH_WRITE_BYTES(self, raw)
                return written, None

            backend("fs.writeBytes", [path_str, raw], build_io_exception, _live if live_mode else None)
            return len(raw)

        def _path_exists(self: pathlib.Path, *, follow_symlinks: bool = True) -> bool:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_EXISTS(self, follow_symlinks=follow_symlinks)
            path_str = str(self)

            def _live() -> tuple[bool, bool]:
                res = bool(_ORIG_PATH_EXISTS(self, follow_symlinks=follow_symlinks))
                return res, res

            return bool(backend("fs.exists", [path_str], build_io_exception, _live if live_mode else None))

        def _path_is_file(self: pathlib.Path, *, follow_symlinks: bool = True) -> bool:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_IS_FILE(self, follow_symlinks=follow_symlinks)
            path_str = str(self)

            def _live() -> tuple[bool, bool]:
                res = bool(_ORIG_PATH_IS_FILE(self, follow_symlinks=follow_symlinks))
                return res, res

            return bool(backend("fs.isFile", [path_str], build_io_exception, _live if live_mode else None))

        def _path_is_dir(self: pathlib.Path, *, follow_symlinks: bool = True) -> bool:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_IS_DIR(self, follow_symlinks=follow_symlinks)
            path_str = str(self)

            def _live() -> tuple[bool, bool]:
                res = bool(_ORIG_PATH_IS_DIR(self, follow_symlinks=follow_symlinks))
                return res, res

            return bool(backend("fs.isDir", [path_str], build_io_exception, _live if live_mode else None))

        def _path_iterdir(self: pathlib.Path) -> Iterator[pathlib.Path]:
            if not is_guest_caller(io_depth):
                return _ORIG_PATH_ITERDIR(self)
            path_str = str(self)

            def _live() -> tuple[list[str], list[str]]:
                entries = sorted(p.name for p in _ORIG_PATH_ITERDIR(self))
                return entries, entries

            names = backend("fs.listdir", [path_str], build_io_exception, _live if live_mode else None)
            return iter([self / str(name) for name in names])

        pathlib.Path.open = _path_open  # type: ignore[method-assign]
        pathlib.Path.read_text = _path_read_text  # type: ignore[method-assign]
        pathlib.Path.write_text = _path_write_text  # type: ignore[method-assign]
        pathlib.Path.read_bytes = _path_read_bytes  # type: ignore[method-assign]
        pathlib.Path.write_bytes = _path_write_bytes  # type: ignore[method-assign]
        pathlib.Path.exists = _path_exists  # type: ignore[method-assign]
        pathlib.Path.is_file = _path_is_file  # type: ignore[method-assign]
        pathlib.Path.is_dir = _path_is_dir  # type: ignore[method-assign]
        pathlib.Path.iterdir = _path_iterdir  # type: ignore[method-assign]

        def _os_listdir(path: Any = ".") -> list[str]:
            if not is_guest_caller(io_depth):
                return _ORIG_OS_LISTDIR(path)
            path_str = _normalize_path_arg(path)

            def _live() -> tuple[list[str], list[str]]:
                entries = sorted(os.fsdecode(e) for e in _ORIG_OS_LISTDIR(path_str))
                return entries, entries

            return list(backend("fs.listdir", [path_str], build_io_exception, _live if live_mode else None))

        def _os_path_exists(path: Any) -> bool:
            if not is_guest_caller(io_depth):
                return _ORIG_OS_PATH_EXISTS(path)
            path_str = _normalize_path_arg(path)

            def _live() -> tuple[bool, bool]:
                res = bool(_ORIG_OS_PATH_EXISTS(path_str))
                return res, res

            return bool(backend("fs.exists", [path_str], build_io_exception, _live if live_mode else None))

        def _os_path_isfile(path: Any) -> bool:
            if not is_guest_caller(io_depth):
                return _ORIG_OS_PATH_ISFILE(path)
            path_str = _normalize_path_arg(path)

            def _live() -> tuple[bool, bool]:
                res = bool(_ORIG_OS_PATH_ISFILE(path_str))
                return res, res

            return bool(backend("fs.isFile", [path_str], build_io_exception, _live if live_mode else None))

        def _os_path_isdir(path: Any) -> bool:
            if not is_guest_caller(io_depth):
                return _ORIG_OS_PATH_ISDIR(path)
            path_str = _normalize_path_arg(path)

            def _live() -> tuple[bool, bool]:
                res = bool(_ORIG_OS_PATH_ISDIR(path_str))
                return res, res

            return bool(backend("fs.isDir", [path_str], build_io_exception, _live if live_mode else None))

        os.listdir = _os_listdir  # type: ignore[assignment]
        os.path.exists = _os_path_exists  # type: ignore[assignment]
        os.path.isfile = _os_path_isfile  # type: ignore[assignment]
        os.path.isdir = _os_path_isdir  # type: ignore[assignment]

        # Block unintercepted destructive os operations for direct guest callers.
        def _blocked_os_op(name: str, orig: Any) -> Any:
            if orig is None:
                return None

            def _guard(*args: Any, **kwargs: Any) -> Any:
                if not is_guest_caller(io_depth):
                    return orig(*args, **kwargs)
                raise PermissionError(f"Unintercepted os.{name} is disabled in sandboxed execution")

            return _guard

        for os_attr, orig_fn in (
            ("system", _ORIG_OS_SYSTEM),
            ("popen", _ORIG_OS_POPEN),
            ("remove", _ORIG_OS_REMOVE),
            ("unlink", _ORIG_OS_UNLINK),
            ("rmdir", _ORIG_OS_RMDIR),
        ):
            if orig_fn is not None:
                setattr(os, os_attr, _blocked_os_op(os_attr, orig_fn))

    if enable_env:
        def _lookup_env(key: str) -> str | None:
            def _live() -> tuple[str | None, str | None]:
                val = _ORIG_OS_GETENV(key, None)
                return val, val

            res = backend("env.get", [key], build_io_exception, _live if live_mode else None)
            return None if res is None else str(res)

        intercepted_env = _InterceptedEnviron(_ORIG_OS_ENVIRON, _lookup_env, io_depth)

        def _os_getenv(key: str, default: Any = None) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_OS_GETENV(key, default)
            k = str(key)
            if k in intercepted_env._overlay:
                return intercepted_env._overlay[k]
            if k in intercepted_env._deleted:
                return default
            val = _lookup_env(k)
            return default if val is None else val

        os.environ = intercepted_env  # type: ignore[assignment]
        os.getenv = _os_getenv  # type: ignore[assignment]

    if enable_logging:
        def _emit_log(level_name: str, msg: Any, args: tuple[Any, ...]) -> None:
            formatted = _format_log_message(msg, args)
            backend("platform.log", [level_name, formatted], build_io_exception, (lambda: (None, None)) if live_mode else None)

        def _make_mod_log_fn(fixed_level: str | None, orig_fn: Any) -> Any:
            if fixed_level is None:
                def _fn(level: Any, msg: Any, *args: Any, **kwargs: Any) -> None:
                    if not is_guest_caller(io_depth, allow_module_prefixes=("logging",)):
                        return orig_fn(level, msg, *args, **kwargs)
                    _emit_log(_level_name(level), msg, args)

                return _fn

            def _fn_fixed(msg: Any, *args: Any, **kwargs: Any) -> None:
                if not is_guest_caller(io_depth, allow_module_prefixes=("logging",)):
                    return orig_fn(msg, *args, **kwargs)
                _emit_log(fixed_level, msg, args)

            return _fn_fixed

        def _make_logger_method(fixed_level: str | None, orig_meth: Any) -> Any:
            if fixed_level is None:
                def _meth(self: _logging_mod.Logger, level: Any, msg: Any, *args: Any, **kwargs: Any) -> None:
                    if not is_guest_caller(io_depth, allow_module_prefixes=("logging",)):
                        return orig_meth(self, level, msg, *args, **kwargs)
                    _emit_log(_level_name(level), msg, args)

                return _meth

            def _meth_fixed(self: _logging_mod.Logger, msg: Any, *args: Any, **kwargs: Any) -> None:
                if not is_guest_caller(io_depth, allow_module_prefixes=("logging",)):
                    return orig_meth(self, msg, *args, **kwargs)
                _emit_log(fixed_level, msg, args)

            return _meth_fixed

        level_map: dict[str, str | None] = {
            "debug": "DEBUG",
            "info": "INFO",
            "warning": "WARNING",
            "warn": "WARNING",
            "error": "ERROR",
            "critical": "CRITICAL",
            "fatal": "CRITICAL",
            "exception": "ERROR",
            "log": None,
        }
        for fname, fixed in level_map.items():
            setattr(_logging_mod, fname, _make_mod_log_fn(fixed, _ORIG_LOGGING_FUNCS[fname]))
            setattr(_logging_mod.Logger, fname, _make_logger_method(fixed, _ORIG_LOGGER_METHODS[fname]))

    if enable_subprocess:
        def _exec_subprocess(
            args: Any,
            *,
            stdin: Any = None,
            input: Any = None,  # noqa: A002
            stdout: Any = None,
            stderr: Any = None,
            capture_output: bool = False,
            shell: bool = False,
            cwd: Any = None,
            timeout: float | None = None,
            check: bool = False,
            encoding: str | None = None,
            errors: str | None = None,
            text: bool | None = None,
            universal_newlines: bool | None = None,
            env: Any = None,
        ) -> _subprocess_mod.CompletedProcess[Any]:
            norm_args = _normalize_subprocess_args(args)
            req_dict = {"args": norm_args, "shell": bool(shell)}
            text_mode = bool(text or encoding or errors or universal_newlines)
            capture_stdout = bool(capture_output or stdout == _subprocess_mod.PIPE)
            capture_stderr = bool(capture_output or stderr == _subprocess_mod.PIPE)
            merge_stderr = stderr == _subprocess_mod.STDOUT

            def _live_exec() -> tuple[dict[str, Any], dict[str, Any]]:
                eff_timeout = (
                    min(float(timeout), default_subprocess_timeout)
                    if timeout is not None
                    else default_subprocess_timeout
                )
                run_kwargs: dict[str, Any] = {
                    "shell": bool(shell),
                    "timeout": eff_timeout,
                    "check": False,
                    "stdout": _subprocess_mod.PIPE,
                    "stderr": _subprocess_mod.STDOUT if merge_stderr else _subprocess_mod.PIPE,
                }
                if input is not None:
                    run_kwargs["input"] = input
                elif stdin is not None:
                    run_kwargs["stdin"] = stdin
                if cwd is not None:
                    run_kwargs["cwd"] = cwd
                if env is not None:
                    run_kwargs["env"] = env
                if encoding is not None:
                    run_kwargs["encoding"] = encoding
                if errors is not None:
                    run_kwargs["errors"] = errors
                if text is not None:
                    run_kwargs["text"] = text
                if universal_newlines is not None:
                    run_kwargs["universal_newlines"] = universal_newlines

                real_cp = _ORIG_SUBPROCESS_RUN(args, **run_kwargs)
                out_norm = _normalize_bounded_output(real_cp.stdout, max_bytes=max_io_bytes)
                err_norm = (
                    ""
                    if merge_stderr
                    else _normalize_bounded_output(real_cp.stderr, max_bytes=max_io_bytes)
                )
                res_dict = {
                    "returncode": int(real_cp.returncode),
                    "stdout": out_norm,
                    "stderr": err_norm,
                }
                if check and real_cp.returncode != 0:
                    raise _subprocess_mod.CalledProcessError(
                        real_cp.returncode, args, output=real_cp.stdout, stderr=real_cp.stderr
                    )
                return res_dict, res_dict

            res = backend(
                "shell.exec",
                [req_dict],
                lambda err_val: build_subprocess_exception(err_val, cmd=args),
                _live_exec if live_mode else None,
            )
            if not isinstance(res, dict):
                raise RuntimeError(f"Expected dict result from shell.exec, got {type(res).__name__}")
            rc = int(res.get("returncode", 0))
            cp_stdout = _coerce_subprocess_stream(
                res.get("stdout"),
                captured=capture_stdout,
                text_mode=text_mode,
                encoding=encoding,
                errors=errors,
            )
            cp_stderr = _coerce_subprocess_stream(
                res.get("stderr"),
                captured=capture_stderr and not merge_stderr,
                text_mode=text_mode,
                encoding=encoding,
                errors=errors,
            )
            if check and rc != 0:
                raise _subprocess_mod.CalledProcessError(rc, args, output=cp_stdout, stderr=cp_stderr)
            return _subprocess_mod.CompletedProcess(args=args, returncode=rc, stdout=cp_stdout, stderr=cp_stderr)

        def _hooked_subprocess_run(
            args: Any,
            *,
            stdin: Any = None,
            input: Any = None,  # noqa: A002
            stdout: Any = None,
            stderr: Any = None,
            capture_output: bool = False,
            shell: bool = False,
            cwd: Any = None,
            timeout: float | None = None,
            check: bool = False,
            encoding: str | None = None,
            errors: str | None = None,
            text: bool | None = None,
            universal_newlines: bool | None = None,
            env: Any = None,
            **extra_kwargs: Any,
        ) -> _subprocess_mod.CompletedProcess[Any]:
            if not is_guest_caller(io_depth):
                return _ORIG_SUBPROCESS_RUN(
                    args,
                    stdin=stdin,
                    input=input,
                    stdout=stdout,
                    stderr=stderr,
                    capture_output=capture_output,
                    shell=shell,
                    cwd=cwd,
                    timeout=timeout,
                    check=check,
                    encoding=encoding,
                    errors=errors,
                    text=text,
                    universal_newlines=universal_newlines,
                    env=env,
                    **extra_kwargs,
                )
            return _exec_subprocess(
                args,
                stdin=stdin,
                input=input,
                stdout=stdout,
                stderr=stderr,
                capture_output=capture_output,
                shell=shell,
                cwd=cwd,
                timeout=timeout,
                check=check,
                encoding=encoding,
                errors=errors,
                text=text,
                universal_newlines=universal_newlines,
                env=env,
            )

        def _hooked_subprocess_check_output(
            args: Any,
            *,
            stdin: Any = None,
            input: Any = None,  # noqa: A002
            stderr: Any = None,
            shell: bool = False,
            cwd: Any = None,
            timeout: float | None = None,
            encoding: str | None = None,
            errors: str | None = None,
            text: bool | None = None,
            universal_newlines: bool | None = None,
            env: Any = None,
            **extra_kwargs: Any,
        ) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_SUBPROCESS_CHECK_OUTPUT(
                    args,
                    stdin=stdin,
                    input=input,
                    stderr=stderr,
                    shell=shell,
                    cwd=cwd,
                    timeout=timeout,
                    encoding=encoding,
                    errors=errors,
                    text=text,
                    universal_newlines=universal_newlines,
                    env=env,
                    **extra_kwargs,
                )
            if "stdout" in extra_kwargs or "check" in extra_kwargs:
                raise ValueError("stdout/check argument not allowed, it will be overridden.")
            cp = _exec_subprocess(
                args,
                stdin=stdin,
                input=input,
                stdout=_subprocess_mod.PIPE,
                stderr=stderr,
                shell=shell,
                cwd=cwd,
                timeout=timeout,
                check=True,
                encoding=encoding,
                errors=errors,
                text=text,
                universal_newlines=universal_newlines,
                env=env,
            )
            return cp.stdout

        _subprocess_mod.run = _hooked_subprocess_run  # type: ignore[assignment]
        _subprocess_mod.check_output = _hooked_subprocess_check_output  # type: ignore[assignment]

    if enable_datetime:
        def _get_wall_clock_ts() -> float:
            def _live() -> tuple[float, float]:
                val = float(next_time_fn() if next_time_fn is not None else _ORIG_DATETIME.now().timestamp())
                return val, val

            return float(backend("platform.time", [], build_io_exception, _live if live_mode else None))

        class _PatchedDate(_ORIG_DATE, metaclass=_DateMeta):
            def __new__(cls, year: int, month: int | None = None, day: int | None = None) -> Any:
                if cls is _PatchedDate:
                    return _ORIG_DATE(year, month, day)  # type: ignore[arg-type]
                return super().__new__(cls, year, month, day)  # type: ignore[arg-type]

            @classmethod
            def today(cls) -> _datetime_mod.date:
                if not is_guest_caller(io_depth):
                    return _ORIG_DATE.today()
                return _ORIG_DATE.fromtimestamp(_get_wall_clock_ts())

        _PatchedDate.__name__ = "date"
        _PatchedDate.__qualname__ = "date"

        class _PatchedDatetime(_ORIG_DATETIME, metaclass=_DatetimeMeta):
            def __new__(cls, *args: Any, **kwargs: Any) -> Any:
                if cls is _PatchedDatetime:
                    return _ORIG_DATETIME(*args, **kwargs)
                return super().__new__(cls, *args, **kwargs)

            @classmethod
            def now(cls, tz: Any = None) -> _datetime_mod.datetime:
                if not is_guest_caller(io_depth):
                    return _ORIG_DATETIME.now(tz)
                return _ORIG_DATETIME.fromtimestamp(_get_wall_clock_ts(), tz)

            @classmethod
            def today(cls) -> _datetime_mod.datetime:
                if not is_guest_caller(io_depth):
                    return _ORIG_DATETIME.today()
                return _ORIG_DATETIME.fromtimestamp(_get_wall_clock_ts())

            @classmethod
            def utcnow(cls) -> _datetime_mod.datetime:
                if not is_guest_caller(io_depth):
                    return _ORIG_DATETIME.fromtimestamp(_ORIG_DATETIME.now().timestamp(), _ORIG_TIMEZONE.utc).replace(tzinfo=None)
                return _ORIG_DATETIME.fromtimestamp(_get_wall_clock_ts(), _ORIG_TIMEZONE.utc).replace(tzinfo=None)

        _PatchedDatetime.__name__ = "datetime"
        _PatchedDatetime.__qualname__ = "datetime"

        _datetime_mod.date = _PatchedDate  # type: ignore[misc]
        _datetime_mod.datetime = _PatchedDatetime  # type: ignore[misc]

    if enable_uuid:
        def _hooked_uuid4() -> _uuid_mod.UUID:
            if not is_guest_caller(io_depth):
                return _ORIG_UUID4()

            def _live() -> tuple[str, str]:
                u_str = str(_ORIG_UUID4())
                return u_str, u_str

            res = backend("platform.uuid", [], build_io_exception, _live if live_mode else None)
            return _uuid_mod.UUID(str(res))

        _uuid_mod.uuid4 = _hooked_uuid4  # type: ignore[assignment]

    if enable_secrets:
        def _secrets_call(method: str, arg: int, live_fn: Callable[[], Any]) -> Any:
            def _live() -> tuple[Any, Any]:
                val = live_fn()
                return val, val

            return backend("platform.secrets", [method, arg], build_io_exception, _live if live_mode else None)

        def _token_hex(nbytes: int | None = None) -> str:
            if not is_guest_caller(io_depth):
                return _ORIG_SECRETS_TOKEN_HEX(nbytes)
            n = _secrets_mod.DEFAULT_ENTROPY if nbytes is None else int(nbytes)
            return str(_secrets_call("token_hex", n, lambda: _ORIG_SECRETS_TOKEN_HEX(n)))

        def _token_urlsafe(nbytes: int | None = None) -> str:
            if not is_guest_caller(io_depth):
                return _ORIG_SECRETS_TOKEN_URLSAFE(nbytes)
            n = _secrets_mod.DEFAULT_ENTROPY if nbytes is None else int(nbytes)
            return str(_secrets_call("token_urlsafe", n, lambda: _ORIG_SECRETS_TOKEN_URLSAFE(n)))

        def _token_bytes(nbytes: int | None = None) -> bytes:
            if not is_guest_caller(io_depth):
                return _ORIG_SECRETS_TOKEN_BYTES(nbytes)
            n = _secrets_mod.DEFAULT_ENTROPY if nbytes is None else int(nbytes)
            res = _secrets_call("token_bytes", n, lambda: _ORIG_SECRETS_TOKEN_BYTES(n))
            return bytes(res) if not isinstance(res, bytes) else res

        def _randbelow(exclusive_upper_bound: int) -> int:
            if not is_guest_caller(io_depth):
                return _ORIG_SECRETS_RANDBELOW(exclusive_upper_bound)
            bound = int(exclusive_upper_bound)
            if bound <= 0:
                raise ValueError("Upper bound must be positive.")
            return int(_secrets_call("randbelow", bound, lambda: _ORIG_SECRETS_RANDBELOW(bound)))

        def _randbits(k: int) -> int:
            if not is_guest_caller(io_depth):
                return _ORIG_SECRETS_RANDBITS(k)
            bits = int(k)
            return int(_secrets_call("randbits", bits, lambda: _ORIG_SECRETS_RANDBITS(bits)))

        def _choice(seq: Any) -> Any:
            if not is_guest_caller(io_depth):
                return _ORIG_SECRETS_CHOICE(seq)
            if not seq:
                raise IndexError("Cannot choose from an empty sequence")
            bound = len(seq)
            idx = int(_secrets_call("randbelow", bound, lambda: _ORIG_SECRETS_RANDBELOW(bound)))
            return seq[idx]

        _secrets_mod.token_hex = _token_hex  # type: ignore[assignment]
        _secrets_mod.token_urlsafe = _token_urlsafe  # type: ignore[assignment]
        _secrets_mod.token_bytes = _token_bytes  # type: ignore[assignment]
        _secrets_mod.randbelow = _randbelow  # type: ignore[assignment]
        _secrets_mod.randbits = _randbits  # type: ignore[assignment]
        _secrets_mod.choice = _choice  # type: ignore[assignment]

    if enable_sqlite:
        def _hooked_sqlite_connect(database: Any, *args: Any, **kwargs: Any) -> _sqlite3_mod.Connection:
            if not is_guest_caller(io_depth):
                return _ORIG_SQLITE_CONNECT(database, *args, **kwargs)
            db_str = os.fsdecode(os.fspath(database)) if isinstance(database, (str, bytes, os.PathLike)) else str(database)
            is_mem = db_str == ":memory:" or (
                bool(kwargs.get("uri")) and db_str.startswith("file::memory:")
            )
            if not is_mem:
                raise PermissionError(
                    "External SQLite database files are disabled in guest code; use ':memory:'"
                )
            return _ORIG_SQLITE_CONNECT(database, *args, **kwargs)

        _sqlite3_mod.connect = _hooked_sqlite_connect  # type: ignore[assignment]

    return flush_pending_io


def install_replay_io_hooks(
    invoke_fn: Callable[[str, list[Any], Callable[[Any], Exception] | None], Any],
    *,
    io_depth: list[int] | None = None,
    guest_builtins: dict[str, Any] | None = None,
    enable_fs: bool = True,
    enable_env: bool = True,
    enable_logging: bool = True,
    enable_subprocess: bool = True,
    enable_datetime: bool = True,
    enable_uuid: bool = True,
    enable_secrets: bool = True,
    enable_sqlite: bool = True,
) -> Callable[[], None]:
    """Install deterministic replay hooks for Python stdlib I/O and platform calls."""
    depth = io_depth if io_depth is not None else [0]

    def _replay_backend(
        operation: str,
        arguments: list[Any],
        exc_builder: Callable[[Any], Exception] | None,
        _live_fn: Callable[[], tuple[Any, Any]] | None,
    ) -> Any:
        return invoke_fn(operation, arguments, exc_builder)

    return _install_io_hooks_impl(
        _replay_backend,
        io_depth=depth,
        guest_builtins=guest_builtins,
        live_mode=False,
        enable_fs=enable_fs,
        enable_env=enable_env,
        enable_logging=enable_logging,
        enable_subprocess=enable_subprocess,
        enable_datetime=enable_datetime,
        enable_uuid=enable_uuid,
        enable_secrets=enable_secrets,
        enable_sqlite=enable_sqlite,
    )


def install_live_io_hooks(
    recorded_calls: list[dict[str, Any]],
    *,
    io_depth: list[int] | None = None,
    guest_builtins: dict[str, Any] | None = None,
    max_io_bytes: int = MAX_IO_BYTES,
    max_recorded_calls: int = MAX_LIVE_CALLS,
    default_subprocess_timeout: float = DEFAULT_SUBPROCESS_TIMEOUT_S,
    next_time_fn: Callable[[], float] | None = None,
    enable_fs: bool = True,
    enable_env: bool = True,
    enable_logging: bool = True,
    enable_subprocess: bool = True,
    enable_datetime: bool = True,
    enable_uuid: bool = True,
    enable_secrets: bool = True,
    enable_sqlite: bool = True,
) -> Callable[[], None]:
    """Install live-capture hooks that execute once and record canonical calls into ``recorded_calls``."""
    depth = io_depth if io_depth is not None else [0]

    def _live_backend(
        operation: str,
        arguments: list[Any],
        exc_builder: Callable[[Any], Exception] | None,
        live_fn: Callable[[], tuple[Any, Any]] | None,
    ) -> Any:
        if len(recorded_calls) >= max_recorded_calls:
            raise RuntimeError("too many recorded calls")
        assert live_fn is not None
        enc_args = encode_readable(arguments)
        depth[0] += 1
        try:
            raw_val, recorded_result = live_fn()
        except Exception as exc:
            err_dict = encode_exception(exc)
            recorded_calls.append({
                "operation": operation,
                "arguments": enc_args,
                "status": "rejected",
                "result": err_dict,
            })
            if callable(exc_builder):
                raise exc_builder(err_dict) from exc
            raise
        finally:
            depth[0] -= 1

        recorded_calls.append({
            "operation": operation,
            "arguments": enc_args,
            "status": "fulfilled",
            "result": encode_readable(recorded_result, allow_exceptions=True),
        })
        return raw_val

    return _install_io_hooks_impl(
        _live_backend,
        io_depth=depth,
        guest_builtins=guest_builtins,
        live_mode=True,
        max_io_bytes=max_io_bytes,
        default_subprocess_timeout=default_subprocess_timeout,
        next_time_fn=next_time_fn,
        enable_fs=enable_fs,
        enable_env=enable_env,
        enable_logging=enable_logging,
        enable_subprocess=enable_subprocess,
        enable_datetime=enable_datetime,
        enable_uuid=enable_uuid,
        enable_secrets=enable_secrets,
        enable_sqlite=enable_sqlite,
    )
