"""HTTP/network interception helpers for Python reference replay and live harvesting.

Maps ``urllib.request.urlopen`` and ``requests`` (``get``, ``post``, ``put``,
``delete``, ``patch``, ``head``, ``options``, ``request``, ``Session``) onto the
canonical ``http.request`` tool contract:

- Request argument (1 argument):
  ``{"method": "GET"|"POST"|..., "url": str, ...}`` with ``"headers"``
  (``dict[str, str]``, omitted when empty) and ``"body"`` (``str | bytes``,
  omitted when ``None``).
- Fulfilled result:
  ``{"status": int, "url": str, "headers": dict[str, str], "body": str | bytes}``.
- Rejected result:
  ``{"name": str, "message": str}`` mapped to matching ``urllib.error`` or
  ``requests.exceptions`` exception types.
"""

from __future__ import annotations

import base64
import builtins
from collections.abc import Iterator, MutableMapping
import http.client
from http import HTTPStatus
import io
import json
import re
import socket
import sys
import types
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request

from .codec import encode_exception, encode_readable

MAX_HTTP_BODY_BYTES = 48 * 1024
DEFAULT_HTTP_TIMEOUT_S = 4.0

_HTTP_VERBS = ("get", "post", "put", "delete", "patch", "head", "options")


def _http_reason(status: int) -> str:
    try:
        return HTTPStatus(int(status)).phrase
    except ValueError:
        return ""


def normalize_http_body(
    raw: str | bytes | bytearray | memoryview,
    max_bytes: int = MAX_HTTP_BODY_BYTES,
) -> str | bytes:
    """Normalize HTTP body to UTF-8 str when valid, else bytes, bounded to max_bytes."""
    if isinstance(raw, str):
        encoded = raw.encode("utf-8", errors="surrogatepass")
        if len(encoded) <= max_bytes:
            return raw
        raw_bytes = encoded
        was_truncated = True
    else:
        raw_bytes = bytes(raw)
        was_truncated = len(raw_bytes) > max_bytes

    if was_truncated:
        clipped = raw_bytes[:max_bytes]
        for trim in range(4):
            end = len(clipped) - trim
            if end <= 0:
                break
            try:
                return clipped[:end].decode("utf-8")
            except UnicodeDecodeError:
                continue
        return clipped

    try:
        return raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return raw_bytes


