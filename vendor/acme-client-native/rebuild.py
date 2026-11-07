"""Reproduce the private native-only artifact from its verified upstream tarball.

Usage: python3 vendor/acme-client-native/rebuild.py .ai/vendor-reproduction
No installation, source-tree modification, npm publication or crypto patching.
"""
import base64
import difflib
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import urllib.request

source = json.loads(Path(__file__).with_name('upstream.json').read_text())
with urllib.request.urlopen(source['dist']['tarball'], timeout=45) as response:
    upstream = response.read()
integrity = lambda b: 'sha512-' + base64.b64encode(hashlib.sha512(b).digest()).decode()
assert integrity(upstream) == source['dist']['integrity'], 'upstream integrity mismatch'
original = {}
with tarfile.open(fileobj=io.BytesIO(upstream), mode='r:gz') as archive:
    for member in archive:
        assert member.isfile() and member.name.startswith('package/') and '..' not in Path(member.name).parts
        original[member.name.removeprefix('package/')] = archive.extractfile(member).read()
files = dict(original)
manifest = json.loads(files['package.json'])
assert manifest['name'] == 'acme-client' and manifest['version'] == '5.4.0'
assert manifest['dependencies'].pop('node-forge') == '^1.3.1'
manifest.update(name='@miwkey/acme-client-native', version='5.4.0-miwkey.1', private=True)
files['package.json'] = (json.dumps(manifest, indent=4) + '\n').encode()
index = files['src/index.js'].decode()
line = "exports.forge = require('./crypto/forge');\n"
assert index.count(line) == 1
files['src/index.js'] = index.replace(line, '').encode()
types = files['types/index.d.ts'].decode()
start = types.index('/* TODO: LEGACY */')
end = types.index('/**\n * Axios', start)
assert 'export const forge: CryptoLegacyInterface;' in types[start:end]
files['types/index.d.ts'] = (types[:start] + types[end:]).encode()
del files['src/crypto/forge.js']
assert files['LICENSE'] == original['LICENSE']
patch = ''.join(''.join(difflib.unified_diff(
    original.get(name, b'').decode().splitlines(keepends=True),
    files.get(name, b'').decode().splitlines(keepends=True),
    fromfile='a/' + name, tofile='b/' + name, n=0))
    for name in sorted(set(original) | set(files)) if original.get(name) != files.get(name))
output = io.BytesIO()
with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo('package/' + name)
            member.size = len(data)
            member.mode = 0o644
            member.mtime = 0
            archive.addfile(member, io.BytesIO(data))
artifact = output.getvalue()
filename = 'acme-client-native-5.4.0-miwkey.1.tgz'
provenance = {
    'upstream': source, 'name': manifest['name'], 'version': manifest['version'],
    'license': 'MIT', 'filename': filename, 'integrity': integrity(artifact),
    'sha256': hashlib.sha256(artifact).hexdigest(),
    'changes': ['private package identity', 'remove node-forge dependency',
                'remove unused legacy forge export and type interface',
                'remove src/crypto/forge.js; all other source files unchanged'],
    'filesSha256': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
    'unchangedFiles': sorted(name for name in files if files[name] == original[name]),
    'removedFiles': ['src/crypto/forge.js'],
}
target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
for name, data in {filename: artifact, 'native-only.patch': patch.encode(),
                   'LICENSE': files['LICENSE'],
                   'provenance.json': (json.dumps(provenance, indent=2) + '\n').encode()}.items():
    path = target / name
    if path.exists():
        assert path.read_bytes() == data, f'{path} differs; will not overwrite'
    else:
        path.write_bytes(data)
print(json.dumps({'filename': filename, 'integrity': provenance['integrity'],
                  'sha256': provenance['sha256'], 'files': len(files)}))
