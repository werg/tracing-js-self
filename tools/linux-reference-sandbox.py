#!/usr/bin/env python3
"""Set up a bounded Linux reference process inside fresh unprivileged namespaces.

Internal launcher: invoked by reference-isolation.mjs through util-linux unshare.
No shell evaluates these arguments. Any unavailable isolation primitive aborts
before the guest source is read. The supplied root is an empty temporary directory.
"""
import argparse
import ctypes
import ctypes.util
import errno
import os
from pathlib import Path
import resource
import subprocess
import sys


def mount(*arguments):
    subprocess.run(["/usr/bin/mount", *map(str, arguments)], check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)


def bind(source, target, *, readonly=True):
    source = Path(source).resolve(strict=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        target.mkdir(exist_ok=True)
    else:
        target.touch()
    mount("--bind", source, target)
    mount("-o", "remount,bind,nosuid,nodev" + (",ro" if readonly else ""), target)


def restrict_syscalls(library):
    # Namespace isolation contains filesystem and PID visibility. Seccomp
    # prevents creating processes, changing namespaces/mounts, network access,
    # and kernel-control interfaces even after an escape from node:vm.
    class Comparison(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                    ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]

    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                             ctypes.c_int, ctypes.c_uint,
                                             ctypes.POINTER(Comparison)]
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    context = library.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError("Cannot allocate seccomp filter")

    def deny(name, error=errno.EPERM, comparison=None):
        number = library.seccomp_syscall_resolve_name(name.encode("ascii"))
        if number < 0:  # A syscall absent from this architecture cannot be used.
            return
        result = library.seccomp_rule_add_array(
            context, 0x00050000 | error, number, 0 if comparison is None else 1,
            None if comparison is None else ctypes.pointer(comparison))
        if result != 0:
            raise RuntimeError(f"Cannot restrict {name}: {result}")

    try:
        for name in ("fork", "vfork", "unshare", "setns", "mount", "umount2",
                     "pivot_root", "chroot", "fsopen", "fsconfig", "fsmount",
                     "move_mount", "open_tree", "mount_setattr", "socket",
                     "socketpair", "connect", "accept", "accept4", "bind",
                     "listen", "ptrace", "process_vm_readv", "process_vm_writev",
                     "open_by_handle_at", "name_to_handle_at", "keyctl", "add_key",
                     "request_key", "bpf", "perf_event_open", "userfaultfd",
                     "io_uring_setup", "reboot", "kexec_load", "kexec_file_load",
                     "init_module", "finit_module", "delete_module"):
            deny(name)
        # Node needs threads. Permit CLONE_THREAD but no child processes.
        deny("clone", comparison=Comparison(0, 7, 0x00010000, 0))
        # clone3 hides its flags behind a pointer. ENOSYS allows libc's safe
        # thread fallback to clone, which the argument filter can inspect.
        deny("clone3", errno.ENOSYS)
        if library.seccomp_load(context) != 0:
            raise RuntimeError("Cannot install seccomp filter")
    finally:
        library.seccomp_release(context)


def drop_capabilities(libc):
    libc.prctl.restype = ctypes.c_int
    # Lock out uid-0 privilege restoration and privilege gain through exec.
    for option, value in ((28, 15), (38, 1)):  # securebits; no_new_privs
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot restrict process privileges")
    for capability in range(64):
        if libc.prctl(24, capability, 0, 0, 0) != 0 and ctypes.get_errno() != errno.EINVAL:
            raise OSError(ctypes.get_errno(), "Cannot drop capability bounding set")

    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32),
                    ("inheritable", ctypes.c_uint32)]

    if libc.capset(ctypes.byref(Header(0x20080522, 0)), (Data * 2)()) != 0:
        raise OSError(ctypes.get_errno(), "Cannot clear process capabilities")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--cpu-seconds", required=True, type=int)
    parser.add_argument("--timezone", required=True)
    parser.add_argument("--lang", required=True)
    parser.add_argument("--locale", required=True)
    options = parser.parse_args()
    if not 1 <= options.cpu_seconds <= 3600:
        raise ValueError("Invalid reference CPU bound")
    root, repo = Path(options.root).resolve(strict=True), Path(options.repo).resolve(strict=True)
    if any(root.iterdir()):
        raise ValueError("Reference sandbox root must be empty")
    seccomp_name = ctypes.util.find_library("seccomp")
    if not seccomp_name:
        raise RuntimeError("libseccomp is required for reference isolation")
    seccomp = ctypes.CDLL(seccomp_name, use_errno=True)
    libc = ctypes.CDLL(None, use_errno=True)
    mount("--make-rprivate", "/")
    mount("-t", "tmpfs", "-o", "size=64m,nosuid,nodev,noexec,mode=0755", "tmpfs", root)
    # Bind only execution dependencies. No host home, credentials, repository
    # history, generated datasets, or arbitrary workspace files enter this root.
    bind(options.node, root / "bin/node")
    for directory in ("/lib", "/lib64"):
        if Path(directory).exists():
            bind(directory, root / directory.lstrip("/"))
    bind(repo / "src", root / "app/src")
    bind(repo / "catalog", root / "app/catalog")
    bind(repo / "package.json", root / "app/package.json")
    bind(options.worker, root / "app/tools/reference.mjs")
    for package in ("acorn", "typescript"):
        bind(repo / "node_modules" / package, root / "app/node_modules" / package)
    if Path("/usr/share/zoneinfo").exists():
        bind("/usr/share/zoneinfo", root / "usr/share/zoneinfo")
    (root / "proc").mkdir()
    mount("-t", "proc", "-o", "ro,nosuid,nodev,noexec", "proc", root / "proc")
    (root / "tmp").mkdir()
    mount("-t", "tmpfs", "-o", "size=64m,nosuid,nodev,noexec,mode=1777", "tmpfs", root / "tmp")
    for device in ("null", "zero", "random", "urandom"):
        target = root / "dev" / device
        target.parent.mkdir(exist_ok=True)
        target.touch()
        mount("--bind", "/dev/" + device, target)
        mount("-o", "remount,bind,nosuid,noexec", target)
    mount("-o", "remount,bind,ro,nosuid,nodev,noexec", root)
    os.chroot(root)
    os.chdir("/app")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (options.cpu_seconds, options.cpu_seconds))
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    drop_capabilities(libc)
    restrict_syscalls(seccomp)
    environment = {"PATH": "/bin", "TMPDIR": "/tmp", "LANG": options.lang,
                   "LC_ALL": options.locale, "TZ": options.timezone}
    # JITless avoids V8's large executable CodeRange reservation, allowing a
    # meaningful 1 GiB whole-process virtual-address cap in addition to the heap.
    os.execve("/bin/node", ["/bin/node", "--jitless", "--max-old-space-size=256",
                           "/app/tools/reference.mjs"], environment)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Reference isolation setup failed: " + str(error), file=sys.stderr)
        sys.exit(126)