def _normalize_headers_dict(raw_headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if not raw_headers:
        return out
    items = raw_headers.items() if hasattr(raw_headers, "items") else raw_headers
    for k, v in items:
        if v is None:
            continue
        ks = str(k)
        vs = str(v)
        # Preserve deterministic first-seen key when merging repeated response headers.
        existing = next((ek for ek in out if ek.lower() == ks.lower()), None)
        if existing is not None:
            out[existing] = f"{out[existing]}, {vs}"
        else:
            out[ks] = vs
    return out


def canonical_http_request_dict(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: str | bytes | bytearray | memoryview | None = None,
) -> dict[str, Any]:
    """Build canonical http.request argument dict with deterministic key order."""
    req: dict[str, Any] = {
        "method": str(method or "GET").upper(),
        "url": str(url),
    }
    if headers:
        clean_headers = {str(k): str(v) for k, v in headers.items() if v is not None}
        if clean_headers:
            req["headers"] = clean_headers
    if body is not None:
        req["body"] = normalize_http_body(body)
    return req


def build_urllib_request_dict(url: Any, data: Any = None) -> dict[str, Any]:
    """Extract canonical http.request dict from urllib.request.urlopen arguments."""
    if isinstance(url, str):
        method = "POST" if data is not None else "GET"
        full_url = url
        headers: dict[str, str] = {}
        effective_data = data
    else:
        full_url = str(url.full_url)
        effective_data = data if data is not None else getattr(url, "data", None)
        if data is not None and getattr(url, "method", None) is None:
            method = "POST"
        else:
            method = str(url.get_method()).upper()
        headers = {str(k): str(v) for k, v in url.header_items()}

    body: str | bytes | None = None
    if effective_data is not None:
        if isinstance(effective_data, (bytes, bytearray, memoryview, str)):
            body = normalize_http_body(effective_data)
        else:
            raise TypeError("Unsupported urllib request body type")

    return canonical_http_request_dict(method, full_url, headers=headers, body=body)


def _merge_url_params(url: str, session_params: Any, call_params: Any) -> str:
    def _to_pairs(p: Any) -> list[tuple[str, Any]] | str | None:
        if p is None:
            return None
        if isinstance(p, bytes):
            return p.decode("utf-8")
        if isinstance(p, str):
            return p
        if isinstance(p, dict):
            return [(str(k), v) for k, v in p.items() if v is not None]
        if isinstance(p, (list, tuple)):
            return [(str(k), v) for k, v in p if v is not None]
        return None

    segments: list[str] = []
    split = urllib.parse.urlsplit(str(url))
    if split.query:
        segments.append(split.query)

    merged_dict_mode = isinstance(session_params, dict) and isinstance(call_params, dict)
    if merged_dict_mode:
        combined = {**session_params, **call_params}
        pairs = _to_pairs(combined)
        if isinstance(pairs, list) and pairs:
            segments.append(urllib.parse.urlencode(pairs, doseq=True))
    else:
        for part in (session_params, call_params):
            parsed = _to_pairs(part)
            if isinstance(parsed, str) and parsed:
                segments.append(parsed)
            elif isinstance(parsed, list) and parsed:
                segments.append(urllib.parse.urlencode(parsed, doseq=True))

    query = "&".join(s for s in segments if s)
    return urllib.parse.urlunsplit((split.scheme, split.netloc, split.path, query, split.fragment))


def _set_header_ci(target: dict[str, str], key: str, value: str | None) -> None:
    lower = key.lower()
    for existing in list(target.keys()):
        if existing.lower() == lower:
            del target[existing]
    if value is not None:
        target[key] = value


def _has_header_ci(target: dict[str, str], key: str) -> bool:
    lower = key.lower()
    return any(k.lower() == lower for k in target)


def build_requests_request_dict(
    method: str,
    url: str,
    *,
    params: Any = None,
    data: Any = None,
    json_data: Any = None,
    headers: Any = None,
    auth: Any = None,
    session: Any = None,
    default_session_headers: dict[str, str] | None = None,
) -> tuple[dict[str, Any], Any]:
    """Build canonical http.request dict for requests calls without default-header noise.

    Returns ``(req_dict, forwarded_data)`` where ``forwarded_data`` replaces any
    consumed file-like ``data`` stream so live requests can still send the bytes.
    """
    session_params = getattr(session, "params", None) if session is not None else None
    final_url = _merge_url_params(url, session_params, params)

    merged_headers: dict[str, str] = {}
    defaults_lower = {k.lower(): v for k, v in (default_session_headers or {}).items()}
    session_headers = getattr(session, "headers", None) if session is not None else None
    if session_headers:
        for k, v in session_headers.items():
            if v is None:
                continue
            ks = str(k)
            vs = str(v)
            if ks.lower() in defaults_lower and vs == defaults_lower[ks.lower()]:
                continue
            _set_header_ci(merged_headers, ks, vs)

    if headers:
        items = headers.items() if hasattr(headers, "items") else headers
        for k, v in items:
            _set_header_ci(merged_headers, str(k), None if v is None else str(v))

    eff_auth = auth if auth is not None else (getattr(session, "auth", None) if session is not None else None)
    if eff_auth is not None and not _has_header_ci(merged_headers, "authorization"):
        user = getattr(eff_auth, "username", None)
        pw = getattr(eff_auth, "password", None)
        if user is None and isinstance(eff_auth, tuple) and len(eff_auth) == 2:
            user, pw = eff_auth
        if user is not None and pw is not None:
            token = base64.b64encode(f"{user}:{pw}".encode("utf-8")).decode("ascii")
            _set_header_ci(merged_headers, "Authorization", f"Basic {token}")

    forwarded_data = data
    body: str | bytes | None = None
    if data is None and json_data is not None:
        body = json.dumps(json_data, allow_nan=False)
        if not _has_header_ci(merged_headers, "content-type"):
            _set_header_ci(merged_headers, "Content-Type", "application/json")
    elif data is not None:
        if isinstance(data, (bytes, bytearray, memoryview, str)):
            body = normalize_http_body(data)
        elif isinstance(data, dict) or (
            isinstance(data, (list, tuple))
            and all(isinstance(item, (list, tuple)) and len(item) == 2 for item in data)
        ):
            body = urllib.parse.urlencode(data, doseq=True)
            if not _has_header_ci(merged_headers, "content-type"):
                _set_header_ci(merged_headers, "Content-Type", "application/x-www-form-urlencoded")
        elif hasattr(data, "read"):
            raw_read = data.read()
            forwarded_data = raw_read
            body = normalize_http_body(raw_read)
        else:
            body = normalize_http_body(str(data))

    req_dict = canonical_http_request_dict(
        method,
        final_url,
        headers=merged_headers or None,
        body=body,
    )
    return req_dict, forwarded_data


class _CaseInsensitiveDict(MutableMapping[str, str]):
    """Minimal case-insensitive header dictionary preserving original casing."""

    def __init__(self, initial: Any = None) -> None:
        self._store: dict[str, tuple[str, str]] = {}
        if initial:
            self.update(initial)

    def __setitem__(self, key: str, value: str) -> None:
        self._store[key.lower()] = (key, str(value))

    def __getitem__(self, key: str) -> str:
        return self._store[key.lower()][1]

    def __delitem__(self, key: str) -> None:
        del self._store[key.lower()]

    def __iter__(self) -> Iterator[str]:
        return (orig_key for orig_key, _ in self._store.values())

    def __len__(self) -> int:
        return len(self._store)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, MutableMapping):
            return {k.lower(): v for k, v in self.items()} == {
                str(k).lower(): v for k, v in other.items()
            }
        return NotImplemented

    def lower_items(self) -> Iterator[tuple[str, str]]:
        return ((k, val) for k, (_, val) in self._store.items())

    def copy(self) -> "_CaseInsensitiveDict":
        return _CaseInsensitiveDict(self._store.values())

    def __repr__(self) -> str:
        return repr(dict(self.items()))


