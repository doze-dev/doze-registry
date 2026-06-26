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

// eachArtifact yields { engine, version, triple, art } over a parsed index.yaml.
export function* eachArtifact(manifest) {
	for (const [engine, em] of Object.entries(manifest?.engines ?? {})) {
		for (const [version, triples] of Object.entries(em?.artifacts ?? {})) {
			for (const [triple, art] of Object.entries(triples ?? {})) {
				yield { engine, version, triple, art };
			}
		}
	}
}
