#!/usr/bin/env python3
"""Serve the bundled app; optionally enable a loopback portable archive."""
import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from portable_store import PortableStore

ROOT = Path(__file__).resolve().parent / 'web'
FILES = {'/', '/index.html', '/app.js', '/core.js', '/style.css', '/pdf-export.js', '/glasgow.js', '/glasgow-ui.js', '/glasgow-worker.js', '/vendor/glasgow-reference.js'}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' blob: data:; media-src 'self' blob: data:; "
       "worker-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'none'")

class Handler(SimpleHTTPRequestHandler):
    portable = None
    port = 8765

    def allowed(self):
        return self.headers.get('Host', '') in {f'127.0.0.1:{self.port}', f'localhost:{self.port}'}

    def json_response(self, value, code=200):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def api(self, action):
        if not self.allowed() or self.headers.get('X-BPG-Local') != '1':
            return self.json_response({'error': 'Local request required.'}, 403)
        if self.command == 'POST' and self.headers.get('Origin') not in (None, f'http://127.0.0.1:{self.port}', f'http://localhost:{self.port}'):
            return self.json_response({'error': 'Invalid origin.'}, 403)
        if not self.portable:
            return self.json_response({'error': 'Portable mode disabled.'}, 404)
        try:
            path = urlsplit(self.path).path
            if action == 'GET':
                if path == '/api/status': return self.json_response(self.portable.status())
                if path.startswith('/api/records/'): return self.json_response(self.portable.records(path.removeprefix('/api/records/')))
                if path.startswith('/api/blob/'):
                    blob = self.portable.blob(path.removeprefix('/api/blob/'))
                    if not blob.is_file(): raise ValueError('Attachment missing.')
                    data = blob.read_bytes()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    return self.wfile.write(data)
            else:
                length = int(self.headers.get('Content-Length', '-1'))
                if length < 0 or length > 512 * 1024 * 1024: raise ValueError('Invalid request size.')
                data = self.rfile.read(length)
                if path == '/api/blob': return self.json_response({'key': self.portable.save_blob(data)})
                request_data = json.loads(data)
                if path == '/api/batch':
                    self.portable.batch(request_data)
                    return self.json_response(self.portable.status())
                if path == '/api/publish': return self.json_response(self.portable.publish())
                if path == '/api/open-shared': return self.json_response(self.portable.open_shared())
            raise ValueError('Unknown API route.')
        except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
            return self.json_response({'error': str(exc)}, 409)

    def do_GET(self):
        if not self.allowed():
            self.send_error(403, 'Host not allowed')
            return
        path = urlsplit(self.path).path
        if path == '/api/mode': return self.json_response({'portable': bool(self.portable)})
        if path.startswith('/api/'): return self.api('GET')
        if path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        if path not in FILES:
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        return self.api('POST')

    def do_HEAD(self):
        if urlsplit(self.path).path not in FILES:
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP.replace("connect-src 'none'", "connect-src 'self'"))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', choices=['127.0.0.1', '0.0.0.0'], default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data-dir', help='Local working archive, outside Proton Drive')
    parser.add_argument('--shared-dir', help='Proton Drive folder for published versions')
    args = parser.parse_args()
    if bool(args.data_dir) != bool(args.shared_dir):
        parser.error('--data-dir and --shared-dir must be provided together')
    if args.data_dir:
        Handler.portable = PortableStore(args.data_dir, args.shared_dir)
    Handler.port = args.port
    try:
        server = ThreadingHTTPServer((args.bind, args.port), partial(Handler, directory=str(ROOT)))
    except OSError as exc:
        raise SystemExit(f'Port {args.port} unavailable. Close any previous PAP instance.\n' + str(exc))
    print(f'BreathPAPGuardian: http://127.0.0.1:{args.port}\nLeave this window open. Press Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nBreathPAPGuardian stopped.')
    finally:
        server.server_close()

