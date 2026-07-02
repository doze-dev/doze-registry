// prepare — gate on a clean validate, copy the machine discovery files into
// public/registry/ (served verbatim — this is what doze fetches), and assemble
// both the machine catalog (public/registry/index.json — the discovery API the
// CLI reads) and src/data/modules.json for the Astro site. Prose (title,
// tagline, docs) comes from each meta.yaml; the module version, plugin
// protocol, and engine support come from the SIGNED index's stable release —
// code-derived via `dzm`, so docs can't drift from what a module actually
// supports. Third-party modules work the same as official ones. Run before
// astro build/dev.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { publicKeyObject, verify, verifyIndex, loadKeys, parseYaml, eachArtifact } from './lib.mjs';

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
		// meta.yaml is served too: `doze modules docs <type>` renders it in the
		// terminal, so config docs reach the person actually writing doze.hcl.
		const metaPath = `registry/${ns}/${name}/meta.yaml`;
		if (existsSync(metaPath)) cpSync(metaPath, `public/registry/${ns}/${name}/meta.yaml`);

		const manifest = parseYaml(readFileSync(idxPath, 'utf8'));
		const meta = loadMeta(`registry/${ns}/${name}/meta.yaml`);
		const triples = new Set();
		let signed = verifyIndex(pub, manifest);
		for (const { triple, art } of eachArtifact(manifest)) {
			triples.add(triple);
			if (!art?.sig || !verify(pub, String(art.sha256).toLowerCase(), art.sig)) signed = false;
		}
		// Engine support and the module version come from the SIGNED index's
		// stable release — code-derived via dzm, never from docs metadata.
		const stableVersion = manifest?.channels?.stable ?? null;
		const stable = stableVersion ? manifest?.releases?.[stableVersion] : null;
		const versions = (stable?.engines || []).map(String);
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
			version: stableVersion,
			protocol: stable?.protocol ?? null,
			engineVersions: versions.length ? versions : null,
			example: meta.example || `${name} "${meta.exampleLabel || name}" {}`,
			label: meta.exampleLabel || name,
			port: meta.port || null,
			config: meta.config || {},
			homepage: meta.homepage || '',
			sourceRepo: meta.source || '',
			platforms: [...triples].sort(),
			signed,
			indexUrl: `/registry/${ns}/${name}/index.yaml`,
		};
		modules.push(mod);
		// The catalog (discovery API) carries just enough for `doze modules search`
		// and the init wizard to list + scaffold without a code change per module.
		catalog.namespaces[ns].modules[name] = {
			source: mod.source,
			version: mod.version,
			protocol: mod.protocol,
			tagline: mod.tagline,
			category: mod.category,
			engineVersions: mod.engineVersions,
			port: mod.port,
			label: mod.label,
			platforms: mod.platforms,
			signed: mod.signed,
		};
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
