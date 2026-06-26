// prepare — gate on a clean validate, copy the machine discovery files into
// public/registry/ (served verbatim — this is what doze fetches), and assemble
// src/data/modules.json for the Astro site (metadata + engine versions + signature
// status). Run before `astro build`/`astro dev`.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { publicKeyObject, verify, loadKeys, parseYaml, eachArtifact } from './lib.mjs';

const BINARIES_ROOT = 'https://github.com/doze-dev/doze-binaries/releases/download';
const OFFICIAL = new Set(['doze']);

// 1. Validate signatures (fails the build on a bad/unsigned artifact).
execFileSync(process.execPath, ['scripts/validate.mjs'], { stdio: 'inherit' });

// 2. Copy the machine layer into public/registry (keys.json + index.yaml only).
rmSync('public/registry', { recursive: true, force: true });
const catalog = { generatedBy: 'doze-registry', namespaces: {} };
const modules = [];

for (const ns of dirs('registry')) {
	const keysPath = `registry/${ns}/keys.json`;
	if (!existsSync(keysPath)) continue;
	const keysDoc = loadKeys(keysPath);
	const pub = publicKeyObject(keysDoc.key);
	mkdirSync(`public/registry/${ns}`, { recursive: true });
	cpSync(keysPath, `public/registry/${ns}/keys.json`);
	catalog.namespaces[ns] = { key: keysDoc.key, official: OFFICIAL.has(ns), modules: {} };

	for (const name of dirs(`registry/${ns}`)) {
		const idxPath = `registry/${ns}/${name}/index.yaml`;
		if (!existsSync(idxPath)) continue;
		mkdirSync(`public/registry/${ns}/${name}`, { recursive: true });
		cpSync(idxPath, `public/registry/${ns}/${name}/index.yaml`);

		const manifest = parseYaml(readFileSync(idxPath, 'utf8'));
		const meta = loadMeta(`registry/${ns}/${name}/meta.yaml`);
		const triples = new Set();
		let signed = true;
		for (const { triple, art } of eachArtifact(manifest)) {
			triples.add(triple);
			if (!art?.sig || !verify(pub, String(art.sha256).toLowerCase(), art.sig)) signed = false;
		}
		const mod = {
			ns,
			name,
			source: `${ns}/${name}`,
			official: OFFICIAL.has(ns),
			title: meta.title || name,
			tagline: meta.tagline || '',
			description: meta.description || '',
			category: meta.category || 'other',
			engine: meta.engine || name,
			engineVersions: await engineVersions(meta.engine || name),
			example: meta.example || `${name} "${meta.exampleLabel || name}" {}`,
			options: meta.options || [],
			homepage: meta.homepage || '',
			sourceRepo: meta.source || '',
			platforms: [...triples].sort(),
			signed,
			indexUrl: `/registry/${ns}/${name}/index.yaml`,
		};
		modules.push(mod);
		catalog.namespaces[ns].modules[name] = { source: mod.source, engineVersions: mod.engineVersions, platforms: mod.platforms };
	}
}

writeFileSync('public/registry/index.json', JSON.stringify(catalog, null, 2) + '\n');

modules.sort((a, b) => (a.official === b.official ? a.name.localeCompare(b.name) : a.official ? -1 : 1));
const categories = [...new Set(modules.map((m) => m.category))].sort();
mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/modules.json', JSON.stringify({ modules, categories, count: modules.length }, null, 2) + '\n');

console.log(`✓ prepared — ${modules.length} module(s), ${categories.length} categor(ies); machine files in public/registry/`);

function dirs(p) {
	if (!existsSync(p)) return [];
	return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

function loadMeta(path) {
	if (!existsSync(path)) return {};
	try {
		return parseYaml(readFileSync(path, 'utf8')) || {};
	} catch (e) {
		console.warn(`! ${path}: ${e.message}`);
		return {};
	}
}

// engineVersions returns the selectable backing-engine majors for a module from
// doze-binaries; null for the built-in (versionless) AWS services.
async function engineVersions(engine) {
	try {
		const res = await fetch(`${BINARIES_ROOT}/${engine}/index.yaml`);
		if (!res.ok) return null;
		const man = parseYaml(await res.text());
		const vers = man?.engines?.[engine]?.versions ?? {};
		const majors = Object.keys(vers).filter((k) => k !== 'default');
		return majors.length ? majors.sort((a, b) => Number(a) - Number(b)) : null;
	} catch {
		return null;
	}
}