def _build_http_message(headers: dict[str, str]) -> http.client.HTTPMessage:
    msg = http.client.HTTPMessage()
    for k, v in headers.items():
        msg.add_header(str(k), str(v))
    return msg


class _InterceptedUrlopenResponse:
    """Faithful urllib.request.urlopen response backed by canonical http.request output."""

    def __init__(
        self,
        *,
        status: int,
        url: str,
        headers: dict[str, str] | None = None,
        body: str | bytes = b"",
        reason: str = "",
    ) -> None:
        self.status = int(status)
        self.code = self.status
        self.reason = reason or _http_reason(self.status)
        self.msg = self.reason
        self.url = str(url)
        self.headers = _build_http_message(headers or {})
        self._body_bytes = body.encode("utf-8") if isinstance(body, str) else bytes(body)
        self._stream = io.BytesIO(self._body_bytes)

    @classmethod
    def from_result(cls, result: dict[str, Any], fallback_url: str = "") -> "_InterceptedUrlopenResponse":
        return cls(
            status=int(result.get("status", 200)),
            url=str(result.get("url") or fallback_url),
            headers=_normalize_headers_dict(result.get("headers") or {}),
            body=result.get("body", ""),
        )

    def read(self, amt: int | None = -1) -> bytes:
        return self._stream.read(amt)

    def readline(self, limit: int = -1) -> bytes:
        return self._stream.readline(limit)

    def readlines(self, hint: int = -1) -> list[bytes]:
        return self._stream.readlines(hint)

    def __iter__(self) -> Iterator[bytes]:
        return iter(self._stream)

    def __next__(self) -> bytes:
        return next(self._stream)

    def getcode(self) -> int:
        return self.status

    def geturl(self) -> str:
        return self.url

    def info(self) -> http.client.HTTPMessage:
        return self.headers

    def getheader(self, name: str, default: Any = None) -> Any:
        return self.headers.get(name, default)

    def getheaders(self) -> list[tuple[str, str]]:
        return list(self.headers.items())

    @property
    def closed(self) -> bool:
        return self._stream.closed

    def close(self) -> None:
        self._stream.close()

    def __enter__(self) -> "_InterceptedUrlopenResponse":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
        self.close()
        return False


