"""Fail fast when the configured port is already taken.

Uvicorn only discovers the conflict after the application has started, so
the model is loaded first and the whole startup sequence is wasted before
the process gives up. This module checks the port up front and reports
what is holding it, so the failure is immediate and actionable.
"""

from __future__ import annotations

import errno
import os
import socket
import sys
from collections.abc import Callable
from pathlib import Path

#: Ports below this are reserved and never used by a real service.
_RESERVED_PORTS = {0}


def _is_port_free(host: str, port: int) -> bool:
    """Return True when a socket can bind to the host and port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        # Reusing the address lets the probe bind in the same state a
        # server would, so a listening socket is reported as busy.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError as exc:
            if exc.errno in (errno.EADDRINUSE, errno.EACCES):
                return False
            raise
    return True


def _describe_holder(host: str, port: int) -> str:
    """Return a short description of the process holding the port."""
    # The socket inode is matched against the open files of every process.
    socket_path = Path("/proc/net/tcp")
    inode = None
    try:
        for line in socket_path.read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) < 10:
                continue
            local = fields[1]
            state = fields[3]
            # State 0A is LISTEN.
            if state != "0A":
                continue
            local_port = int(local.split(":")[1], 16)
            if local_port == port:
                inode = fields[9]
                break
    except (OSError, ValueError, IndexError):
        inode = None

    if inode is None:
        return "unknown process"

    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        try:
            for fd in (proc_dir / "fd").iterdir():
                try:
                    target = fd.readlink().as_posix()
                except OSError:
                    continue
                if target == f"socket:[{inode}]":
                    cmdline = (proc_dir / "cmdline").read_bytes().replace(b"\0", b" ").decode()
                    return f"pid {proc_dir.name}: {cmdline.strip() or 'unknown'}"
        except (OSError, PermissionError):
            continue

    return "unknown process"


def check_port_available(host: str, port: int) -> str | None:
    """Return an error message when the port cannot be used.

    Args:
        host: The interface the server binds to.
        port: The TCP port.

    Returns:
        ``None`` when the port is free, otherwise a message explaining the
        conflict and what to do about it.
    """
    if port in _RESERVED_PORTS:
        return None

    if _is_port_free(host, port):
        return None

    holder = _describe_holder(host, port)
    return (
        f"Port {port} is already in use by {holder}.\n"
        f"Stop the process that holds it, or start LookAtify on a different "
        f"port with PORT=<port>."
    )


def exit_on_port_conflict(
    host: str, port: int, exit_fn: Callable[[int], None] | None = None
) -> None:
    """Terminate the process with a readable message when the port is taken.

    Raising an exception here would make uvicorn print a full traceback for
    what is a routine operational mistake. The process exits with status 1
    instead, and the message is the only thing the user has to read.

    Args:
        host: The interface the server binds to.
        port: The TCP port.
        exit_fn: How the process is terminated. Defaults to ``os._exit``,
            which skips the interpreter shutdown so the message cannot be lost
            behind a traceback from the cleanup handlers. Tests pass their own
            callable so they do not kill the test runner.
    """
    message = check_port_available(host, port)
    if message is None:
        return

    print(f"\nERROR: {message}\n", file=sys.stderr, flush=True)
    sys.stderr.flush()
    sys.stdout.flush()
    (exit_fn or os._exit)(1)
