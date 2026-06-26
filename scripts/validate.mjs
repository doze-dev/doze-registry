// validate — verify the registry is well-formed and every artifact is correctly
// signed by its namespace's publisher key. This is exactly what the doze client
// enforces, so a green validate means clients will accept the registry.
//
//   bun scripts/validate.mjs            offline: structure + signatures
//   bun scripts/validate.mjs --remote   also fetch each archive and re-check SHA256
//
// Exits non-zero on the first failure class found (CI gate).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { publicKeyObject, verify, sha256Hex, loadKeys, parseYaml, eachArtifact, RAW_PUBKEY_BYTES } from './lib.mjs';

const remote = process.argv.includes('--remote');
const errors = [];
const fail = (msg) => errors.push(msg);

const root = 'registry';
const namespaces = existsSync(root)
	? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
	: [];

let nModules = 0;
let nArtifacts = 0;

for (const ns of namespaces) {
	const keysPath = `${root}/${ns}/keys.json`;
	if (!existsSync(keysPath)) {
		fail(`${ns}: missing keys.json`);
		continue;
	}
	let pub;
	try {
		const doc = loadKeys(keysPath);
		if (doc.namespace !== ns) fail(`${keysPath}: namespace "${doc.namespace}" != dir "${ns}"`);
		if (Buffer.from(doc.key, 'base64').length !== RAW_PUBKEY_BYTES) {
			fail(`${keysPath}: key is not a ${RAW_PUBKEY_BYTES}-byte ed25519 key`);
		}
		pub = publicKeyObject(doc.key);
	} catch (e) {
		fail(`${keysPath}: ${e.message}`);
		continue;
	}

	const modules = readdirSync(`${root}/${ns}`, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	for (const name of modules) {
		const idxPath = `${root}/${ns}/${name}/index.yaml`;
		if (!existsSync(idxPath)) {
			fail(`${ns}/${name}: missing index.yaml`);
			continue;
		}
		nModules++;
		let manifest;
		try {
			manifest = parseYaml(readFileSync(idxPath, 'utf8'));
		} catch (e) {
			fail(`${idxPath}: ${e.message}`);
			continue;
		}
		if (!manifest?.engines?.[name]) {
			fail(`${idxPath}: missing engines.${name} (module name must match its directory)`);
		}
		for (const { engine, version, triple, art } of eachArtifact(manifest)) {
			nArtifacts++;
			const where = `${ns}/${name} ${engine} ${version} ${triple}`;
			if (!art?.url) fail(`${where}: missing url`);
			if (!art?.sha256) fail(`${where}: missing sha256`);
			if (!art?.sig) fail(`${where}: unsigned (no sig)`);
			else if (art?.sha256 && !verify(pub, art.sha256.toLowerCase(), art.sig)) {
				fail(`${where}: signature does not match ${ns}'s publisher key`);
			}
		}
	}
}

if (remote) await checkRemote(namespaces);

if (errors.length) {
	console.error(`✗ ${errors.length} problem(s):`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}
console.log(`✓ registry valid: ${namespaces.length} namespace(s), ${nModules} module(s), ${nArtifacts} signed artifact(s)`);

async function checkRemote(namespaces) {
	for (const ns of namespaces) {
		for (const name of dirsIn(`${root}/${ns}`)) {
			const idxPath = `${root}/${ns}/${name}/index.yaml`;
			if (!existsSync(idxPath)) continue;
			const manifest = parseYaml(readFileSync(idxPath, 'utf8'));
			for (const { version, triple, art } of eachArtifact(manifest)) {
				const where = `${ns}/${name} ${version} ${triple}`;
				try {
					const res = await fetch(art.url);
					if (!res.ok) {
						fail(`${where}: archive ${art.url} -> HTTP ${res.status}`);
						continue;
					}
					const got = sha256Hex(Buffer.from(await res.arrayBuffer()));
					if (got !== String(art.sha256).toLowerCase()) {
						fail(`${where}: archive SHA256 ${got} != manifest ${art.sha256}`);
					}
				} catch (e) {
					fail(`${where}: fetching ${art.url}: ${e.message}`);
				}
			}
		}
	}
}

function dirsIn(p) {
	if (!existsSync(p) || !statSync(p).isDirectory()) return [];
	return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
