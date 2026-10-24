#!/usr/bin/env python3
"""Create review patches only. Never stages, commits, pushes or deploys.
Usage: python3 scripts/deploy/build-infrastructure-release.py [output-directory]
Patches target the recorded HEADs, not the dirty worktrees. Verify in clean copies.
"""
import difflib
import hashlib
import json
from pathlib import Path
import subprocess
import sys

backend = Path(__file__).resolve().parents[2]
frontend = backend.parent / 'ITsNomatataWorkSpace'
output = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/kodex-infrastructure-stage-b1-release')
output.mkdir(parents=True, exist_ok=True)
manifest = backend / 'docs/architecture/infrastructure-control-center-stage-b-files.txt'
groups = {}; group = None
for line in manifest.read_text().splitlines():
    if line.startswith('['):
        group = line.strip('[]'); groups[group] = []
    elif line and not line.startswith('#'):
        groups[group].append(line)

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode()

records = {}
for name, root in [('kode-platform', backend), ('ITsNomatataWorkSpace', frontend)]:
    head = git(root, 'rev-parse', 'HEAD').strip()
    patches = []; files = []
    for path in groups[name]:
        try: before = git(root, 'show', f'HEAD:{path}')
        except subprocess.CalledProcessError: before = ''
        after = (root / path).read_text()
        if name == 'kode-platform' and path == 'Dockerfile':
            # Construct from HEAD + exactly the infrastructure target, preserving HEAD media contents.
            start = after.index('# Opt-in independent authentication runtime;')
            end = after.index('FROM runtime AS api', start)
            after = before.replace('FROM runtime AS api', after[start:end] + 'FROM runtime AS api')
        if name == 'kode-platform' and path == 'package.json':
            base = json.loads(before); working = json.loads(after)
            for key in ('dev:infrastructure','start:infrastructure','infra:accounts',
                        'test:infrastructure','test:infrastructure:browser'):
                base['scripts'][key] = working['scripts'][key]
            base['scripts']['test'] += ' tests/infrastructure.test.ts'
            base['dependencies']['otplib'] = working['dependencies']['otplib']
            # Keep normal dependency alphabetical order to minimize the diff.
            base['dependencies'] = dict(sorted(base['dependencies'].items()))
            after = json.dumps(base, indent=2) + '\n'
        if before == after:
            raise RuntimeError(f'Manifest file contains no release change: {name}/{path}')
        if any(x in path.lower() for x in ('obligationbanner','password.html','media-platform','tickets/','attendance/')):
            raise RuntimeError(f'Unrelated path in release: {path}')
        diff = ''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),
                         fromfile=f'a/{path}' if before else '/dev/null',tofile=f'b/{path}',n=3))
        patch = f'diff --git a/{path} b/{path}\n'
        if not before: patch += 'new file mode 100644\n'
        patch += diff
        patches.append(patch)
        files.append({'path':path,'base_sha256':hashlib.sha256(before.encode()).hexdigest() if before else None,
                      'release_sha256':hashlib.sha256(after.encode()).hexdigest(),
                      'hunks':[line for line in diff.splitlines() if line.startswith('@@')]})
    text = ''.join(patches)
    target = output / f'{name}.patch'; target.write_text(text)
    records[name] = {'base_commit':head,'patch':target.name,
                     'patch_sha256':hashlib.sha256(text.encode()).hexdigest(),'files':files}
(output / 'manifest.json').write_text(json.dumps(records,indent=2)+'\n')
(output / 'README.txt').write_text('Stage B + B.1 REVIEW PATCHES ONLY. No deployment authorization.\n'
    'Apply only to clean copies of the exact base_commit in manifest.json.\n'
    'The manifest records every file hash and hunk. No original index was modified.\n'
    'Dockerfile: infrastructure target only; package.json: infrastructure scripts, unit-test registration and otplib only.\n'
    'Excluded: dirty media worker/tests, media, tickets, attendance, password and ObligationBanner.\n'
    'Production prerequisites and test limitations: docs/architecture/infrastructure-control-center-stage-b1.md.\n')
print(f'Review patches and exact hunk/hash manifest: {output}')
