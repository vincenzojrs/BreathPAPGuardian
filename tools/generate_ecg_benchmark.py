#!/usr/bin/env python3
"""Create a two-hour synthetic ECG fixture outside the repository."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)
base = 1700000000000000000
for hour in range(2):
    path = args.directory / f'{hour:03d}_ecg.csv'
    with path.open('x') as out:
        out.write('timestamp_unix_ns,ecg_uv,connection_segment\n')
        for i in range(130*3600):
            timestamp = base+(hour*3600*130+i)*1000000000//130
            out.write(f'{timestamp},{i%200-100},1\n')
