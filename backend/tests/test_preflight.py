"""Tests for the startup port check."""

from __future__ import annotations

import socket

import pytest

from app.preflight import check_port_available, exit_on_port_conflict


def _find_free_port() -> int:
    """Return a port that is currently unused."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_free_port_passes() -> None:
    """A free port produces no error."""
    port = _find_free_port()
    assert check_port_available("127.0.0.1", port) is None


def test_busy_port_is_reported() -> None:
    """A port that is already listened on produces an error."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]

        message = check_port_available("127.0.0.1", port)

    assert message is not None
    assert str(port) in message
    assert "already in use" in message


def test_error_mentions_the_port_override() -> None:
    """The message tells the user how to move to another port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]

        message = check_port_available("127.0.0.1", port)

    assert message is not None
    assert "PORT=" in message


def test_ephemeral_port_is_skipped() -> None:
    """Port 0 means "pick any free port", so it is never a conflict."""
    assert check_port_available("127.0.0.1", 0) is None


def test_the_check_does_not_leak_the_probe_socket() -> None:
    """The probe socket is closed, so the port stays usable."""
    port = _find_free_port()
    assert check_port_available("127.0.0.1", port) is None

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as second:
        second.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        second.bind(("127.0.0.1", port))


@pytest.mark.parametrize("host", ["127.0.0.1", "0.0.0.0"])
def test_both_hosts_are_checked(host: str) -> None:
    """The check works for the loopback and the wildcard address."""
    port = _find_free_port()
    assert check_port_available(host, port) is None


def test_a_free_port_does_not_exit() -> None:
    """The exit helper is a no-op when the port is available."""
    port = _find_free_port()

    # The call returns instead of terminating the process.
    exit_on_port_conflict("127.0.0.1", port)


def test_a_busy_port_exits_with_a_readable_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A busy port ends the process with a message instead of a traceback."""
    exits: list[int] = []

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]

        exit_on_port_conflict("127.0.0.1", port, exit_fn=exits.append)

    assert exits == [1]
    captured = capsys.readouterr()
    assert "already in use" in captured.err
    assert str(port) in captured.err
    # The traceback is what this change removes.
    assert "Traceback" not in captured.err
