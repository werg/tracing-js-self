"""Direct archive reuse with semantic wrappers absent and exact source pins."""

import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_standalone_archive_roundtrip_in_fresh_process_without_semantic_tools(tmp_path):
    helper = tmp_path / "release_archive.py"
    shutil.copyfile(TOOLS / helper.name, helper)
    script = r"""
import importlib.abc, importlib.util, json, pathlib, sys
class NoSemanticImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(("megatoken", "semantic", "release_packager", "release_restore")):
            raise AssertionError("Unexpected semantic dependency: " + fullname)
        return None
sys.meta_path.insert(0, NoSemanticImports())
root=pathlib.Path(sys.argv[1]); helper=root/"release_archive.py"
assert sorted(p.name for p in root.iterdir()) == ["release_archive.py"]
spec=importlib.util.spec_from_file_location("neutral_archive",helper)
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)
source=root/"source";source.mkdir()
(source/"private.bin").write_bytes(b"\x00\xfforiginal\x00")
(source/"unicode.json").write_text('{"retained":"\u03bb"}\n')
rows,paths=archive.inventory({"inputs":source})
target=root/"roundtrip.tar.gz"
archive.write_archive(target,{"schema":"unrelated-container/1","files":rows},paths)
manifest,manifest_sha=archive.bounded_inventory(target,archive.DEFAULT_LIMITS)
receipt=archive.verify_archive(target,opener=lambda path:archive.bounded_tar(path,archive.DEFAULT_LIMITS))
verified={"manifest":manifest,"manifestSha256":manifest_sha,"verification":receipt,"limits":archive.DEFAULT_LIMITS}
output=root/"restored";result=archive.extract_verified(target,output,verified)
assert result["files"]==2 and result["status"]=="verified"
for path in source.iterdir():
    actual=output/"inputs"/path.name
    assert actual.read_bytes()==path.read_bytes()
    assert actual.stat().st_mode & 0o777 == 0o600
assert not any(name.startswith(("megatoken", "release_packager", "release_restore")) for name in sys.modules)
print(json.dumps({"files":2,"semanticDependenciesLoaded":0,"status":"verified"}))
"""
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", script, str(tmp_path)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout) == {
        "files": 2,
        "semanticDependenciesLoaded": 0,
        "status": "verified",
    }


def test_wrapper_archive_bytes_match_core_and_keep_semantic_restore_gate(tmp_path):
    core = load("archive_core", TOOLS / "release_archive.py")
    wrapper = load("archive_wrapper", TOOLS / "package-semantic-release.py")
    restore = load("archive_restore", TOOLS / "restore-semantic-release.py")
    source = tmp_path / "original.bin"
    source.write_bytes(b"bounded archive controls\x00\xff")
    rows, paths = core.inventory({"input/original.bin": source})
    payload = {"schema": "unrelated-container/1", "files": rows}
    direct, wrapped = tmp_path / "direct.tar.gz", tmp_path / "wrapped.tar.gz"
    assert core.write_archive(direct, payload, paths) == wrapper.write_archive(
        wrapped, payload, paths
    )
    assert direct.read_bytes() == wrapped.read_bytes()
    assert core.verify_archive(direct) == wrapper.verify_archive(wrapped)
    with pytest.raises(ValueError, match="Unsupported release schema"):
        restore.verify_before_restore(wrapped, core.file_receipt(wrapped)["sha256"])
    assert not (tmp_path / "restored").exists()


def test_changed_archive_dependency_is_refused_before_its_source_executes(tmp_path):
    wrapper = tmp_path / "package-semantic-release.py"
    shutil.copyfile(TOOLS / wrapper.name, wrapper)
    marker = tmp_path / "executed"
    (tmp_path / "release_archive.py").write_text(
        "from pathlib import Path\nPath("
        + repr(str(marker))
        + ").write_text('executed')\n"
    )
    process = subprocess.run(
        [sys.executable, "-I", "-B", str(wrapper), "--help"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert process.returncode != 0
    assert "Pinned release archive implementation changed" in process.stderr
    assert not marker.exists()


@pytest.mark.parametrize(
    "packager_name", ["package-semantic-release.py", "release_archive.py"]
)
def test_audit_supplement_retains_exact_extracted_dependency_when_present(
    tmp_path, packager_name
):
    core = load("audit_archive_core", TOOLS / "release_archive.py")
    (tmp_path / "result.json").write_text('{"status":"complete"}\n')
    rows, _ = core.inventory({"result.json": tmp_path / "result.json"})
    packager = TOOLS / packager_name
    selection = {
        "schema": "semantic-audit-supplement-selection/1",
        "qualifications": [
            {
                "name": "controlled",
                "status": "complete",
                "completionReceipt": "result.json",
            }
        ],
        "currentQualification": "controlled",
        "packagerSha256": core.file_receipt(packager)["sha256"],
        "files": [{**row, "group": "controlled"} for row in rows],
        "alreadyDeliveredReferences": [],
        "exclusions": [],
    }
    selection_path = tmp_path / "selection.json"
    selection_path.write_text(json.dumps(selection))
    notes = tmp_path / "README.md"
    notes.write_text(
        "Controlled archive-input fixture; no source or model qualification.\n"
    )
    output = tmp_path / "bundle"
    process = subprocess.run(
        [
            sys.executable,
            "-B",
            str(TOOLS / "package-audit-supplement.py"),
            "--workspace",
            str(tmp_path),
            "--selection",
            str(selection_path),
            "--notes",
            str(notes),
            "--packager",
            str(packager),
            "--out",
            str(output),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    result = json.loads(process.stdout)
    expected = (
        {"release_archive.py": core.file_receipt(TOOLS / "release_archive.py")}
        if packager_name.startswith("package-")
        else {}
    )
    assert result["packagerImplementationFiles"] == expected
    with tarfile.open(output / "semantic-audit-supplement.tar.gz", "r:gz") as archive:
        manifest = json.load(archive.extractfile("release-manifest.json"))
        assert manifest["packagerImplementationFiles"] == expected
        assert manifest["packagerSha256"] == selection["packagerSha256"]
        dependency_path = "audit/archive-implementation/release_archive.py"
        if expected:
            assert (
                archive.extractfile(dependency_path).read()
                == (TOOLS / "release_archive.py").read_bytes()
            )
        else:
            assert dependency_path not in archive.getnames()
