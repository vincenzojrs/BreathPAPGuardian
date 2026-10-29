#!/usr/bin/env python3
"""Serve only the bundled application, with no upload or external API routes."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent / 'web'
FILES = {'/', '/index.html', '/app.js', '/core.js', '/philips.js', '/import-files.js', '/dreamstation2.js', '/style.css', '/pdf-export.js', '/glasgow.js', '/glasgow-ui.js', '/glasgow-worker.js', '/vendor/glasgow-reference.js'}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' blob: data:; media-src 'self' blob: data:; "
       "worker-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'none'")

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Host', '') not in {'127.0.0.1:8765', 'localhost:8765'}:
            self.send_error(403, 'Host not allowed')
            return
        path = urlsplit(self.path).path
        if path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        if path not in FILES:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path not in FILES:
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', choices=['127.0.0.1', '0.0.0.0'], default='127.0.0.1')
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer((args.bind, 8765), partial(Handler, directory=str(ROOT)))
    except OSError as exc:
        raise SystemExit('Port 8765 unavailable. Close any previous PAP instance.\n' + str(exc))
    print('BreathPAPGuardian: http://127.0.0.1:8765\nLeave this window open. Press Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nBreathPAPGuardian stopped.')
    finally:
        server.server_close()

