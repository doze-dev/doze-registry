// publish — sign an entire module release into the registry.
//
//   DOZE_SIGNING_KEY="$(cat doze.secret.key)" \
//     bun scripts/publish.mjs <namespace>/<name> [--release-base <url>]
//
// Reads the module's release manifest (default: the doze-modules GitHub release
// for <name>), rewrites every artifact URL to an absolute link, and signs each
// artifact's SHA256 with the namespace key. Writes registry/<ns>/<name>/index.yaml.
//
// It does NOT download the archives — it signs the SHA256 the release manifest
// already published (built by our own CI). `validate --remote` is the gate: it
// re-downloads each archive and confirms the SHA256 matches the signed value
// before anything is trusted or deployed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { privateKeyObject, sign, parseYaml, toYaml, eachArtifact, publicFromPrivate, loadKeys } from './lib.mjs';

const DEFAULT_RELEASE_BASE = 'https://github.com/doze-dev/doze-modules/releases/download';

const source = process.argv[2];
const baseFlag = argValue('--release-base');
if (!source) {
	console.error('usage: bun scripts/publish.mjs <namespace>/<name> [--release-base <url>]');
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

// Guard: the secret must match the namespace's committed public key.
const keysPath = `registry/${ns}/keys.json`;
if (!existsSync(keysPath)) {
	console.error(`no ${keysPath} — run keygen for namespace "${ns}" first`);
	process.exit(1);
}
const pub = publicFromPrivate(secret);
if (pub !== loadKeys(keysPath).key) {
	console.error(`DOZE_SIGNING_KEY does not match ${keysPath} — wrong key for namespace "${ns}"`);
	process.exit(1);
}

const releaseBase = (baseFlag || `${DEFAULT_RELEASE_BASE}/${name}`).replace(/\/+$/, '');
const manifestUrl = `${releaseBase}/index.yaml`;
const res = await fetch(manifestUrl);
if (!res.ok) {
	console.error(`fetching ${manifestUrl}: HTTP ${res.status}`);
	process.exit(1);
}
const release = parseYaml(await res.text());
const em = release?.engines?.[name];
if (!em) {
	console.error(`${manifestUrl}: no engines.${name}`);
	process.exit(1);
}

const priv = privateKeyObject(secret);
let signed = 0;
for (const { triple, art, version } of eachArtifact(release)) {
	if (!art?.sha256) {
		console.error(`${name} ${version} ${triple}: release manifest has no sha256`);
		process.exit(1);
	}
	const url = /:\/\//.test(art.url) ? art.url : `${releaseBase}/${String(art.url).replace(/^\/+/, '')}`;
	art.url = url;
	art.sha256 = String(art.sha256).toLowerCase();
	art.sig = sign(priv, art.sha256);
	signed++;
}

const dir = `registry/${ns}/${name}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/index.yaml`, toYaml({ engines: { [name]: em } }));
console.log(`✓ published ${source}: ${signed} artifact(s) signed -> ${dir}/index.yaml`);

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
