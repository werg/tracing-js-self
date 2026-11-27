"""Readable Python data graph codec and canonical structural+aliasing fingerprint.

Mirrors encodeReadable / decodeReadable / describeGraph / realizeGraph from
src/training/tinker-execution.js and src/training/graph.js for Python values.
"""

from __future__ import annotations

import base64
import dataclasses
import datetime
import decimal
import enum
import functools
import io
import math
import pathlib
import types
from typing import Any

MAX_DEPTH = 64
MAX_NODES = 16384

_ORIG_DATETIME = datetime.datetime
_ORIG_DATE = datetime.date
_ORIG_TIMEDELTA = datetime.timedelta
_ORIG_DECIMAL = decimal.Decimal
_ORIG_PURE_PATH = pathlib.PurePath

_NON_PLAIN_OBJECT_TYPES = (
    type,
    types.ModuleType,
    io.IOBase,
    types.FunctionType,
    types.MethodType,
    types.BuiltinFunctionType,
    types.BuiltinMethodType,
    types.GeneratorType,
    types.CoroutineType,
    types.AsyncGeneratorType,
    types.CodeType,
    types.FrameType,
    types.TracebackType,
    list,
    dict,
    set,
    frozenset,
    tuple,
    str,
    bytes,
    int,
    float,
    bool,
    complex,
    BaseException,
    enum.Enum,
    _ORIG_DATETIME,
    _ORIG_DATE,
    _ORIG_TIMEDELTA,
    _ORIG_DECIMAL,
    _ORIG_PURE_PATH,
)


def _demand(condition: bool, message: str) -> None:
    if not condition:
        raise TypeError(message)


def _pointer(path: str, key: Any) -> str:
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


def _is_neg_zero(value: float) -> bool:
    return value == 0.0 and math.copysign(1.0, value) < 0.0


def _is_plain_dataclass(value: Any) -> bool:
    return dataclasses.is_dataclass(value) and not isinstance(value, type)


def _get_plain_object_dict(value: Any) -> dict[str, Any] | None:
    if isinstance(value, _NON_PLAIN_OBJECT_TYPES) or _is_plain_dataclass(value) or callable(value):
        return None
    try:
        raw_dict = object.__getattribute__(value, "__dict__")
    except AttributeError:
        return None
    if type(raw_dict) is not dict:
        return None
    return raw_dict


@functools.lru_cache(maxsize=512)
def _decoded_object_cls(cls_name: str) -> type:
    return type(cls_name, (), {})


def _create_plain_object(cls_name: str) -> Any:
    if cls_name == "SimpleNamespace":
        return types.SimpleNamespace()
    return _decoded_object_cls(cls_name)()


@functools.lru_cache(maxsize=1024)
def _cached_enum_member(cls_name: str, member_name: str, val_type: type, cache_val: Any, raw_val: Any) -> enum.Enum:
    del val_type, cache_val
    return enum.Enum(cls_name, [(member_name, raw_val)])[member_name]


def _reconstruct_enum(cls_name: str, member_name: str, value: Any) -> enum.Enum:
    try:
        cache_val: Any = value
        if type(value) is float:
            if math.isnan(value):
                cache_val = ("nan",)
            elif _is_neg_zero(value):
                cache_val = ("-0",)
        return _cached_enum_member(cls_name, member_name, type(value), cache_val, value)
    except TypeError:
        try:
            return enum.Enum(cls_name, [(member_name, value)])[member_name]
        except Exception as exc:
            raise TypeError(f"Invalid enum value: {cls_name}.{member_name}") from exc
    except Exception as exc:
        raise TypeError(f"Invalid enum value: {cls_name}.{member_name}") from exc


def encode_exception(exc: BaseException) -> dict[str, str]:
    """Encode a Python exception as {name, message} without arbitrary side effects."""
    exc_type = type(exc)
    name = exc_type.__name__
    try:
        message = str(exc)
    except Exception:
        message = ""
    return {"name": name, "message": message}


