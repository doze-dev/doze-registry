// validate — verify the registry is well-formed and every artifact is correctly
// signed by its namespace's publisher key. This is exactly what the doze client
// enforces, so a green validate means clients will accept the registry.
//
//   npm run validate            offline: structure + signatures (runtime-agnostic)
//   npm run validate:remote     also fetch each archive and re-check SHA256
//
// Exits non-zero on the first failure class found (CI gate).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { publicKeyObject, verify, verifyIndex, sha256Hex, loadKeys, parseYaml, eachArtifact, RAW_PUBKEY_BYTES, SCHEMA, history } from './lib.mjs';

const remote = process.argv.includes('--remote');
// --against=<git ref> also checks that nothing published at ref was dropped or
// changed (lib.mjs history): CI passes the commit before the change.
const against = process.argv.find((a) => a.startsWith('--against='))?.slice('--against='.length);
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
		let idx;
		try {
			idx = parseYaml(readFileSync(idxPath, 'utf8'));
		} catch (e) {
			fail(`${idxPath}: ${e.message}`);
			continue;
		}

		// Schema-1 structure: identity, releases, channels.
		if (idx?.schema !== SCHEMA) {
			fail(`${idxPath}: not a schema-${SCHEMA} index (got ${idx?.schema ?? 'none'}) — re-publish the module`);
			continue;
		}
		if (idx.module !== name) fail(`${idxPath}: module "${idx.module}" != directory "${name}"`);
		if (idx.namespace !== ns) fail(`${idxPath}: namespace "${idx.namespace}" != directory "${ns}"`);
		const releases = Object.entries(idx.releases ?? {});
		if (releases.length === 0) fail(`${idxPath}: no releases`);
		for (const [version, rel] of releases) {
			const where = `${ns}/${name} ${version}`;
			if (!/^\d+(\.\d+)*$/.test(version)) fail(`${where}: release version is not a dotted number`);
			if (!Number.isInteger(rel?.protocol) || rel.protocol < 1) {
				fail(`${where}: missing/invalid plugin protocol`);
			}
			if (rel?.engines !== undefined && (!Array.isArray(rel.engines) || rel.engines.some((e) => typeof e !== 'string' || !e))) {
				fail(`${where}: engines must be a list of non-empty engine majors`);
			}
			if (!rel?.artifacts || Object.keys(rel.artifacts).length === 0) {
				fail(`${where}: release has no artifacts`);
			}
		}
		for (const [channel, head] of Object.entries(idx.channels ?? {})) {
			if (!idx.releases?.[head]) fail(`${ns}/${name}: channel "${channel}" points at missing release "${head}"`);
		}
		if (!idx.channels?.stable) fail(`${ns}/${name}: no "stable" channel`);

		// The index-level signature is what stops a compromised host from lying
		// about protocol/engine support or rolling a channel back.
		if (!idx.signature) fail(`${ns}/${name}: index is unsigned (no signature field)`);
		else if (!verifyIndex(pub, idx)) fail(`${ns}/${name}: index signature does not match ${ns}'s publisher key`);

		for (const { version, triple, art } of eachArtifact(idx)) {
			nArtifacts++;
			const where = `${ns}/${name} ${version} ${triple}`;
			if (!art?.url) fail(`${where}: missing url`);
			if (!art?.sha256) fail(`${where}: missing sha256`);
			if (!art?.sig) fail(`${where}: unsigned (no sig)`);
			else if (art?.sha256 && !verify(pub, art.sha256.toLowerCase(), art.sig)) {
				fail(`${where}: signature does not match ${ns}'s publisher key`);
			}
		}

		// meta.yaml is prose/docs only; engine support lives in the signed index.
		const metaPath = `${root}/${ns}/${name}/meta.yaml`;
		if (existsSync(metaPath)) {
			try {
				const meta = parseYaml(readFileSync(metaPath, 'utf8'));
				if (meta?.versions !== undefined) {
					fail(`${metaPath}: has a "versions" field — engine support belongs to the signed index (releases.<v>.engines); regenerate with \`dzm meta\``);
				}
			} catch (e) {
				fail(`${metaPath}: ${e.message}`);
			}
		}
	}
}

if (against) checkHistory(against);
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

// checkHistory fails when anything published at ref was dropped or changed:
// an artifact, a release, a whole module or namespace. Every index that
// existed at ref is checked, so deleting a directory is caught too. A module
// that did not exist at ref is new, and fine. A ref that can't be resolved is
// an error: a missing base must never switch the check off.
function checkHistory(ref) {
	const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
	} catch {
		fail(`--against=${ref}: no such commit here (a shallow checkout needs fetch-depth: 0)`);
		return;
	}
	const published = git(['ls-tree', '-r', '--name-only', ref, '--', root])
		.split('\n')
		.filter((p) => p.endsWith('/index.yaml'));
	for (const path of published) {
		const name = path.slice(root.length + 1, -'/index.yaml'.length);
		if (!existsSync(path)) {
			fail(`${name}: was published at ${ref} and its index is gone`);
			continue;
		}
		const before = git(['show', `${ref}:${path}`]);
		const { carried, changed } = history(parseYaml(before), parseYaml(readFileSync(path, 'utf8')));
		for (const c of carried) fail(`${name}: ${c.version} ${c.triple} was published and is gone`);
		for (const c of changed) fail(`${name}: ${c}`);
	}
}
