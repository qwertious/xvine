"""Build the portable test zip: xvine/dist/xvine-<version>.zip

Contains the server, UI, docs, launchers and tests -- never any data (archives
and indexes live in the user's data directory). Shell scripts keep their
executable bit so `./start-xvine.sh` works straight after unzip.

    python tools/build-zip.py
"""
import json
import os
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['version']
NAME = 'xvine-' + VERSION
INCLUDE_DIRS = ['server', 'web', 'docs', 'test']
INCLUDE_FILES = ['README.md', 'TESTING.md', 'package.json', 'start-xvine.sh', 'start-xvine.cmd']
SKIP_EXT = {'.pyc', '.part', '.zim', '.sqlite'}


def add(zf, rel):
    src = os.path.join(ROOT, rel)
    info = zipfile.ZipInfo(NAME + '/' + rel.replace(os.sep, '/'), time.localtime(os.path.getmtime(src))[:6])
    info.compress_type = zipfile.ZIP_DEFLATED
    mode = 0o755 if rel.endswith('.sh') else 0o644
    info.external_attr = (0o100000 | mode) << 16
    data = open(src, 'rb').read()
    if rel.endswith('.sh'):
        data = data.replace(b'\r\n', b'\n')
    zf.writestr(info, data)


def main():
    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, NAME + '.zip')
    n = 0
    with zipfile.ZipFile(out, 'w') as zf:
        for d in INCLUDE_DIRS:
            for base, dirs, files in os.walk(os.path.join(ROOT, d)):
                dirs[:] = sorted(x for x in dirs if not x.startswith('.') and x != 'node_modules')
                for f in sorted(files):
                    if os.path.splitext(f)[1] in SKIP_EXT:
                        continue
                    add(zf, os.path.relpath(os.path.join(base, f), ROOT))
                    n += 1
        for f in INCLUDE_FILES:
            add(zf, f)
            n += 1
    print('%s  %d files  %.1f KB' % (out, n, os.path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