class _InterceptedRequestsResponse:
    """Faithful requests.Response replacement backed by canonical http.request output."""

    def __init__(
        self,
        *,
        status: int,
        url: str,
        headers: dict[str, str] | None = None,
        body: str | bytes = b"",
        reason: str = "",
        requests_mod: Any = None,
    ) -> None:
        self.status_code = int(status)
        self.reason = reason or _http_reason(self.status_code)
        self.url = str(url)
        self.headers = _CaseInsensitiveDict(headers or {})
        self.content = body.encode("utf-8") if isinstance(body, str) else bytes(body)
        self.encoding = self._detect_encoding()
        self.history: list[Any] = []
        self.cookies: dict[str, str] = {}
        self.is_redirect = self.status_code in (301, 302, 303, 307, 308)
        self._requests_mod = requests_mod
        self._closed = False

    def _detect_encoding(self) -> str:
        ct = self.headers.get("Content-Type", "")
        match = re.search(r"charset=([^\s;\"']+)", ct, re.IGNORECASE)
        if match:
            return match.group(1).strip()
        return "utf-8"

    @classmethod
    def from_result(
        cls,
        result: dict[str, Any],
        fallback_url: str = "",
        *,
        requests_mod: Any = None,
    ) -> "_InterceptedRequestsResponse":
        return cls(
            status=int(result.get("status", 200)),
            url=str(result.get("url") or fallback_url),
            headers=_normalize_headers_dict(result.get("headers") or {}),
            body=result.get("body", ""),
            requests_mod=requests_mod,
        )

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 400

    @property
    def text(self) -> str:
        try:
            return self.content.decode(self.encoding or "utf-8", errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")

    def json(self, **kwargs: Any) -> Any:
        try:
            return json.loads(self.text, **kwargs)
        except ValueError as exc:
            err_cls = getattr(self._requests_mod, "JSONDecodeError", None)
            if err_cls is not None:
                raise err_cls(str(exc), self.text, getattr(exc, "pos", 0)) from exc
            raise

    def raise_for_status(self) -> None:
        if 400 <= self.status_code < 500:
            msg = f"{self.status_code} Client Error: {self.reason} for url: {self.url}"
        elif 500 <= self.status_code < 600:
            msg = f"{self.status_code} Server Error: {self.reason} for url: {self.url}"
        else:
            return
        err_cls = getattr(self._requests_mod, "HTTPError", None)
        if isinstance(err_cls, type) and issubclass(err_cls, Exception):
            raise err_cls(msg, response=self)
        raise RuntimeError(msg)

    def iter_content(self, chunk_size: int | None = 1, decode_unicode: bool = False) -> Iterator[bytes | str]:
        data: bytes | str = self.text if decode_unicode else self.content
        if not chunk_size or chunk_size <= 0:
            if data:
                yield data
            return
        for idx in range(0, len(data), chunk_size):
            yield data[idx : idx + chunk_size]

    def iter_lines(self, decode_unicode: bool = False) -> Iterator[bytes | str]:
        data: bytes | str = self.text if decode_unicode else self.content
        for line in data.splitlines():
            yield line

    def close(self) -> None:
        self._closed = True

    def __enter__(self) -> "_InterceptedRequestsResponse":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
        self.close()
        return False


def _build_hybrid_exception(name: str, msg: str, base_a: type[Exception], base_b: type[Exception]) -> Exception:
    cls = type(name, (base_a, base_b), {"__str__": Exception.__str__})
    return cls(msg)


def build_http_exception(
    value: Any,
    *,
    api: str = "urllib",
    url: str = "",
    requests_mod: Any = None,
) -> Exception:
    """Construct an API-faithful exception from a canonical rejected http.request payload."""
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        msg = str(value)
        if api == "requests" and requests_mod is not None:
            return requests_mod.RequestException(msg)
        return urllib.error.URLError(msg)

    name = value["name"]
    msg = str(value.get("message", ""))

    if api == "urllib":
        if name == "HTTPError":
            match = re.match(r"^HTTP Error (\d+):\s*(.*)$", msg)
            code = int(match.group(1)) if match else 500
            reason = match.group(2) if match else msg
            return urllib.error.HTTPError(
                url,
                code,
                reason,
                _build_http_message({}),
                io.BytesIO(b""),
            )
        if name == "URLError":
            reason = msg[len("<urlopen error ") : -1] if msg.startswith("<urlopen error ") and msg.endswith(">") else msg
            return urllib.error.URLError(reason)
        if name in ("TimeoutError", "ConnectionError"):
            builtin_cls = getattr(builtins, name)
            return _build_hybrid_exception(name, msg, urllib.error.URLError, builtin_cls)
        builtin_cls = getattr(builtins, name, None)
        if isinstance(builtin_cls, type) and issubclass(builtin_cls, Exception):
            return builtin_cls(msg)
        return type(name, (urllib.error.URLError,), {"__str__": Exception.__str__})(msg)

    # api == "requests"
    req_exc_base = getattr(requests_mod, "RequestException", OSError) if requests_mod is not None else OSError
    if name == "RequestException":
        return req_exc_base(msg)
    if name == "TimeoutError":
        timeout_base = getattr(requests_mod, "Timeout", req_exc_base)
        return _build_hybrid_exception("TimeoutError", msg, timeout_base, builtins.TimeoutError)
    if name == "ConnectionError":
        conn_base = getattr(requests_mod, "ConnectionError", req_exc_base)
        return _build_hybrid_exception("ConnectionError", msg, conn_base, builtins.ConnectionError)
    if requests_mod is not None:
        mod_cls = getattr(requests_mod, name, None) or getattr(
            getattr(requests_mod, "exceptions", None), name, None
        )
        if isinstance(mod_cls, type) and issubclass(mod_cls, Exception):
            return mod_cls(msg)
    builtin_cls = getattr(builtins, name, None)
    if isinstance(builtin_cls, type) and issubclass(builtin_cls, Exception):
        return builtin_cls(msg)
    return type(name, (req_exc_base,), {})(msg)


def _urlopen_from_result(res: Any, fallback_url: str) -> _InterceptedUrlopenResponse:
    if not isinstance(res, dict):
        raise RuntimeError(f"Expected dict result from http.request, got {type(res).__name__}")
    resp = _InterceptedUrlopenResponse.from_result(res, fallback_url=fallback_url)
    if resp.status >= 400:
        raise urllib.error.HTTPError(
            resp.url,
            resp.status,
            resp.reason,
            resp.headers,
            io.BytesIO(resp._body_bytes),
        )
    return resp


def install_fallback_requests(
    session_request_fn: Callable[..., _InterceptedRequestsResponse],
) -> types.ModuleType:
    """Install a lightweight requests module hierarchy in sys.modules."""
    mod = types.ModuleType("requests")
    exc_mod = types.ModuleType("requests.exceptions")
    api_mod = types.ModuleType("requests.api")
    sess_mod = types.ModuleType("requests.sessions")
    struct_mod = types.ModuleType("requests.structures")

    class RequestException(OSError):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.response = kwargs.pop("response", None)
            self.request = kwargs.pop("request", None)
            super().__init__(*args)

    class HTTPError(RequestException):
        pass

    class ConnectionError(RequestException):
        pass

    class Timeout(RequestException):
        pass

    class ConnectTimeout(ConnectionError, Timeout):
        pass

    class ReadTimeout(Timeout):
        pass

    class TooManyRedirects(RequestException):
        pass

    class URLRequired(RequestException):
        pass

    class JSONDecodeError(RequestException, ValueError):
        def __init__(self, msg: str = "", doc: str = "", pos: int = 0) -> None:
            ValueError.__init__(self, msg)
            RequestException.__init__(self, msg)
            self.msg = msg
            self.doc = doc
            self.pos = pos

    for exc_cls in (
        RequestException,
        HTTPError,
        ConnectionError,
        Timeout,
        ConnectTimeout,
        ReadTimeout,
        TooManyRedirects,
        URLRequired,
        JSONDecodeError,
    ):
        setattr(exc_mod, exc_cls.__name__, exc_cls)
        setattr(mod, exc_cls.__name__, exc_cls)

    class Session:
        def __init__(self) -> None:
            self.headers = _CaseInsensitiveDict()
            self.params: dict[str, Any] = {}
            self.cookies: dict[str, str] = {}
            self.auth: Any = None
            self.timeout: Any = None

        def request(self, method: str, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
            return session_request_fn(self, method, url, **kwargs)

        def get(self, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
            kwargs.setdefault("allow_redirects", True)
            return self.request("GET", url, **kwargs)

        def options(self, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
            kwargs.setdefault("allow_redirects", True)
            return self.request("OPTIONS", url, **kwargs)

        def head(self, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
            kwargs.setdefault("allow_redirects", False)
            return self.request("HEAD", url, **kwargs)

        def post(self, url: str, data: Any = None, json: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
            return self.request("POST", url, data=data, json=json, **kwargs)

        def put(self, url: str, data: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
            return self.request("PUT", url, data=data, **kwargs)

        def patch(self, url: str, data: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
            return self.request("PATCH", url, data=data, **kwargs)

        def delete(self, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
            return self.request("DELETE", url, **kwargs)

        def close(self) -> None:
            return None

        def __enter__(self) -> "Session":
            return self

        def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
            self.close()
            return False

    def request(method: str, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
        with Session() as s:
            return s.request(method, url, **kwargs)

    def get(url: str, params: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
        return request("GET", url, params=params, **kwargs)

    def options(url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
        return request("OPTIONS", url, **kwargs)

    def head(url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
        kwargs.setdefault("allow_redirects", False)
        return request("HEAD", url, **kwargs)

    def post(url: str, data: Any = None, json: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
        return request("POST", url, data=data, json=json, **kwargs)

    def put(url: str, data: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
        return request("PUT", url, data=data, **kwargs)

    def patch(url: str, data: Any = None, **kwargs: Any) -> _InterceptedRequestsResponse:
        return request("PATCH", url, data=data, **kwargs)

    def delete(url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
        return request("DELETE", url, **kwargs)

    for fn in (request, get, options, head, post, put, patch, delete):
        setattr(api_mod, fn.__name__, fn)
        setattr(mod, fn.__name__, fn)

    sess_mod.Session = Session  # type: ignore[attr-defined]
    sess_mod.session = Session  # type: ignore[attr-defined]
    struct_mod.CaseInsensitiveDict = _CaseInsensitiveDict  # type: ignore[attr-defined]
    mod.Session = Session  # type: ignore[attr-defined]
    mod.session = Session  # type: ignore[attr-defined]
    mod.Response = _InterceptedRequestsResponse  # type: ignore[attr-defined]
    mod.exceptions = exc_mod  # type: ignore[attr-defined]
    mod.api = api_mod  # type: ignore[attr-defined]
    mod.sessions = sess_mod  # type: ignore[attr-defined]
    mod.structures = struct_mod  # type: ignore[attr-defined]

    sys.modules["requests"] = mod
    sys.modules["requests.exceptions"] = exc_mod
    sys.modules["requests.api"] = api_mod
    sys.modules["requests.sessions"] = sess_mod
    sys.modules["requests.structures"] = struct_mod
    return mod


def _patch_requests_module(
    requests_mod: Any,
    session_request_fn: Callable[..., _InterceptedRequestsResponse],
) -> None:
    requests_mod.Session.request = session_request_fn

    def _api_request(method: str, url: str, **kwargs: Any) -> _InterceptedRequestsResponse:
        with requests_mod.sessions.Session() as sess:
            return sess.request(method=method, url=url, **kwargs)

    requests_mod.api.request = _api_request
    requests_mod.request = _api_request


def _make_replay_session_request(
    invoke_fn: Callable[[str, list[Any], Callable[[Any], Exception] | None], Any],
    get_requests_mod: Callable[[], Any],
    default_headers: dict[str, str] | None = None,
) -> Callable[..., _InterceptedRequestsResponse]:
    def _replay_session_request(
        self: Any,
        method: str,
        url: str,
        params: Any = None,
        data: Any = None,
        headers: Any = None,
        cookies: Any = None,  # noqa: ARG001
        files: Any = None,  # noqa: ARG001
        auth: Any = None,
        timeout: Any = None,  # noqa: ARG001
        allow_redirects: bool = True,  # noqa: ARG001
        proxies: Any = None,  # noqa: ARG001
        hooks: Any = None,  # noqa: ARG001
        stream: Any = None,  # noqa: ARG001
        verify: Any = None,  # noqa: ARG001
        cert: Any = None,  # noqa: ARG001
        json: Any = None,
    ) -> _InterceptedRequestsResponse:
        rmod = get_requests_mod()
        req_dict, _ = build_requests_request_dict(
            method,
            url,
            params=params,
            data=data,
            json_data=json,
            headers=headers,
            auth=auth,
            session=self,
            default_session_headers=default_headers,
        )
        res = invoke_fn(
            "http.request",
            [req_dict],
            lambda err_val: build_http_exception(
                err_val, api="requests", url=req_dict["url"], requests_mod=rmod
            ),
        )
        if not isinstance(res, dict):
            raise RuntimeError(f"Expected dict result from http.request, got {type(res).__name__}")
        return _InterceptedRequestsResponse.from_result(
            res, fallback_url=req_dict["url"], requests_mod=rmod
        )

    return _replay_session_request


def install_replay_http_hooks(
    invoke_fn: Callable[[str, list[Any], Callable[[Any], Exception] | None], Any],
    *,
    enable_urllib: bool = True,
    enable_requests: bool = True,
    force_fallback_requests: bool = False,
) -> None:
    """Install deterministic replay hooks for urllib.request.urlopen and requests."""
    if enable_urllib:
        def _replay_urlopen(
            url: Any,
            data: Any = None,
            timeout: Any = socket._GLOBAL_DEFAULT_TIMEOUT,  # noqa: ARG001
            *,
            context: Any = None,  # noqa: ARG001
        ) -> _InterceptedUrlopenResponse:
            req_dict = build_urllib_request_dict(url, data=data)
            res = invoke_fn(
                "http.request",
                [req_dict],
                lambda err_val: build_http_exception(err_val, api="urllib", url=req_dict["url"]),
            )
            return _urlopen_from_result(res, req_dict["url"])

        urllib.request.urlopen = _replay_urlopen  # type: ignore[assignment]

    if enable_requests:
        requests_mod: Any = None
        if not force_fallback_requests:
            try:
                import requests as _real_requests  # type: ignore[import-untyped]
                requests_mod = _real_requests
            except ImportError:
                requests_mod = None

        if requests_mod is not None:
            default_headers = dict(requests_mod.utils.default_headers())
            _patch_requests_module(
                requests_mod,
                _make_replay_session_request(invoke_fn, lambda: requests_mod, default_headers),
            )
        else:
            fallback_holder: list[types.ModuleType] = []
            handler = _make_replay_session_request(invoke_fn, lambda: fallback_holder[0], None)
            fallback_holder.append(install_fallback_requests(handler))


def _effective_timeout(timeout: Any, default_timeout: float) -> float:
    if timeout is None or timeout is socket._GLOBAL_DEFAULT_TIMEOUT:
        return default_timeout
    if isinstance(timeout, tuple) and len(timeout) == 2:
        vals = [float(x) for x in timeout if x is not None]
        return min(default_timeout, max(vals)) if vals else default_timeout
    try:
        return min(default_timeout, float(timeout))
    except (TypeError, ValueError):
        return default_timeout


def _read_bounded_urllib(resp: Any, max_bytes: int) -> bytes:
    chunk = resp.read(max_bytes + 1)
    return bytes(chunk) if chunk is not None else b""


def _read_bounded_requests(resp: Any, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for part in resp.iter_content(chunk_size=8192):
        if not part:
            continue
        chunks.append(part)
        total += len(part)
        if total > max_bytes:
            break
    return b"".join(chunks)


def install_live_http_hooks(
    recorded_calls: list[dict[str, Any]],
    *,
    max_body_bytes: int = MAX_HTTP_BODY_BYTES,
    default_timeout: float = DEFAULT_HTTP_TIMEOUT_S,
    enable_urllib: bool = True,
    enable_requests: bool = True,
    force_fallback_requests: bool = False,
    io_depth: list[int] | None = None,
) -> None:
    """Install live-capture HTTP hooks that execute once and record canonical calls."""
    orig_urlopen = urllib.request.urlopen

    def _enter_io() -> None:
        if io_depth is not None:
            io_depth[0] += 1

    def _exit_io() -> None:
        if io_depth is not None:
            io_depth[0] -= 1

    def _record_fulfilled(req_dict: dict[str, Any], res_dict: dict[str, Any]) -> None:
        recorded_calls.append({
            "operation": "http.request",
            "arguments": encode_readable([req_dict]),
            "status": "fulfilled",
            "result": encode_readable(res_dict),
        })

    def _record_rejected(req_dict: dict[str, Any], exc: BaseException) -> dict[str, str]:
        err_dict = encode_exception(exc)
        recorded_calls.append({
            "operation": "http.request",
            "arguments": encode_readable([req_dict]),
            "status": "rejected",
            "result": err_dict,
        })
        return err_dict

    if enable_urllib:
        def _live_urlopen(
            url: Any,
            data: Any = None,
            timeout: Any = socket._GLOBAL_DEFAULT_TIMEOUT,
            *,
            context: Any = None,
        ) -> _InterceptedUrlopenResponse:
            req_dict = build_urllib_request_dict(url, data=data)
            eff_timeout = _effective_timeout(timeout, default_timeout)
            _enter_io()
            try:
                kwargs: dict[str, Any] = {"data": data, "timeout": eff_timeout}
                if context is not None:
                    kwargs["context"] = context
                with orig_urlopen(url, **kwargs) as real_resp:
                    raw = _read_bounded_urllib(real_resp, max_body_bytes)
                    res_dict = {
                        "status": int(getattr(real_resp, "status", None) or real_resp.getcode() or 200),
                        "url": str(real_resp.geturl() or req_dict["url"]),
                        "headers": _normalize_headers_dict(real_resp.headers),
                        "body": normalize_http_body(raw, max_bytes=max_body_bytes),
                    }
                _record_fulfilled(req_dict, res_dict)
                return _InterceptedUrlopenResponse.from_result(res_dict, fallback_url=req_dict["url"])
            except urllib.error.HTTPError as exc:
                code = int(getattr(exc, "code", 500))
                if code >= 400:
                    try:
                        raw = _read_bounded_urllib(exc, max_body_bytes)
                    except Exception:
                        raw = b""
                    finally:
                        try:
                            exc.close()
                        except Exception:
                            pass
                    res_dict = {
                        "status": code,
                        "url": str(exc.geturl() or req_dict["url"]),
                        "headers": _normalize_headers_dict(exc.headers),
                        "body": normalize_http_body(raw, max_bytes=max_body_bytes),
                    }
                    _record_fulfilled(req_dict, res_dict)
                    return _urlopen_from_result(res_dict, req_dict["url"])
                try:
                    exc.close()
                except Exception:
                    pass
                err_dict = _record_rejected(req_dict, exc)
                raise build_http_exception(err_dict, api="urllib", url=req_dict["url"]) from exc
            except Exception as exc:
                err_dict = _record_rejected(req_dict, exc)
                raise build_http_exception(err_dict, api="urllib", url=req_dict["url"]) from exc
            finally:
                _exit_io()

        urllib.request.urlopen = _live_urlopen  # type: ignore[assignment]

    if enable_requests:
        requests_mod: Any = None
        if not force_fallback_requests:
            _enter_io()
            try:
                import requests as _real_requests  # type: ignore[import-untyped]
                requests_mod = _real_requests
            except ImportError:
                requests_mod = None
            finally:
                _exit_io()

        if requests_mod is not None:
            orig_session_request = requests_mod.Session.request
            default_headers = dict(requests_mod.utils.default_headers())

            def _live_session_request(
                self: Any,
                method: str,
                url: str,
                params: Any = None,
                data: Any = None,
                headers: Any = None,
                cookies: Any = None,
                files: Any = None,
                auth: Any = None,
                timeout: Any = None,
                allow_redirects: bool = True,
                proxies: Any = None,
                hooks: Any = None,
                stream: Any = None,  # noqa: ARG001
                verify: Any = None,
                cert: Any = None,
                json: Any = None,
            ) -> _InterceptedRequestsResponse:
                req_dict, forwarded_data = build_requests_request_dict(
                    method,
                    url,
                    params=params,
                    data=data,
                    json_data=json,
                    headers=headers,
                    auth=auth,
                    session=self,
                    default_session_headers=default_headers,
                )
                eff_timeout = _effective_timeout(timeout, default_timeout)
                _enter_io()
                try:
                    call_kwargs: dict[str, Any] = {
                        "params": params,
                        "data": forwarded_data,
                        "headers": headers,
                        "cookies": cookies,
                        "files": files,
                        "auth": auth,
                        "timeout": eff_timeout,
                        "allow_redirects": allow_redirects,
                        "proxies": proxies,
                        "hooks": hooks,
                        "stream": True,
                        "json": json,
                    }
                    if verify is not None:
                        call_kwargs["verify"] = verify
                    if cert is not None:
                        call_kwargs["cert"] = cert
                    with orig_session_request(self, method, url, **call_kwargs) as real_resp:
                        raw = _read_bounded_requests(real_resp, max_body_bytes)
                        res_dict = {
                            "status": int(real_resp.status_code),
                            "url": str(real_resp.url or req_dict["url"]),
                            "headers": _normalize_headers_dict(real_resp.headers),
                            "body": normalize_http_body(raw, max_bytes=max_body_bytes),
                        }
                    _record_fulfilled(req_dict, res_dict)
                    return _InterceptedRequestsResponse.from_result(
                        res_dict, fallback_url=req_dict["url"], requests_mod=requests_mod
                    )
                except Exception as exc:
                    err_dict = _record_rejected(req_dict, exc)
                    raise build_http_exception(
                        err_dict, api="requests", url=req_dict["url"], requests_mod=requests_mod
                    ) from exc
                finally:
                    _exit_io()

            _patch_requests_module(requests_mod, _live_session_request)
        else:
            fallback_holder: list[types.ModuleType] = []

            def _live_fallback_session_request(
                self: Any,
                method: str,
                url: str,
                params: Any = None,
                data: Any = None,
                headers: Any = None,
                cookies: Any = None,  # noqa: ARG001
                files: Any = None,  # noqa: ARG001
                auth: Any = None,
                timeout: Any = None,
                allow_redirects: bool = True,  # noqa: ARG001
                proxies: Any = None,  # noqa: ARG001
                hooks: Any = None,  # noqa: ARG001
                stream: Any = None,  # noqa: ARG001
                verify: Any = None,  # noqa: ARG001
                cert: Any = None,  # noqa: ARG001
                json: Any = None,
            ) -> _InterceptedRequestsResponse:
                rmod = fallback_holder[0]
                req_dict, _ = build_requests_request_dict(
                    method,
                    url,
                    params=params,
                    data=data,
                    json_data=json,
                    headers=headers,
                    auth=auth,
                    session=self,
                )
                eff_timeout = _effective_timeout(timeout, default_timeout)
                raw_body = req_dict.get("body")
                body_bytes = (
                    raw_body.encode("utf-8")
                    if isinstance(raw_body, str)
                    else (bytes(raw_body) if raw_body is not None else None)
                )
                ureq = urllib.request.Request(
                    req_dict["url"],
                    data=body_bytes,
                    headers=req_dict.get("headers") or {},
                    method=req_dict["method"],
                )
                _enter_io()
                try:
                    with orig_urlopen(ureq, timeout=eff_timeout) as real_resp:
                        raw = _read_bounded_urllib(real_resp, max_body_bytes)
                        res_dict = {
                            "status": int(getattr(real_resp, "status", None) or real_resp.getcode() or 200),
                            "url": str(real_resp.geturl() or req_dict["url"]),
                            "headers": _normalize_headers_dict(real_resp.headers),
                            "body": normalize_http_body(raw, max_bytes=max_body_bytes),
                        }
                    _record_fulfilled(req_dict, res_dict)
                    return _InterceptedRequestsResponse.from_result(
                        res_dict, fallback_url=req_dict["url"], requests_mod=rmod
                    )
                except urllib.error.HTTPError as exc:
                    try:
                        raw = _read_bounded_urllib(exc, max_body_bytes)
                    except Exception:
                        raw = b""
                    finally:
                        try:
                            exc.close()
                        except Exception:
                            pass
                    res_dict = {
                        "status": int(getattr(exc, "code", 500)),
                        "url": str(exc.geturl() or req_dict["url"]),
                        "headers": _normalize_headers_dict(exc.headers),
                        "body": normalize_http_body(raw, max_bytes=max_body_bytes),
                    }
                    _record_fulfilled(req_dict, res_dict)
                    return _InterceptedRequestsResponse.from_result(
                        res_dict, fallback_url=req_dict["url"], requests_mod=rmod
                    )
                except Exception as exc:
                    err_dict = _record_rejected(req_dict, exc)
                    raise build_http_exception(
                        err_dict, api="requests", url=req_dict["url"], requests_mod=rmod
                    ) from exc
                finally:
                    _exit_io()

            fallback_holder.append(install_fallback_requests(_live_fallback_session_request))
