"""Readable Python data graph codec and canonical structural+aliasing fingerprint.

Mirrors encodeReadable / decodeReadable / describeGraph / realizeGraph from
src/training/tinker-execution.js and src/training/graph.js for Python values.
"""

from __future__ import annotations

import base64
import dataclasses
import math
from typing import Any

MAX_DEPTH = 64
MAX_NODES = 16384


def _demand(condition: bool, message: str) -> None:
    if not condition:
        raise TypeError(message)


def _pointer(path: str, key: Any) -> str:
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


def _is_neg_zero(value: float) -> bool:
    return value == 0.0 and math.copysign(1.0, value) < 0.0


def _is_plain_dataclass(value: Any) -> bool:
    return dataclasses.is_dataclass(value) and not isinstance(value, type)


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
        if isinstance(item, str):
            return item
        if isinstance(item, bytes):
            return {"$py": "bytes", "b64": base64.b64encode(item).decode("ascii")}

        if isinstance(item, tuple):
            return {
                "$py": "tuple",
                "items": [visit(child, _pointer(path, idx), depth + 1) for idx, child in enumerate(item)],
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


def decode_readable(value: Any) -> Any:
    """Decode readable JSON with $py tags back into a Python data graph."""
    locations: dict[str, Any] = {}
    tuple_boxes: list[_TupleBox] = []
    set_boxes: list[_SetBox] = []
    dict_pendings: list[_DictPending] = []
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

    # Pass 2: resolve _RefMarker inside lists, dicts, tuples, sets.
    for lst in lists:
        for i in range(len(lst)):
            lst[i] = resolve_ref(lst[i])
    for dp in dict_pendings:
        dp.pairs = [(resolve_ref(k), resolve_ref(v)) for k, v in dp.pairs]
    for tb in tuple_boxes:
        tb.items = [resolve_ref(x) for x in tb.items]
    for sb in set_boxes:
        sb.items = [resolve_ref(x) for x in sb.items]
    root = resolve_ref(root)

    # Pass 3: materialize _TupleBox into real Python tuples (bottom-up).
    tuple_map: dict[int, tuple[Any, ...]] = {}
    in_progress: set[int] = set()

    def materialize_tuple(obj: Any) -> Any:
        if not isinstance(obj, _TupleBox):
            return obj
        tid = id(obj)
        if tid in tuple_map:
            return tuple_map[tid]
        _demand(tid not in in_progress, "Impossible pure-tuple cycle")
        in_progress.add(tid)
        result = tuple(materialize_tuple(x) for x in obj.items)
        in_progress.remove(tid)
        tuple_map[tid] = result
        return result

    for tb in tuple_boxes:
        materialize_tuple(tb)

    def finalize_ref(obj: Any) -> Any:
        if isinstance(obj, _TupleBox):
            return tuple_map[id(obj)]
        return obj

    # Pass 4: replace _TupleBox references in lists, dicts, and sets.
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
    dict insertion order, canonical set ordering, list/dict/set object identity,
    and cyclic references.
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
        if isinstance(item, str):
            return ["str", item]
        if isinstance(item, bytes):
            return ["bytes", base64.b64encode(item).decode("ascii")]
        if isinstance(item, tuple):
            return ["tuple", [visit(x, depth + 1) for x in item]]

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

        raise TypeError(f"Only data values cross the training boundary (got {type(item).__name__})")

    return {"roots": [visit(root, 0) for root in roots], "objects": objects}


def realize_graph(graph: dict[str, Any]) -> list[Any]:
    """Reconstruct Python objects with exact aliasing/cycles from a describe_graph output."""
    _demand(isinstance(graph, dict) and isinstance(graph.get("roots"), list) and isinstance(graph.get("objects"), list),
            "Invalid Python graph")
    objects: dict[str, Any] = {}
    for node in graph["objects"]:
        kind = node["kind"]
        if kind == "list":
            objects[node["id"]] = []
        elif kind == "dict":
            objects[node["id"]] = {}
        elif kind == "set":
            objects[node["id"]] = set()
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
        if tag == "str":
            return str(token[1])
        if tag == "bytes":
            return base64.b64decode(token[1].encode("ascii"), validate=True)
        if tag == "tuple":
            return tuple(decode_token(x) for x in token[1])
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

    return [decode_token(root) for root in graph["roots"]]
