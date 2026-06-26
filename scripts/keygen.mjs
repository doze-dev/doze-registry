// keygen — create a namespace's publisher keypair.
//
//   bun scripts/keygen.mjs <namespace>
//
// Writes the PUBLIC key to registry/<namespace>/keys.json (commit this) and the
// SECRET key to <namespace>.secret.key (gitignored — keep it safe; this is what
// signs releases). The registry trusts a namespace by its committed public key,
// so losing the secret means rotating the key (and every client re-pinning it).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { generateKeypair } from './lib.mjs';

const ns = process.argv[2];
if (!ns || !/^[a-z0-9][a-z0-9-]*$/.test(ns)) {
	console.error('usage: bun scripts/keygen.mjs <namespace>   (lowercase, [a-z0-9-])');
	process.exit(2);
}

const keysPath = `registry/${ns}/keys.json`;
const secretPath = `${ns}.secret.key`;
if (existsSync(keysPath) || existsSync(secretPath)) {
	console.error(`refusing to overwrite existing ${keysPath} or ${secretPath}`);
	process.exit(1);
}

const { publicKey, privateKey } = generateKeypair();
mkdirSync(`registry/${ns}`, { recursive: true });
writeFileSync(keysPath, JSON.stringify({ namespace: ns, key: publicKey }, null, 2) + '\n');
writeFileSync(secretPath, privateKey + '\n', { mode: 0o600 });

console.log(`✓ wrote ${keysPath} (public — commit this)`);
console.log(`✓ wrote ${secretPath} (SECRET — gitignored; store in a vault / CI secret)`);
console.log('');
console.log('Publish/sign releases with the secret available as DOZE_SIGNING_KEY:');
console.log(`  export DOZE_SIGNING_KEY="$(cat ${secretPath})"`);