def _canonical_set_sort_key(value: Any, depth: int = 0) -> tuple:
    _demand(depth <= MAX_DEPTH, "Readable value budget exceeded")
    if value is None:
        return (0, 0)
    if isinstance(value, enum.Enum):
        return (
            14,
            type(value).__name__,
            value.name,
            _canonical_set_sort_key(value.value, depth + 1),
        )
    if isinstance(value, bool):
        return (1, 1 if value else 0)
    if isinstance(value, int):
        return (2, value)
    if isinstance(value, float):
        if math.isnan(value):
            return (3, 0, 0.0)
        if math.isinf(value):
            return (3, 1 if value < 0 else 4, 0.0)
        if _is_neg_zero(value):
            return (3, 2, 0.0)
        return (3, 3, value)
    if isinstance(value, str):
        return (4, value)
    if isinstance(value, bytes):
        return (5, value)
    if isinstance(value, tuple):
        return (6, tuple(_canonical_set_sort_key(item, depth + 1) for item in value))
    if isinstance(value, frozenset):
        return (7, tuple(sorted(_canonical_set_sort_key(item, depth + 1) for item in value)))
    if isinstance(value, complex):
        return (
            8,
            _canonical_set_sort_key(value.real, depth + 1),
            _canonical_set_sort_key(value.imag, depth + 1),
        )
    if isinstance(value, _ORIG_DECIMAL):
        return (9, str(value))
    if isinstance(value, _ORIG_DATETIME):
        return (10, 0 if value.tzinfo is None else 1, value.isoformat())
    if isinstance(value, _ORIG_DATE):
        return (11, value.isoformat())
    if isinstance(value, _ORIG_TIMEDELTA):
        return (12, value.days, value.seconds, value.microseconds)
    if isinstance(value, _ORIG_PURE_PATH):
        return (13, str(value))
    raise TypeError(f"Unsupported set element type: {type(value).__name__}")


