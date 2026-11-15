"""Serve the PWA over private-LAN HTTPS and expose only mkcert's public root CA."""

from __future__ import annotations

import argparse
import http.server
import ipaddress
import socket
import ssl
import threading
from pathlib import Path


APP_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/seibun.json": ("seibun.json", "application/json; charset=utf-8"),
    "/sw.js": ("sw.js", "text/javascript; charset=utf-8"),
}


def lan_address() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.connect(("192.0.2.1", 80))
            candidate = connection.getsockname()[0]
            ipaddress.ip_address(candidate)
            return candidate
    except OSError:
        return "PCのLAN内IPv4アドレス"


def handler_for(root: Path, root_ca: Path | None = None):
    class AppHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/rootCA.pem" and root_ca is not None:
                self._send_file(root_ca, "application/x-pem-file")
                return
            entry = APP_FILES.get(self.path)
            if entry is None:
                self.send_error(404)
                return
            filename, content_type = entry
            self._send_file(root / filename, content_type)

        def _send_file(self, path: Path, content_type: str):
            try:
                contents = path.read_bytes()
            except OSError:
                self.send_error(404, "Requested file is unavailable")
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(contents)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(contents)

        def log_message(self, format_string: str, *args):
            print(f"[{self.address_string()}] {format_string % args}")

    return AppHandler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cert", default="cert.pem", help="mkcert certificate for this PC's LAN IP")
    parser.add_argument("--key", default="key.pem", help="matching private key (never served)")
    parser.add_argument("--root-ca", help="mkcert rootCA.pem; served only at /rootCA.pem over local HTTP")
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--http-port", type=int, default=8000)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    cert_path = Path(args.cert).resolve()
    key_path = Path(args.key).resolve()
    ca_path = Path(args.root_ca).resolve() if args.root_ca else None
    for path in (cert_path, key_path):
        if not path.is_file():
            parser.error(f"Certificate file not found: {path}")
    if ca_path is not None and not ca_path.is_file():
        parser.error(f"Root CA file not found: {ca_path}")

    host = "0.0.0.0"
    secure_server = http.server.ThreadingHTTPServer((host, args.https_port), handler_for(root))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=cert_path, keyfile=key_path)
    secure_server.socket = context.wrap_socket(secure_server.socket, server_side=True)
    bootstrap_server = http.server.ThreadingHTTPServer((host, args.http_port), handler_for(root, ca_path))

    print(f"アプリ: https://{lan_address()}:{args.https_port}/")
    if ca_path:
        print(f"iPhoneへの証明書配布: http://{lan_address()}:{args.http_port}/rootCA.pem")
    print("停止するには Ctrl+C を押してください。ファイアウォールではプライベートネットワークのみ許可してください。")
    bootstrap_thread = threading.Thread(target=bootstrap_server.serve_forever, daemon=True)
    bootstrap_thread.start()
    try:
        secure_server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止します。")
    finally:
        secure_server.shutdown()
        bootstrap_server.shutdown()
        secure_server.server_close()
        bootstrap_server.server_close()


if __name__ == "__main__":
    main()
