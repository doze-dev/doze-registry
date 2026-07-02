// publish — sign an entire module release into the registry.
//
//   DOZE_SIGNING_KEY="$(cat doze.secret.key)" \
//     npm run publish <namespace>/<name> -- [--release-base <url>] [--artifact-base <url>]
//   (key operations run under node — see assertSigningRuntime in lib.mjs)
//
// --release-base sets where the release index.yaml is READ from (a file:// dzm
// dist dir works); --artifact-base sets the URL prefix WRITTEN for relative
// artifact names (defaults to --release-base) — so a locally built release can
// be signed against its canonical GitHub download URLs.
//
// Reads the module's schema-1 release index (default: the doze-modules GitHub
// release for <name>; dzm builds it), rewrites every artifact URL to an
// absolute link, signs each artifact's SHA256 with the namespace key, and then
// signs the index itself — the index signature covers the release metadata
// (protocol, engine support, channels), so a compromised host can't lie about
// compatibility or roll a channel back. Writes registry/<ns>/<name>/index.yaml.
//
// It does NOT download the archives — it signs the SHA256 the release manifest
// already published (built by our own CI). `validate --remote` is the gate: it
// re-downloads each archive and confirms the SHA256 matches the signed value
// before anything is trusted or deployed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { privateKeyObject, sign, signIndex, parseYaml, toYaml, eachArtifact, publicFromPrivate, loadKeys, SCHEMA, assertSigningRuntime } from './lib.mjs';

assertSigningRuntime();

const DEFAULT_RELEASE_BASE = 'https://github.com/doze-dev/doze-modules/releases/download';

const source = process.argv[2];
const baseFlag = argValue('--release-base');
const artifactBaseFlag = argValue('--artifact-base');
if (!source) {
	console.error('usage: npm run publish <namespace>/<name> -- [--release-base <url>] [--artifact-base <url>]');
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
const idx = parseYaml(await fetchText(manifestUrl));
if (idx?.schema !== SCHEMA) {
	console.error(`${manifestUrl}: not a schema-${SCHEMA} module index (got schema ${idx?.schema ?? 'none'}) — rebuild the release with a current dzm`);
	process.exit(1);
}
if (idx.module !== name) {
	console.error(`${manifestUrl}: index is for module "${idx.module}", expected "${name}"`);
	process.exit(1);
}
if (!idx.releases || Object.keys(idx.releases).length === 0) {
	console.error(`${manifestUrl}: index has no releases`);
	process.exit(1);
}
// The signer owns the namespace claim: whatever dzm stamped, the signed copy
// carries the namespace the key actually belongs to.
idx.namespace = ns;

const artifactBase = (artifactBaseFlag || releaseBase).replace(/\/+$/, '');
const priv = privateKeyObject(secret);
let signed = 0;
for (const { triple, art, version } of eachArtifact(idx)) {
	if (!art?.sha256) {
		console.error(`${name} ${version} ${triple}: release manifest has no sha256`);
		process.exit(1);
	}
	const url = /:\/\//.test(art.url) ? art.url : `${artifactBase}/${String(art.url).replace(/^\/+/, '')}`;
	art.url = url;
	art.sha256 = String(art.sha256).toLowerCase();
	art.sig = sign(priv, art.sha256);
	signed++;
}
idx.signature = signIndex(priv, idx);

const dir = `registry/${ns}/${name}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/index.yaml`, toYaml(idx));
console.log(`✓ published ${source}: ${signed} artifact(s) + index signed -> ${dir}/index.yaml`);

// The release also ships a dzm-generated meta.yaml (docs prose, generated from
// the driver's Describe()). Copy it in when present so the site can't drift
// from the code; keep whatever is committed when the release has none.
try {
	const meta = await fetchText(`${releaseBase}/meta.yaml`, { optional: true });
	if (meta) {
		writeFileSync(`${dir}/meta.yaml`, meta);
		console.log(`✓ copied generated meta.yaml -> ${dir}/meta.yaml`);
	}
} catch {
	// best-effort only
}

// fetchText reads a URL, with a file:// shortcut so a local dzm dist dir can be
// published/tested without a web server. With {optional}, a miss returns null
// instead of exiting.
async function fetchText(url, { optional = false } = {}) {
	if (url.startsWith('file://')) {
		try {
			return readFileSync(url.slice('file://'.length), 'utf8');
		} catch (e) {
			if (optional) return null;
			console.error(`reading ${url}: ${e.message}`);
			process.exit(1);
		}
	}
	const res = await fetch(url);
	if (!res.ok) {
		if (optional) return null;
		console.error(`fetching ${url}: HTTP ${res.status}`);
		process.exit(1);
	}
	return res.text();
}

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
