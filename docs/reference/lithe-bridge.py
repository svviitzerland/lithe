#!/usr/bin/env python3
"""
A reference client: ssh to a lithe app with no infrastructure in between.

    ssh -o ProxyCommand="python3 lithe-bridge.py %h" my-app.vercel.app

You do not need this to use a lithe app. Apps are reached with plain
`ssh your-app.com`, through a pipe the app author deploys. This exists to show
that the client half of the transport is small enough to read in one sitting,
and to connect to a deployment that has no pipe in front of it yet.

A serverless platform offers no raw TCP, and its HTTP layer buffers request
bodies, so the only bidirectional channel is a WebSocket — which needs framing
and masking that shell tools cannot do. Python's standard library can, and
python3 is already on every Mac and Linux.

The SSH session is end-to-end encrypted between your ssh client and the app.
This script moves bytes; it cannot read them, and it holds no keys.

Standard library only. No pip, no dependencies.
"""

import base64
import os
import select
import socket
import ssl
import struct
import sys


def log(msg):
    sys.stderr.write("lithe-bridge: %s\n" % msg)


class WebSocket:
    """The client half of RFC 6455, cut down to what a byte tunnel needs."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def handshake(self, host, path):
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: lithe-bridge\r\n"
            "\r\n" % (path, host, key)
        )
        self.sock.sendall(request.encode())

        # Read just the response head; anything after it is already frames.
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("server closed during the handshake")
            head += chunk
        header, _, rest = head.partition(b"\r\n\r\n")
        status = header.split(b"\r\n", 1)[0].decode("latin-1")
        if "101" not in status:
            raise ConnectionError("expected a websocket upgrade, got: %s" % status)
        self.buf = rest

    def send(self, payload):
        """One masked binary frame. Clients must mask; servers must not."""
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x82, 0x80 | n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x82, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x82, 0x80 | 127, n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def frame_waiting(self):
        """
        True when more input is already in hand.

        select() watches the raw socket, but TLS decrypts in bulk: a readable
        event can carry several frames, and the next ones sit in buffers select
        will never report. Without this check the tunnel deadlocks the moment
        two frames arrive together.
        """
        pending = getattr(self.sock, "pending", None)
        if pending and pending() > 0:
            return True
        b = self.buf
        if len(b) < 2:
            return False
        length = b[1] & 0x7F
        offset = 2
        if length == 126:
            if len(b) < 4:
                return False
            length = struct.unpack("!H", b[2:4])[0]
            offset = 4
        elif length == 127:
            if len(b) < 10:
                return False
            length = struct.unpack("!Q", b[2:10])[0]
            offset = 10
        if b[1] & 0x80:
            offset += 4
        return len(b) >= offset + length

    def _fill(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                return False
            self.buf += chunk
        return True

    def recv(self):
        """Returns payload bytes, b"" for a non-data frame, or None at close."""
        if not self._fill(2):
            return None
        b0, b1 = self.buf[0], self.buf[1]
        opcode = b0 & 0x0F
        masked = b1 & 0x80
        length = b1 & 0x7F
        offset = 2
        if length == 126:
            if not self._fill(4):
                return None
            length = struct.unpack("!H", self.buf[2:4])[0]
            offset = 4
        elif length == 127:
            if not self._fill(10):
                return None
            length = struct.unpack("!Q", self.buf[2:10])[0]
            offset = 10
        if masked:
            if not self._fill(offset + 4):
                return None
            mask = self.buf[offset:offset + 4]
            offset += 4
        if not self._fill(offset + length):
            return None
        payload = self.buf[offset:offset + length]
        self.buf = self.buf[offset + length:]
        if masked:
            payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))

        if opcode == 0x8:  # close
            return None
        if opcode == 0x9:  # ping -> pong
            self.sock.sendall(struct.pack("!BB", 0x8A, 0x80) + os.urandom(4))
            return b""
        if opcode in (0x1, 0x2, 0x0):
            return payload
        return b""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    if not args:
        log("usage: lithe-bridge.py <host> [--port N] [--path P] [--insecure]")
        return 2

    host = args[0]
    insecure = "--insecure" in flags
    port = 80 if insecure else 443
    path = "/_lithe/ssh"
    for i, f in enumerate(sys.argv):
        if f == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])
        if f == "--path" and i + 1 < len(sys.argv):
            path = sys.argv[i + 1]

    raw = socket.create_connection((host, port), timeout=20)
    raw.settimeout(None)
    if insecure:
        sock = raw
    else:
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(raw, server_hostname=host)

    ws = WebSocket(sock)
    try:
        ws.handshake(host, path)
    except Exception as exc:  # noqa: BLE001 - surfaced to the user as-is
        log("cannot reach wss://%s%s — %s" % (host, path, exc))
        return 1

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    stdin_fd = stdin.fileno()

    while True:
        # Never block in select while decrypted bytes are already buffered.
        timeout = 0 if ws.frame_waiting() else None
        ready, _, _ = select.select([stdin_fd, sock], [], [], timeout)
        if stdin_fd in ready:
            data = os.read(stdin_fd, 32768)
            if not data:
                break
            ws.send(data)
        if sock in ready or ws.frame_waiting():
            closed = False
            while True:
                payload = ws.recv()
                if payload is None:
                    closed = True
                    break
                if payload:
                    stdout.write(payload)
                if not ws.frame_waiting():
                    break
            stdout.flush()
            if closed:
                break
    try:
        sock.close()
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:
        sys.exit(0)