def encode_readable(value: Any, *, allow_exceptions: bool = False) -> Any:
    """Encode a Python data graph into JSON-compatible readable form with $py tags."""
    seen: dict[int, str] = {}
    keepalive: list[Any] = []
    nodes = 0

    def visit(item: Any, path: str, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        _demand(depth <= MAX_DEPTH and nodes <= MAX_NODES, "Readable value budget exceeded")

        if item is None:
            return None
        if isinstance(item, enum.Enum):
            return {
                "$py": "enum",
                "class": type(item).__name__,
                "name": item.name,
                "value": visit(item.value, _pointer(path, "value"), depth + 1),
            }
        if isinstance(item, bool):
            return item
        if isinstance(item, int):
            return item
        if isinstance(item, float):
            if math.isnan(item):
                return {"$py": "NaN"}
            if _is_neg_zero(item):
                return {"$py": "-0"}
            if math.isinf(item):
                return {"$py": "Infinity" if item > 0 else "-Infinity"}
            return item
        if isinstance(item, complex):
            return {
                "$py": "complex",
                "real": visit(item.real, _pointer(path, "real"), depth + 1),
                "imag": visit(item.imag, _pointer(path, "imag"), depth + 1),
            }
        if isinstance(item, str):
            return item
        if isinstance(item, bytes):
            return {"$py": "bytes", "b64": base64.b64encode(item).decode("ascii")}
        if isinstance(item, _ORIG_DECIMAL):
            return {"$py": "decimal", "value": str(item)}
        if isinstance(item, _ORIG_DATETIME):
            return {"$py": "datetime", "iso": item.isoformat()}
        if isinstance(item, _ORIG_DATE):
            return {"$py": "date", "iso": item.isoformat()}
        if isinstance(item, _ORIG_TIMEDELTA):
            return {
                "$py": "timedelta",
                "days": item.days,
                "seconds": item.seconds,
                "microseconds": item.microseconds,
            }
        if isinstance(item, _ORIG_PURE_PATH):
            return {"$py": "path", "value": str(item)}

        if isinstance(item, tuple):
            return {
                "$py": "tuple",
                "items": [visit(child, _pointer(path, idx), depth + 1) for idx, child in enumerate(item)],
            }
        if isinstance(item, frozenset):
            ordered_fs = sorted(item, key=_canonical_set_sort_key)
            return {
                "$py": "frozenset",
                "items": [visit(child, _pointer(path, idx), depth + 1) for idx, child in enumerate(ordered_fs)],
            }

        if isinstance(item, BaseException):
            _demand(allow_exceptions, "Only data values cross the training boundary")
            return encode_exception(item)

        if _is_plain_dataclass(item):
            obj_id = id(item)
            if obj_id in seen:
                return {"$py": "ref", "path": seen[obj_id]}
            seen[obj_id] = path
            keepalive.append(item)
            fields = {f.name: getattr(item, f.name) for f in dataclasses.fields(item)}
            if "$py" in fields:
                entries = [
                    [
                        visit(k, _pointer(_pointer(_pointer(path, "entries"), idx), 0), depth + 1),
                        visit(v, _pointer(_pointer(_pointer(path, "entries"), idx), 1), depth + 1),
                    ]
                    for idx, (k, v) in enumerate(fields.items())
                ]
                return {"$py": "dict", "entries": entries}
            return {k: visit(v, _pointer(path, k), depth + 1) for k, v in fields.items()}

        if isinstance(item, list):
            obj_id = id(item)
            if obj_id in seen:
                return {"$py": "ref", "path": seen[obj_id]}
            seen[obj_id] = path
            keepalive.append(item)
            return [visit(child, _pointer(path, idx), depth + 1) for idx, child in enumerate(item)]

        if isinstance(item, dict):
            obj_id = id(item)
            if obj_id in seen:
                return {"$py": "ref", "path": seen[obj_id]}
            seen[obj_id] = path
            keepalive.append(item)
            plain_str_keys = all(type(k) is str for k in item.keys()) and "$py" not in item
            if plain_str_keys:
                return {k: visit(v, _pointer(path, k), depth + 1) for k, v in item.items()}
            entries = [
                [
                    visit(k, _pointer(_pointer(_pointer(path, "entries"), idx), 0), depth + 1),
                    visit(v, _pointer(_pointer(_pointer(path, "entries"), idx), 1), depth + 1),
                ]
                for idx, (k, v) in enumerate(item.items())
            ]
            return {"$py": "dict", "entries": entries}

        if isinstance(item, set):
            obj_id = id(item)
            if obj_id in seen:
                return {"$py": "ref", "path": seen[obj_id]}
            seen[obj_id] = path
            keepalive.append(item)
            ordered = sorted(item, key=_canonical_set_sort_key)
            return {
                "$py": "set",
                "items": [visit(child, _pointer(path, idx), depth + 1) for idx, child in enumerate(ordered)],
            }

        raw_dict = _get_plain_object_dict(item)
        if raw_dict is not None:
            _demand(
                all(type(k) is str for k in dict.keys(raw_dict)),
                "Plain object attributes must have string keys",
            )
            obj_id = id(item)
            if obj_id in seen:
                return {"$py": "ref", "path": seen[obj_id]}
            seen[obj_id] = path
            keepalive.append(item)
            attrs_out = {
                k: visit(v, _pointer(_pointer(path, "attrs"), k), depth + 1)
                for k, v in dict.items(raw_dict)
            }
            return {
                "$py": "object",
                "class": type(item).__name__,
                "attrs": attrs_out,
            }

        raise TypeError(f"Only data values cross the training boundary (got {type(item).__name__})")

    return visit(value, "", 0)


class _RefMarker:
    __slots__ = ("path",)

    def __init__(self, path: str) -> None:
        self.path = path


class _TupleBox:
    __slots__ = ("items",)

    def __init__(self, items: list[Any]) -> None:
        self.items = items


class _FrozensetBox:
    __slots__ = ("items",)

    def __init__(self, items: list[Any]) -> None:
        self.items = items


class _EnumBox:
    __slots__ = ("cls_name", "member_name", "value")

    def __init__(self, cls_name: str, member_name: str, value: Any) -> None:
        self.cls_name = cls_name
        self.member_name = member_name
        self.value = value


class _SetBox:
    __slots__ = ("target", "items")

    def __init__(self, target: set[Any], items: list[Any]) -> None:
        self.target = target
        self.items = items


class _DictPending:
    __slots__ = ("target", "pairs")

    def __init__(self, target: dict[Any, Any], pairs: list[tuple[Any, Any]]) -> None:
        self.target = target
        self.pairs = pairs


class _ObjectPending:
    __slots__ = ("target", "pairs")

    def __init__(self, target: Any, pairs: list[tuple[str, Any]]) -> None:
        self.target = target
        self.pairs = pairs


def decode_readable(value: Any) -> Any:
    """Decode readable JSON with $py tags back into a Python data graph."""
    locations: dict[str, Any] = {}
    tuple_boxes: list[_TupleBox] = []
    frozenset_boxes: list[_FrozensetBox] = []
    enum_boxes: list[_EnumBox] = []
    set_boxes: list[_SetBox] = []
    dict_pendings: list[_DictPending] = []
    object_pendings: list[_ObjectPending] = []
    lists: list[list[Any]] = []
    nodes = 0

    def visit(item: Any, path: str, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        _demand(depth <= MAX_DEPTH and nodes <= MAX_NODES, "Readable value budget exceeded")

        if item is None or isinstance(item, (bool, int, float, str)):
            return item

        if isinstance(item, list):
            output: list[Any] = []
            locations[path] = output
            lists.append(output)
            for idx, child in enumerate(item):
                output.append(visit(child, _pointer(path, idx), depth + 1))
            return output

        _demand(isinstance(item, dict), "Expected a JSON data value")

        if "$py" in item:
            tag = item["$py"]
            if tag in ("NaN", "-0", "Infinity", "-Infinity"):
                _demand(len(item) == 1, "Unexpected Python scalar fields")
                if tag == "NaN":
                    return float("nan")
                if tag == "-0":
                    return -0.0
                return float("inf") if tag == "Infinity" else float("-inf")

            if tag == "bytes":
                _demand(len(item) == 2 and isinstance(item.get("b64"), str), "Invalid bytes value")
                try:
                    return base64.b64decode(item["b64"].encode("ascii"), validate=True)
                except Exception as exc:
                    raise TypeError("Invalid base64 in bytes value") from exc

            if tag == "datetime":
                _demand(set(item.keys()) == {"$py", "iso"} and isinstance(item.get("iso"), str), "Invalid datetime value")
                try:
                    return _ORIG_DATETIME.fromisoformat(item["iso"])
                except ValueError as exc:
                    raise TypeError("Invalid ISO datetime string") from exc

            if tag == "date":
                _demand(set(item.keys()) == {"$py", "iso"} and isinstance(item.get("iso"), str), "Invalid date value")
                try:
                    return _ORIG_DATE.fromisoformat(item["iso"])
                except ValueError as exc:
                    raise TypeError("Invalid ISO date string") from exc

            if tag == "timedelta":
                _demand(set(item.keys()) == {"$py", "days", "seconds", "microseconds"}, "Invalid timedelta value")
                days = item["days"]
                seconds = item["seconds"]
                microseconds = item["microseconds"]
                _demand(
                    isinstance(days, int)
                    and not isinstance(days, bool)
                    and isinstance(seconds, int)
                    and not isinstance(seconds, bool)
                    and isinstance(microseconds, int)
                    and not isinstance(microseconds, bool),
                    "Invalid timedelta components",
                )
                try:
                    return _ORIG_TIMEDELTA(days=days, seconds=seconds, microseconds=microseconds)
                except OverflowError as exc:
                    raise TypeError("Timedelta out of range") from exc

            if tag == "decimal":
                _demand(set(item.keys()) == {"$py", "value"} and isinstance(item.get("value"), str), "Invalid decimal value")
                try:
                    return _ORIG_DECIMAL(item["value"])
                except (decimal.InvalidOperation, ValueError) as exc:
                    raise TypeError("Invalid decimal literal") from exc

            if tag == "path":
                _demand(set(item.keys()) == {"$py", "value"} and isinstance(item.get("value"), str), "Invalid path value")
                return pathlib.Path(item["value"])

            if tag == "complex":
                _demand(set(item.keys()) == {"$py", "real", "imag"}, "Invalid complex value")
                real = visit(item["real"], _pointer(path, "real"), depth + 1)
                imag = visit(item["imag"], _pointer(path, "imag"), depth + 1)
                _demand(
                    isinstance(real, (int, float))
                    and not isinstance(real, bool)
                    and isinstance(imag, (int, float))
                    and not isinstance(imag, bool),
                    "Invalid complex components",
                )
                return complex(real, imag)

            if tag == "enum":
                _demand(
                    set(item.keys()) == {"$py", "class", "name", "value"}
                    and isinstance(item.get("class"), str)
                    and len(item["class"]) > 0
                    and isinstance(item.get("name"), str)
                    and len(item["name"]) > 0,
                    "Invalid enum value",
                )
                enum_val = visit(item["value"], _pointer(path, "value"), depth + 1)
                ebox = _EnumBox(item["class"], item["name"], enum_val)
                enum_boxes.append(ebox)
                return ebox

            if tag == "ref":
                _demand(len(item) == 2 and isinstance(item.get("path"), str), "Invalid reference path")
                return _RefMarker(item["path"])

            if tag == "tuple":
                _demand(len(item) == 2 and isinstance(item.get("items"), list), "Invalid tuple value")
                box = _TupleBox([])
                locations[path] = box
                tuple_boxes.append(box)
                for idx, child in enumerate(item["items"]):
                    box.items.append(visit(child, _pointer(path, idx), depth + 1))
                return box

            if tag == "frozenset":
                _demand(len(item) == 2 and isinstance(item.get("items"), list), "Invalid frozenset value")
                fsbox = _FrozensetBox([])
                frozenset_boxes.append(fsbox)
                for idx, child in enumerate(item["items"]):
                    fsbox.items.append(visit(child, _pointer(path, idx), depth + 1))
                return fsbox

            if tag == "set":
                _demand(len(item) == 2 and isinstance(item.get("items"), list), "Invalid set value")
                target_set: set[Any] = set()
                locations[path] = target_set
                box = _SetBox(target_set, [])
                set_boxes.append(box)
                for idx, child in enumerate(item["items"]):
                    box.items.append(visit(child, _pointer(path, idx), depth + 1))
                return target_set

            if tag == "dict":
                _demand(len(item) == 2 and isinstance(item.get("entries"), list), "Invalid dict value")
                target_dict: dict[Any, Any] = {}
                locations[path] = target_dict
                pairs: list[tuple[Any, Any]] = []
                dict_pendings.append(_DictPending(target_dict, pairs))
                for idx, entry in enumerate(item["entries"]):
                    _demand(isinstance(entry, list) and len(entry) == 2, "Invalid dict entry")
                    k = visit(entry[0], _pointer(_pointer(_pointer(path, "entries"), idx), 0), depth + 1)
                    v = visit(entry[1], _pointer(_pointer(_pointer(path, "entries"), idx), 1), depth + 1)
                    pairs.append((k, v))
                return target_dict

            if tag == "object":
                _demand(
                    set(item.keys()) == {"$py", "class", "attrs"}
                    and isinstance(item.get("class"), str)
                    and len(item["class"]) > 0
                    and isinstance(item.get("attrs"), dict),
                    "Invalid object value",
                )
                target_obj = _create_plain_object(item["class"])
                locations[path] = target_obj
                attr_pairs: list[tuple[str, Any]] = []
                object_pendings.append(_ObjectPending(target_obj, attr_pairs))
                for k, child in item["attrs"].items():
                    _demand(isinstance(k, str), "Object attribute names must be strings")
                    attr_pairs.append((k, visit(child, _pointer(_pointer(path, "attrs"), k), depth + 1)))
                return target_obj

            raise TypeError(f"Unknown Python value tag: {tag!r}")

        target_plain: dict[Any, Any] = {}
        locations[path] = target_plain
        plain_pairs: list[tuple[Any, Any]] = []
        dict_pendings.append(_DictPending(target_plain, plain_pairs))
        for k, child in item.items():
            _demand(isinstance(k, str), "Plain JSON object keys must be strings")
            plain_pairs.append((k, visit(child, _pointer(path, k), depth + 1)))
        return target_plain

    root = visit(value, "", 0)

    def resolve_ref(obj: Any) -> Any:
        seen_paths: set[str] = set()
        while isinstance(obj, _RefMarker):
            _demand(obj.path in locations, f"Reference must identify an existing data object: {obj.path!r}")
            _demand(obj.path not in seen_paths, "Direct reference cycle")
            seen_paths.add(obj.path)
            obj = locations[obj.path]
        return obj

    # Pass 2: resolve _RefMarker inside lists, dicts, objects, tuples, frozensets, enums, sets.
    for lst in lists:
        for i in range(len(lst)):
            lst[i] = resolve_ref(lst[i])
    for dp in dict_pendings:
        dp.pairs = [(resolve_ref(k), resolve_ref(v)) for k, v in dp.pairs]
    for op in object_pendings:
        op.pairs = [(k, resolve_ref(v)) for k, v in op.pairs]
    for tb in tuple_boxes:
        tb.items = [resolve_ref(x) for x in tb.items]
    for fb in frozenset_boxes:
        fb.items = [resolve_ref(x) for x in fb.items]
    for eb in enum_boxes:
        eb.value = resolve_ref(eb.value)
    for sb in set_boxes:
        sb.items = [resolve_ref(x) for x in sb.items]
    root = resolve_ref(root)

    # Pass 3: materialize immutable boxes (_TupleBox, _FrozensetBox, _EnumBox) bottom-up.
    imm_map: dict[int, Any] = {}
    in_progress: set[int] = set()

    def materialize_immutable(obj: Any) -> Any:
        if not isinstance(obj, (_TupleBox, _FrozensetBox, _EnumBox)):
            return obj
        bid = id(obj)
        if bid in imm_map:
            return imm_map[bid]
        _demand(bid not in in_progress, "Impossible immutable value cycle")
        in_progress.add(bid)
        if isinstance(obj, _TupleBox):
            result: Any = tuple(materialize_immutable(x) for x in obj.items)
        elif isinstance(obj, _FrozensetBox):
            items = [materialize_immutable(x) for x in obj.items]
            try:
                result = frozenset(items)
            except TypeError as exc:
                raise TypeError("Unhashable frozenset element") from exc
        else:
            mat_val = materialize_immutable(obj.value)
            result = _reconstruct_enum(obj.cls_name, obj.member_name, mat_val)
        in_progress.remove(bid)
        imm_map[bid] = result
        return result

    for tb in tuple_boxes:
        materialize_immutable(tb)
    for fb in frozenset_boxes:
        materialize_immutable(fb)
    for eb in enum_boxes:
        materialize_immutable(eb)

    def finalize_ref(obj: Any) -> Any:
        if isinstance(obj, (_TupleBox, _FrozensetBox, _EnumBox)):
            return imm_map[id(obj)]
        return obj

    # Pass 4: replace immutable box references in lists, dicts, objects, and sets.
    for lst in lists:
        for i in range(len(lst)):
            lst[i] = finalize_ref(lst[i])
    for dp in dict_pendings:
        for k, v in dp.pairs:
            fk = finalize_ref(k)
            fv = finalize_ref(v)
            try:
                dp.target[fk] = fv
            except TypeError as exc:
                raise TypeError("Unhashable dict key") from exc
    for op in object_pendings:
        for k, v in op.pairs:
            object.__setattr__(op.target, k, finalize_ref(v))
    for sb in set_boxes:
        for elem in sb.items:
            fe = finalize_ref(elem)
            try:
                sb.target.add(fe)
            except TypeError as exc:
                raise TypeError("Unhashable set element") from exc

    return finalize_ref(root)


def describe_graph(roots: list[Any], *, allow_exceptions: bool = False) -> dict[str, Any]:
    """Produce a canonical structural + aliasing fingerprint for Python data graphs.

    Preserves exact primitive types (bool vs int vs float, -0/NaN/Inf),
    dict insertion order, canonical set/frozenset ordering, list/dict/set/object
    identity, and cyclic references.
    """
    _demand(isinstance(roots, list), "Graph roots must be a list")
    seen: dict[int, str] = {}
    keepalive: list[Any] = []
    objects: list[dict[str, Any]] = []
    nodes = 0

    def visit(item: Any, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        _demand(depth <= MAX_DEPTH and nodes <= MAX_NODES, "Graph budget exceeded")

        if item is None:
            return ["none"]
        if isinstance(item, enum.Enum):
            return ["enum", type(item).__name__, item.name, visit(item.value, depth + 1)]
        if isinstance(item, bool):
            return ["bool", item]
        if isinstance(item, int):
            return ["int", item]
        if isinstance(item, float):
            if math.isnan(item):
                return ["float", "NaN"]
            if _is_neg_zero(item):
                return ["float", "-0"]
            if math.isinf(item):
                return ["float", "Infinity" if item > 0 else "-Infinity"]
            return ["float", item]
        if isinstance(item, complex):
            return ["complex", visit(item.real, depth + 1), visit(item.imag, depth + 1)]
        if isinstance(item, str):
            return ["str", item]
        if isinstance(item, bytes):
            return ["bytes", base64.b64encode(item).decode("ascii")]
        if isinstance(item, _ORIG_DECIMAL):
            return ["decimal", str(item)]
        if isinstance(item, _ORIG_DATETIME):
            return ["datetime", item.isoformat()]
        if isinstance(item, _ORIG_DATE):
            return ["date", item.isoformat()]
        if isinstance(item, _ORIG_TIMEDELTA):
            return ["timedelta", item.days, item.seconds, item.microseconds]
        if isinstance(item, _ORIG_PURE_PATH):
            return ["path", str(item)]
        if isinstance(item, tuple):
            return ["tuple", [visit(x, depth + 1) for x in item]]
        if isinstance(item, frozenset):
            return ["frozenset", [visit(x, depth + 1) for x in sorted(item, key=_canonical_set_sort_key)]]

        if isinstance(item, BaseException):
            _demand(allow_exceptions, "Only data values cross the training boundary")
            exc_dict = encode_exception(item)
            return visit(exc_dict, depth)

        if _is_plain_dataclass(item):
            obj_id = id(item)
            if obj_id in seen:
                return ["ref", seen[obj_id]]
            oid = f"o{len(objects)}"
            seen[obj_id] = oid
            keepalive.append(item)
            record: dict[str, Any] = {"id": oid, "kind": "dict", "entries": []}
            objects.append(record)
            for f in dataclasses.fields(item):
                record["entries"].append([visit(f.name, depth + 1), visit(getattr(item, f.name), depth + 1)])
            return ["ref", oid]

        if isinstance(item, list):
            obj_id = id(item)
            if obj_id in seen:
                return ["ref", seen[obj_id]]
            oid = f"o{len(objects)}"
            seen[obj_id] = oid
            keepalive.append(item)
            record = {"id": oid, "kind": "list", "items": []}
            objects.append(record)
            for child in item:
                record["items"].append(visit(child, depth + 1))
            return ["ref", oid]

        if isinstance(item, dict):
            obj_id = id(item)
            if obj_id in seen:
                return ["ref", seen[obj_id]]
            oid = f"o{len(objects)}"
            seen[obj_id] = oid
            keepalive.append(item)
            record = {"id": oid, "kind": "dict", "entries": []}
            objects.append(record)
            for k, v in item.items():
                record["entries"].append([visit(k, depth + 1), visit(v, depth + 1)])
            return ["ref", oid]

        if isinstance(item, set):
            obj_id = id(item)
            if obj_id in seen:
                return ["ref", seen[obj_id]]
            oid = f"o{len(objects)}"
            seen[obj_id] = oid
            keepalive.append(item)
            record = {"id": oid, "kind": "set", "items": []}
            objects.append(record)
            for child in sorted(item, key=_canonical_set_sort_key):
                record["items"].append(visit(child, depth + 1))
            return ["ref", oid]

        raw_dict = _get_plain_object_dict(item)
        if raw_dict is not None:
            _demand(
                all(type(k) is str for k in dict.keys(raw_dict)),
                "Plain object attributes must have string keys",
            )
            obj_id = id(item)
            if obj_id in seen:
                return ["ref", seen[obj_id]]
            oid = f"o{len(objects)}"
            seen[obj_id] = oid
            keepalive.append(item)
            record = {"id": oid, "kind": "object", "class": type(item).__name__, "entries": []}
            objects.append(record)
            for k, v in dict.items(raw_dict):
                record["entries"].append([visit(k, depth + 1), visit(v, depth + 1)])
            return ["ref", oid]

        raise TypeError(f"Only data values cross the training boundary (got {type(item).__name__})")

    return {"roots": [visit(root, 0) for root in roots], "objects": objects}


def realize_graph(graph: dict[str, Any]) -> list[Any]:
    """Reconstruct Python objects with exact aliasing/cycles from a describe_graph output."""
    _demand(
        isinstance(graph, dict)
        and isinstance(graph.get("roots"), list)
        and isinstance(graph.get("objects"), list),
        "Invalid Python graph",
    )
    objects: dict[str, Any] = {}
    for node in graph["objects"]:
        kind = node["kind"]
        if kind == "list":
            objects[node["id"]] = []
        elif kind == "dict":
            objects[node["id"]] = {}
        elif kind == "set":
            objects[node["id"]] = set()
        elif kind == "object":
            objects[node["id"]] = _create_plain_object(node["class"])
        else:
            raise TypeError(f"Unknown graph object kind: {kind!r}")

    def decode_token(token: Any) -> Any:
        _demand(isinstance(token, list) and len(token) >= 1, "Invalid graph token")
        tag = token[0]
        if tag == "none":
            return None
        if tag == "bool":
            return bool(token[1])
        if tag == "int":
            return int(token[1])
        if tag == "float":
            val = token[1]
            if val == "NaN":
                return float("nan")
            if val == "-0":
                return -0.0
            if val == "Infinity":
                return float("inf")
            if val == "-Infinity":
                return float("-inf")
            return float(val)
        if tag == "complex":
            return complex(decode_token(token[1]), decode_token(token[2]))
        if tag == "str":
            return str(token[1])
        if tag == "bytes":
            return base64.b64decode(token[1].encode("ascii"), validate=True)
        if tag == "decimal":
            return _ORIG_DECIMAL(str(token[1]))
        if tag == "datetime":
            return _ORIG_DATETIME.fromisoformat(str(token[1]))
        if tag == "date":
            return _ORIG_DATE.fromisoformat(str(token[1]))
        if tag == "timedelta":
            return _ORIG_TIMEDELTA(days=int(token[1]), seconds=int(token[2]), microseconds=int(token[3]))
        if tag == "path":
            return pathlib.Path(str(token[1]))
        if tag == "enum":
            return _reconstruct_enum(str(token[1]), str(token[2]), decode_token(token[3]))
        if tag == "tuple":
            return tuple(decode_token(x) for x in token[1])
        if tag == "frozenset":
            return frozenset(decode_token(x) for x in token[1])
        if tag == "ref":
            oid = token[1]
            _demand(oid in objects, f"Unknown graph object ref: {oid!r}")
            return objects[oid]
        raise TypeError(f"Unknown graph token tag: {tag!r}")

    for node in graph["objects"]:
        target = objects[node["id"]]
        kind = node["kind"]
        if kind == "list":
            for item in node["items"]:
                target.append(decode_token(item))
        elif kind == "dict":
            for k_tok, v_tok in node["entries"]:
                target[decode_token(k_tok)] = decode_token(v_tok)
        elif kind == "set":
            for item in node["items"]:
                target.add(decode_token(item))
        elif kind == "object":
            for k_tok, v_tok in node["entries"]:
                object.__setattr__(target, decode_token(k_tok), decode_token(v_tok))

    return [decode_token(root) for root in graph["roots"]]
