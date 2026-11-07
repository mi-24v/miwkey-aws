import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validate} from '../src/certificate';
const corpus = JSON.parse(readFileSync(process.env.CERTIFICATE_CORPUS || 'test/fixtures/certificate-corpus.json', 'utf8'));
const review = JSON.parse(readFileSync(process.env.REVIEW_CERTIFICATE_CORPUS || 'test/fixtures/review-corpus.json', 'utf8'));
const encoding = JSON.parse(readFileSync('test/fixtures/encoding-corpus.json', 'utf8'));
const der = JSON.parse(readFileSync('test/fixtures/der-corpus.json', 'utf8'));
const paths = JSON.parse(readFileSync('test/fixtures/path-corpus.json', 'utf8'));
const policy = JSON.parse(readFileSync('test/fixtures/policy-corpus.json', 'utf8'));
for (const c of [...corpus.cases,...review.cases,...encoding.cases,...der.cases,...paths.cases.map((c: any)=>({...c,fqdn:paths.fqdn})),...policy.cases.map((c:any)=>({...c,fqdn:c.fqdn||policy.fqdn}))]) {
  test(`certificate oracle: ${c.name}`, async () => {
    assert.equal(c.accepted, c.expected, 'Python oracle drifted from recorded policy');
    let meta: unknown; let accepted = false;
    try { meta = await validate(c.value, c.fqdn || corpus.fqdn, c.roots, new Date(c.now || corpus.now)); accepted = true; }
    catch (e) { assert.equal((e as Error).message, 'certificate validation failed'); }
    // Intentional strengthening approved after comparison: empty KU and exact expiry are rejected.
    assert.equal(accepted, c.tsExpected ?? (['ku-empty', 'notafter-boundary'].includes(c.name) ? false : c.accepted), `${c.name}: TypeScript/Python acceptance differs`);
    if (accepted) assert.deepEqual(meta, c.meta);
  });
}

test('production and staging trust are pinned disjoint certificate sets', () => {
  const {createHash, X509Certificate} = require('node:crypto');
  const pub = readFileSync('public-roots.pem');
  const pins = JSON.parse(readFileSync('trust.json', 'utf8'));
  assert.equal(createHash('sha256').update(pub).digest('hex'), pins.sha256);
  const fingerprints = (s: string) => (s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map(p => new X509Certificate(p).fingerprint256);
  const roots = fingerprints(pub.toString());
  const staging = fingerprints(readFileSync('staging-roots.pem', 'utf8'));
  assert.ok(roots.length > 100 && staging.length > 0);
  assert.equal(staging.some(f => roots.includes(f)), false);
});
