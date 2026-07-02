// Shared crypto + manifest helpers for the doze module registry.
//
// The signing scheme is byte-for-byte interoperable with the doze client
// (doze-sdk/binaries): a publisher key is a raw 32-byte ed25519 public key,
// base64-encoded; a signature is ed25519 over the *lowercase-hex SHA256 string*
// of the archive, base64-encoded. Verify on the client:
//   ed25519.Verify(pub, []byte(hexSha), sig)
import {
	createHash,
	createPublicKey,
	createPrivateKey,
	generateKeyPairSync,
	sign as nodeSign,
	verify as nodeVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

export const RAW_PUBKEY_BYTES = 32;

// generateKeypair returns { publicKey, privateKey } where publicKey is the raw
// 32-byte ed25519 key (base64, as it appears in keys.json) and privateKey is the
// PKCS8 DER (base64) — the secret a publisher keeps and feeds to sign().
export function generateKeypair() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-RAW_PUBKEY_BYTES);
	const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
	return { publicKey: rawPub.toString('base64'), privateKey: pkcs8.toString('base64') };
}

// publicKeyObject builds a verify-capable KeyObject from a raw 32-byte base64 key.
export function publicKeyObject(rawB64) {
	const raw = Buffer.from(rawB64, 'base64');
	if (raw.length !== RAW_PUBKEY_BYTES) {
		throw new Error(`public key is ${raw.length} bytes, want ${RAW_PUBKEY_BYTES}`);
	}
	return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

// privateKeyObject builds a sign-capable KeyObject from a PKCS8 DER base64 secret.
export function privateKeyObject(pkcs8B64) {
	return createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
}

// publicFromPrivate derives the raw 32-byte base64 public key from a PKCS8 secret,
// so a publisher can confirm its secret matches the namespace's committed keys.json
// before signing (signing with the wrong key would just fail validation later).
// Exported via JWK (the x field IS the raw key) rather than DER slicing — Bun's
// DER export of a derived public KeyObject is broken (Bun 1.2.x), JWK is not.
export function publicFromPrivate(pkcs8B64) {
	const jwk = createPublicKey(privateKeyObject(pkcs8B64)).export({ format: 'jwk' });
	return Buffer.from(jwk.x, 'base64url').toString('base64');
}

// assertSigningRuntime verifies this JS runtime's ed25519 stack actually works
// before any key is generated or anything is signed: keypair generation, deriving
// the public key from the private, and a sign/verify round-trip. Bun (≤1.2.x at
// least) silently returns garbage from the public-key derivation path — with a
// namespace key at stake, a broken runtime must be a loud error, not a wrong
// "key does not match" or (worse) a keys.json that doesn't match its own secret.
// A functional check rather than a runtime sniff, so it self-heals when fixed.
export function assertSigningRuntime() {
	let ok = false;
	try {
		const { publicKey, privateKey } = generateKeypair();
		const derived = publicFromPrivate(privateKey);
		const sig = sign(privateKeyObject(privateKey), sha256Hex(Buffer.from('doze-runtime-selftest')));
		ok = derived === publicKey && verify(publicKeyObject(publicKey), sha256Hex(Buffer.from('doze-runtime-selftest')), sig);
	} catch {
		ok = false;
	}
	if (!ok) {
		const runtime = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `this runtime (${process.version ?? 'unknown'})`;
		console.error(
			`✗ ${runtime} fails the ed25519 self-test (key derivation/signing is broken — known in Bun 1.2.x).\n` +
				`  Run key operations under Node instead:\n` +
				`    npm run keygen | npm run sign | npm run publish   (already mapped to node)\n` +
				`    or: node scripts/<script>.mjs …`
		);
		process.exit(1);
	}
}

// sha256Hex returns the lowercase-hex SHA256 of a buffer — the value that is signed.
export function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

// sign returns a base64 ed25519 signature over the hex SHA256 string.
export function sign(privKeyObj, hexSha) {
	return nodeSign(null, Buffer.from(hexSha), privKeyObj).toString('base64');
}

// verify checks a base64 signature over the hex SHA256 string against a pubkey.
export function verify(pubKeyObj, hexSha, sigB64) {
	if (!sigB64) return false;
	try {
		return nodeVerify(null, Buffer.from(hexSha), pubKeyObj, Buffer.from(sigB64, 'base64'));
	} catch {
		return false;
	}
}

// loadKeys reads a namespace keys.json: { namespace, key }.
export function loadKeys(path) {
	const doc = JSON.parse(readFileSync(path, 'utf8'));
	if (!doc.key) throw new Error(`${path}: missing "key"`);
	return doc;
}

export function parseYaml(text) {
	return parse(text);
}
export function toYaml(obj) {
	return stringify(obj, { lineWidth: 0 });
}

// SCHEMA is the module index schema this registry serves (doze-sdk/modindex).
export const SCHEMA = 1;

// eachArtifact yields { version, triple, art, release } over a parsed schema-1
// index.yaml (releases.<version>.artifacts.<triple>).
export function* eachArtifact(idx) {
	for (const [version, release] of Object.entries(idx?.releases ?? {})) {
		for (const [triple, art] of Object.entries(release?.artifacts ?? {})) {
			yield { version, triple, art, release };
		}
	}
}

// canonicalIndexPayload renders the signed portion of a schema-1 index —
// module, namespace, releases, channels — as canonical JSON: object keys sorted
// at every level, no whitespace, empty optional fields omitted, sha256
// lowercased. Byte-for-byte identical to the doze client's
// modindex.CanonicalPayload (Go json.Marshal sorts map keys), so a signature
// made here verifies there.
export function canonicalIndexPayload(idx) {
	const releases = {};
	for (const [v, r] of Object.entries(idx?.releases ?? {})) {
		const rel = { protocol: Number(r?.protocol ?? 0) };
		if (Array.isArray(r?.engines) && r.engines.length > 0) rel.engines = r.engines.map(String);
		const artifacts = {};
		for (const [triple, a] of Object.entries(r?.artifacts ?? {})) {
			const art = { url: String(a?.url ?? ''), sha256: String(a?.sha256 ?? '').toLowerCase() };
			if (a?.sig) art.sig = String(a.sig);
			artifacts[triple] = art;
		}
		rel.artifacts = artifacts;
		releases[v] = rel;
	}
	const payload = {
		module: String(idx?.module ?? ''),
		namespace: String(idx?.namespace ?? ''),
		releases,
		channels: idx?.channels ?? {},
	};
	return stableStringify(payload);
}

// stableStringify is JSON.stringify with object keys sorted recursively — the
// JS half of the canonical form shared with Go.
function stableStringify(v) {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	if (v !== null && typeof v === 'object') {
		const keys = Object.keys(v).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
	}
	return JSON.stringify(v);
}

// signIndex computes the index-level signature: ed25519 over the lowercase-hex
// SHA256 of the canonical payload (the same hex-sha convention as artifacts).
export function signIndex(privKeyObj, idx) {
	return sign(privKeyObj, sha256Hex(Buffer.from(canonicalIndexPayload(idx))));
}

// verifyIndex checks an index's signature field against the namespace key.
export function verifyIndex(pubKeyObj, idx) {
	if (!idx?.signature) return false;
	return verify(pubKeyObj, sha256Hex(Buffer.from(canonicalIndexPayload(idx))), idx.signature);
}
