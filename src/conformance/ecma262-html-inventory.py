#!/usr/bin/env python3
"""Extract actual HTML anchors and clause ancestry without interpreting scripts."""

import json
import sys
from html.parser import HTMLParser


class Inventory(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sections = []
        self.stack = []
        self.anchors = {}
        self.heading = None

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag in ("emu-clause", "emu-annex", "emu-intro"):
            identity = fields.get("id")
            if not identity:
                raise ValueError("A specification clause has no identity")
            section = {
                "id": identity,
                "tag": tag,
                "parent": self.stack[-1][1]["id"] if self.stack else None,
                "title": "",
                "normativeOptional": "normative-optional" in fields,
                "type": fields.get("type"),
                "legacyIds": fields.get("oldids", "").split(",") if fields.get("oldids") else [],
            }
            self.sections.append(section)
            self.stack.append((tag, section))
        if "id" in fields and self.stack:
            anchor = self.anchors.setdefault(fields["id"], {"sections": set(), "occurrences": 0})
            anchor["sections"].add(self.stack[-1][1]["id"])
            anchor["occurrences"] += 1
        if tag == "h1" and self.stack and not self.stack[-1][1]["title"]:
            self.heading = (self.stack[-1][1], [])

    def handle_endtag(self, tag):
        if tag == "h1" and self.heading:
            section, fragments = self.heading
            section["title"] = " ".join("".join(fragments).split())
            self.heading = None
        if tag in ("emu-clause", "emu-annex", "emu-intro"):
            if not self.stack or self.stack[-1][0] != tag:
                raise ValueError("Unbalanced specification clause hierarchy")
            self.stack.pop()

    def handle_data(self, data):
        if self.heading:
            self.heading[1].append(data)


def main():
    parser = Inventory()
    parser.feed(sys.stdin.buffer.read().decode("utf-8", errors="strict"))
    parser.close()
    if parser.stack or parser.heading:
        raise ValueError("Incomplete specification clause hierarchy")
    identities = [section["id"] for section in parser.sections]
    if len(identities) != len(set(identities)):
        raise ValueError("Duplicate specification clause identity")
    print(json.dumps({
        "extractor": "python-stdlib-htmlparser/1",
        "python": sys.version.split()[0],
        "sections": parser.sections,
        "anchors": [{"id": identity, "sections": sorted(anchor["sections"]),
                     "occurrences": anchor["occurrences"]}
                    for identity, anchor in sorted(parser.anchors.items())],
    }, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
