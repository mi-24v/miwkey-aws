// Run by mounting only this file into the production image; no host dependencies.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, readdirSync, existsSync, realpathSync} = require('node:fs');
const {join} = require('node:path');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const directory = '/var/task/lambda/extension-cert-issuer';
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const runtimeRequire = createRequire(join(directory, 'package.json'));

test('image runs the pinned Node and OpenSSL on AL2023 x86', () => {
  const pins = read('runtime-pins.json');
  assert.equal(process.versions.node, pins.node);
  assert.equal(process.arch, 'x64');
  assert.match(readFileSync('/etc/os-release', 'utf8'), /VERSION_ID="2023"/);
  for (const [file, expected] of Object.entries(pins.sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), expected, file);
  }
  const version = execFileSync('/usr/bin/openssl', ['version'], {env: {PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null'}}).toString();
  assert.match(version, /^OpenSSL 3\.5\.8 /);
  assert.equal(createHash('sha256').update(readFileSync(join(directory, 'public-roots.pem'))).digest('hex'), read('trust.json').sha256);
});

test('image resolves its production dependencies within the artifact', () => {
  for (const name of Object.keys(read('package.json').dependencies)) {
    assert.ok(realpathSync(runtimeRequire.resolve(name)).startsWith('/var/task/'), name);
  }
  for (const name of ['typescript', 'jest', 'ts-jest', 'aws-cdk-lib', 'constructs', 'zod']) {
    assert.throws(() => runtimeRequire.resolve(name), {code: 'MODULE_NOT_FOUND'}, name);
  }
  assert.equal(typeof runtimeRequire('./dist/handler').handler, 'function');
});

test('image contains deployed JavaScript and trust data without the oracle or development inputs', () => {
  assert.deepEqual(readdirSync(directory).sort(), ['dist', 'node_modules', 'package.json', 'public-roots.pem', 'runtime-pins.json', 'staging-roots.pem', 'trust.json']);
  assert.deepEqual(readdirSync(join(directory, 'dist')).sort(), ['acme.js', 'aws.js', 'certificate.js', 'dns.js', 'errors.js', 'handler.js', 'workflow.js']);
  for (const file of ['/usr/bin/python', '/usr/bin/python3', '/usr/bin/pip', '/usr/bin/pip3', '/var/task/package.json']) {
    assert.equal(existsSync(file), false, file);
  }
});

test('native-only ACME artifact excludes Forge exports, implementation and dependency',()=>{
  const acme=runtimeRequire('acme-client');assert.equal(Object.hasOwn(acme,'forge'),false);
  assert.throws(()=>runtimeRequire.resolve('node-forge'),{code:'MODULE_NOT_FOUND'});
  const manifestPath=runtimeRequire.resolve('acme-client/package.json');const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.equal(manifest.name,'@miwkey/acme-client-native');assert.equal(manifest.dependencies['node-forge'],undefined);
  assert.equal(existsSync(join(manifestPath,'../src/crypto/forge.js')),false);
  const provenance=JSON.parse(readFileSync('/proof/acme-provenance.json','utf8'));
  for(const [file,hash] of Object.entries(provenance.filesSha256))assert.equal(createHash('sha256').update(readFileSync(join(manifestPath,'..',file))).digest('hex'),hash,file);
});
