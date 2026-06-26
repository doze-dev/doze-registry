// sign — add (or refresh) a signed artifact entry in a module's index.yaml.
//
//   DOZE_SIGNING_KEY="$(cat doze.secret.key)" \
//     bun scripts/sign.mjs <namespace>/<name> <version> <triple> <url> <archive>
//
// <archive> is a local path to the .tar.gz that <url> will serve (its SHA256 is
// hashed and signed). The signature covers the lowercase-hex SHA256, matching the
// doze client. The module index lives at registry/<namespace>/<name>/index.yaml;
// it is created if absent, and <version> becomes the "default" channel.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { privateKeyObject, sign, sha256Hex, parseYaml, toYaml } from './lib.mjs';

const [source, version, triple, url, archive] = process.argv.slice(2);
if (!source || !version || !triple || !url || !archive) {
	console.error('usage: bun scripts/sign.mjs <namespace>/<name> <version> <triple> <url> <archive.tar.gz>');
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
const sig = sign(privateKeyObject(secret), hex);

const dir = `registry/${ns}/${name}`;
const idxPath = `${dir}/index.yaml`;
let manifest = { engines: {} };
if (existsSync(idxPath)) manifest = parseYaml(readFileSync(idxPath, 'utf8')) ?? { engines: {} };
manifest.engines ??= {};
const em = (manifest.engines[name] ??= { versions: {}, artifacts: {} });
em.versions ??= {};
em.artifacts ??= {};
em.versions.default ??= version;
em.versions[version] ??= version;
(em.artifacts[version] ??= {})[triple] = { url, sha256: hex, sig };

mkdirSync(dir, { recursive: true });
writeFileSync(idxPath, toYaml(manifest));
console.log(`✓ signed ${source} ${version} ${triple}`);
console.log(`  sha256 ${hex}`);
console.log(`  -> ${idxPath}`);
