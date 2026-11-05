import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from portable_store import PortableStore


class IsolatedLauncherTests(unittest.TestCase):
    def test_copy_receives_changes_without_touching_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = PortableStore(root/'original-work', root/'original-shared')
            try:
                original.batch({'put':[['markers', {'id':'source'}]]})
                original.publish()
            finally:
                original.close()
            shared = root/'original-shared'
            latest = (shared/'latest.json').read_bytes()
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0))
                port = sock.getsockname()[1]
            script = Path(__file__).resolve().parents[1]/'tools'/'start_isolated_test.py'
            env = dict(os.environ, BROWSER='/usr/bin/true')
            proc = subprocess.Popen([sys.executable,str(script),'--source',str(shared),'--test-root',str(root/'test'),
                                     '--client','A','--port',str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            def call(path, data=None, token=''):
                body = None if data is None else json.dumps(data).encode()
                req = Request(f'http://127.0.0.1:{port}/api/{path}',data=body,
                              headers={'X-BPG-Local':'1','X-BPG-Session':token,'Content-Type':'application/json'})
                with urlopen(req,timeout=3) as response:
                    return json.loads(response.read())
            try:
                for _ in range(150):
                    try:
                        token = call('session/start',{})['token']
                        break
                    except (URLError,ConnectionError):
                        if proc.poll() is not None:
                            self.fail('Test launcher stopped before server started')
                        time.sleep(.03)
                else:
                    self.fail('Test launcher did not start')
                call('session/confirm',{},token)
                call('batch',{'put':[['markers',{'id':'test-only'}]]},token)
                call('publish',{},token)
                self.assertEqual((shared/'latest.json').read_bytes(),latest)
                self.assertNotEqual((root/'test'/'shared-copy'/'latest.json').read_bytes(),latest)
            finally:
                proc.terminate()
                proc.wait(timeout=10)
