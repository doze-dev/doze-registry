// conformance-check — verifies the JS signing scheme in lib.mjs against the
// checked-in fixture shared with the Go verifier, guarding JS<->Go drift of the
// ed25519 / lowercase-hex-SHA256 / schema-1 canonical-payload format.
//
//   bun run test:conformance     (or: bun scripts/conformance-check.mjs)
//
// The fixture's byte-identical twin lives in the doze-sdk repo at
// doze-sdk/modindex/testdata/conformance/fixture.json, exercised by
// doze-sdk/modindex/conformance_test.go (go test ./modindex/). If either test
// fails after a signing-scheme change, the two implementations have drifted —
// fix the code, don't regenerate the fixture to paper over it.
//
// Checks, per side of the scheme:
//   1. verify   — the fixture index + artifact sigs verify with lib.mjs against
//                 the fixture's raw-32-byte public key.
//   2. re-sign  — signing the same payloads with the fixture's throwaway
//                 private key reproduces the checked-in signatures byte-for-byte
//                 (ed25519 is deterministic), pinning the canonical payload.
//   3. tamper   — mutating signed metadata must break verification.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicKeyObject, privateKeyObject, sign, verify, signIndex, verifyIndex, eachArtifact } from './lib.mjs';

const fixturePath = fileURLToPath(new URL('./testdata/conformance/fixture.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const idx = fixture.index;
const pub = publicKeyObject(fixture.publicKey);
const priv = privateKeyObject(fixture.privateKeyPkcs8);

let failed = 0;
const check = (name, ok) => {
	console.log(`${ok ? '✓' : '✗'} ${name}`);
	if (!ok) failed++;
};

// 1. Verify the fixture with the lib.mjs verification path.
check('index signature verifies', verifyIndex(pub, idx));
let artifacts = 0;
for (const { version, triple, art } of eachArtifact(idx)) {
	artifacts++;
	check(`artifact sig verifies (${version} ${triple})`, verify(pub, String(art.sha256).toLowerCase(), art.sig));
}
check('fixture has at least one artifact', artifacts > 0);

// 2. Re-sign with the fixture's test key: ed25519 is deterministic, so the
//    signatures must reproduce exactly — any canonical-payload drift shows here.
check('re-signed index signature is byte-identical', signIndex(priv, { ...idx }) === idx.signature);
for (const { version, triple, art } of eachArtifact(idx)) {
	check(`re-signed artifact sig is byte-identical (${version} ${triple})`, sign(priv, art.sha256) === art.sig);
}

// 3. Tampered metadata must fail verification (the signature covers channels).
const tampered = structuredClone(idx);
tampered.channels.stable = '9.9.9';
check('tampered channels fail verification', !verifyIndex(pub, tampered));

if (failed) {
	console.error(`✗ conformance: ${failed} check(s) failed — JS and Go signing schemes may have drifted`);
	process.exit(1);
}
console.log('✓ conformance: JS signing scheme matches the checked-in fixture');
