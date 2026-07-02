// sign — add (or refresh) a signed artifact entry in a module's schema-1
// index.yaml, then re-sign the index. The manual, per-artifact counterpart to
// publish.mjs (which signs a whole dzm release at once).
//
//   DOZE_SIGNING_KEY="$(cat doze.secret.key)" \
//     node scripts/sign.mjs <namespace>/<name> <version> <triple> <url> <archive> \
//       [--protocol N] [--engines 14,15,16]
//
// <archive> is a local path to the .tar.gz that <url> will serve (its SHA256 is
// hashed and signed). --protocol (default 1) and --engines set the release's
// compatibility metadata when the release is new; an existing release keeps its
// metadata. <version> becomes the "stable" channel head when it sorts highest.
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { privateKeyObject, sign, signIndex, sha256Hex, parseYaml, toYaml, SCHEMA, assertSigningRuntime } from './lib.mjs';

assertSigningRuntime();

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [source, version, triple, url, archive] = args;
if (!source || !version || !triple || !url || !archive) {
	console.error('usage: node scripts/sign.mjs <namespace>/<name> <version> <triple> <url> <archive.tar.gz> [--protocol N] [--engines 14,15]');
	process.exit(2);
}
const secret = process.env.DOZE_SIGNING_KEY;
if (!secret) {
	console.error('set DOZE_SIGNING_KEY to the namespace secret (PKCS8 base64 from keygen)');
	process.exit(2);
}
const [ns, name] = source.split('/');
if (!ns || !name) {
	console.error(`invalid source ${source}: want <namespace>/<name>`);
	process.exit(2);
}

const hex = sha256Hex(readFileSync(archive));
const priv = privateKeyObject(secret);

const dir = `registry/${ns}/${name}`;
const idxPath = `${dir}/index.yaml`;
let idx = { schema: SCHEMA, module: name, namespace: ns, releases: {}, channels: {} };
if (existsSync(idxPath)) {
	const existing = parseYaml(readFileSync(idxPath, 'utf8'));
	if (existing?.schema === SCHEMA) {
		idx = existing;
	} else {
		console.error(`note: discarding pre-schema index at ${idxPath}`);
	}
}
idx.releases ??= {};
idx.channels ??= {};

const rel = (idx.releases[version] ??= { protocol: Number(argValue('--protocol') ?? 1), artifacts: {} });
if (argValue('--engines')) rel.engines = argValue('--engines').split(',').map((s) => s.trim()).filter(Boolean);
rel.artifacts ??= {};
rel.artifacts[triple] = { url, sha256: hex, sig: sign(priv, hex) };

// stable tracks the highest release (numeric dotted compare).
const byVersion = (a, b) => {
	const as = a.split('.').map(Number), bs = b.split('.').map(Number);
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const d = (as[i] ?? 0) - (bs[i] ?? 0);
		if (d) return d;
	}
	return 0;
};
idx.channels.stable = Object.keys(idx.releases).sort(byVersion).at(-1);
idx.signature = signIndex(priv, idx);

mkdirSync(dir, { recursive: true });
writeFileSync(idxPath, toYaml(idx));
console.log(`✓ signed ${source} ${version} ${triple}`);
console.log(`  sha256 ${hex}`);
console.log(`  -> ${idxPath} (stable: ${idx.channels.stable})`);

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
