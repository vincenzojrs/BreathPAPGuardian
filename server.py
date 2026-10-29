#!/usr/bin/env python3
"""Serve the bundled app; optionally enable a loopback portable archive."""
import argparse
import json
import sqlite3
import zlib
import signal
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from portable_store import PortableStore

ROOT = Path(__file__).resolve().parent / 'web'
FILES = {'/', '/index.html', '/app.js', '/portable.js', '/import-delta.js', '/philips.js', '/dreamstation2.js', '/import-files.js', '/core.js', '/polar.js', '/polar-time.js', '/polar-csv.js', '/style.css', '/pdf-export.js', '/glasgow.js', '/glasgow-ui.js', '/glasgow-worker.js', '/vendor/glasgow-reference.js'}
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
            token = self.headers.get('X-BPG-Session', '')
            if action == 'GET':
                if path == '/api/status': return self.json_response(self.portable.status())
                if path == '/api/versions': return self.json_response(self.portable.versions())
                if path == '/api/recoveries': return self.json_response(self.portable.recoveries())
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
                if path == '/api/blob': return self.json_response({'key': self.portable.save_blob(data, token)})
                request_data = json.loads(data)
                if path == '/api/session/start': return self.json_response(self.portable.start())
                if path == '/api/session/confirm': return self.json_response(self.portable.confirm(token))
                if path == '/api/session/recover': return self.json_response(self.portable.takeover(token))
                if path == '/api/session/close': return self.json_response(self.portable.release(token))
                if path == '/api/session/leave': return self.json_response(self.portable.leave(token))
                if path == '/api/operation/begin': return self.json_response(self.portable.begin(request_data['kind'], token))
                if path == '/api/operation/end': return self.json_response(self.portable.end(token))
                if path == '/api/operation/pause': return self.json_response(self.portable.pause(token))
                if path == '/api/operation/discard': return self.json_response(self.portable.discard(token))
                if path == '/api/operation/preview': return self.json_response(self.portable.preview_pending(token))
                if path == '/api/operation/accept': return self.json_response(self.portable.accept_restore(token))
                if path == '/api/resolve': return self.json_response(self.portable.resolve(request_data['choice'], token))
                if path == '/api/restore-version': return self.json_response(self.portable.restore_version(request_data['id'], token))
                if path == '/api/restore-recovery': return self.json_response(self.portable.restore_recovery(request_data['id'], token))
                if path == '/api/protect': return self.json_response(self.portable.protect(request_data['id'], request_data['enabled'], token))
                if path == '/api/cleanup': return self.json_response(self.portable.cleanup(request_data['versions'], request_data.get('execute', False), request_data.get('token', ''), token))
                if path == '/api/batch':
                    self.portable.batch(request_data, token)
                    return self.json_response(self.portable.status())
                if path == '/api/publish': return self.json_response(self.portable.publish(token))
                if path == '/api/open-shared': return self.json_response(self.portable.open_shared())
            raise ValueError('Unknown API route.')
        except (ValueError, KeyError, TypeError, OSError, sqlite3.Error, zlib.error) as exc:
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
    parser.add_argument('--browser-storage', action='store_true', help='Explicit IndexedDB mode for compatibility/tests')
    args = parser.parse_args()
    if bool(args.data_dir) != bool(args.shared_dir):
        parser.error('--data-dir and --shared-dir must be provided together')
    if not args.data_dir and not args.browser_storage and json.loads((Path(__file__).resolve().parent / 'storage-mode.json').read_text())['default'] == 'portable':
        parser.error('Portable branch requires --data-dir and --shared-dir. See docs/portable-archive.md.')
    if args.data_dir and args.browser_storage:
        parser.error('Choose portable or explicit browser storage, not both')
    if args.data_dir:
        Handler.portable = PortableStore(args.data_dir, args.shared_dir)
    Handler.port = args.port
    try:
        server = ThreadingHTTPServer((args.bind, args.port), partial(Handler, directory=str(ROOT)))
    except OSError as exc:
        raise SystemExit(f'Port {args.port} unavailable. Close any previous PAP instance.\n' + str(exc))
    print(f'BreathPAPGuardian: http://127.0.0.1:{args.port}\nLeave this window open. Press Ctrl+C to stop.', flush=True)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nBreathPAPGuardian stopped.')
    finally:
        server.server_close()
        if Handler.portable:
            try:
                if Handler.portable.writer:
                    Handler.portable.publish()
            except (ValueError, OSError, sqlite3.Error) as exc:
                print('Local data preserved; publication pending: ' + str(exc), flush=True)
            Handler.portable.close()

