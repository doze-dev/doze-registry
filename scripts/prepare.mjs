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

// backendPlatforms resolves the platforms the ENGINE backend is published
// for, from doze-binaries' rolling index — the module plugin itself is pure Go
// and says nothing about where the engine can run. Embedded engines (no
// fetched backend) and any fetch failure fall back to the plugin's triples.
const BACKENDS = { postgres: ['postgres'], valkey: ['valkey'], kvrocks: ['kvrocks'], mariadb: ['mariadb'], temporal: ['temporal'], ferret: ['ferretdb', 'documentdb'] };
const numDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });

// backendInfo resolves, from doze-binaries' published index, BOTH sides of
// "can I use this engine": the platforms its backend is actually built for
// (the pure-Go plugin says nothing — mariadb publishes x86_64-linux only) and
// the full version inventory — every series (the `version =` a user writes;
// a bare series pins its newest build) with its exact builds, split into
// supported (the current module accepts the major) and pending (published in
// the mirror, awaiting module support). Embedded engines (kafka, aws) have no
// fetched backend: platforms = the plugin's, versions = null. Lookup failures
// degrade the same way rather than failing the site build.
async function backendInfo(name, pluginTriples, supportedMajors) {
	const recipes = BACKENDS[name];
	if (!recipes) return { platforms: pluginTriples, series: null, pending: [] };
	try {
		let plats = null;
		let eng = null; // the FIRST recipe carries the declarable versions (ferret: the gateway)
		for (const recipe of recipes) {
			const res = await fetch(`https://github.com/doze-dev/doze-binaries/releases/download/${recipe}/index.yaml`, { redirect: 'follow' });
			if (!res.ok) throw new Error(`${recipe}: ${res.status}`);
			const doc = parseYaml(await res.text());
			const e = doc?.engines?.[recipe];
			if (!eng) eng = e;
			const triples = new Set();
			for (const art of Object.values(e?.artifacts || {})) for (const t of Object.keys(art || {})) triples.add(t);
			plats = plats ? new Set([...plats].filter((t) => triples.has(t))) : triples;
		}
		const fulls = Object.keys(eng?.artifacts || {});
		const all = Object.entries(eng?.versions || {}).map(([ser, latest]) => ({
			series: ser,
			latest,
			supported: supportedMajors.some((m) => ser === m || ser.startsWith(m + '.')),
			fulls: fulls.filter((f) => f === ser || f.startsWith(ser + '.')).sort(numDesc),
		}));
		return {
			platforms: plats && plats.size ? [...plats].sort() : pluginTriples,
			series: all.filter((x) => x.supported).sort((a, b) => numDesc(b.series, a.series)),
			pending: all.filter((x) => !x.supported).map((x) => x.series).sort((a, b) => numDesc(b, a)),
		};
	} catch (e) {
		console.warn(`  ⚠ ${name}: backend lookup failed (${e.message}); plugin platforms, no version inventory`);
		return { platforms: pluginTriples, series: null, pending: [] };
	}
}


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
		// The FULL release history, newest first — the index is cumulative
		// (published artifacts are immutable; old releases stay resolvable for
		// pinned lockfiles), and the site is where a human discovers that.
		const releases = Object.entries(manifest?.releases || {})
			.map(([version, rel]) => ({
				version,
				protocol: rel?.protocol ?? null,
				engines: (rel?.engines || []).map(String),
				platforms: Object.keys(rel?.artifacts || {}).sort(),
				stable: version === stableVersion,
			}))
			.sort((a, b) => semverDesc(a.version, b.version));
		// Where can you actually RUN this engine? The plugin is pure Go and
		// builds everywhere; the ENGINE backend may not (mariadb publishes
		// x86_64-linux only). doze-binaries' signed index is the truth for
		// fetched backends; embedded engines (kafka, aws) are the plugin.
		const backend = await backendInfo(name, [...triples].sort(), versions);
		const enginePlatforms = backend.platforms;
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
			enginePlatforms,
			engineSeries: backend.series,   // full declarable inventory, or null (embedded/unknown)
			pendingSeries: backend.pending, // published in the mirror, awaiting module support
			signed,
			releases,
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
			platforms: mod.enginePlatforms, // where the ENGINE runs — the honest answer
			signed: mod.signed,
			// every published release, newest first — so tooling can discover
			// more than the stable channel without fetching each index.yaml
			versions: releases.map((r) => r.version),
		};
	}
}

writeFileSync('public/registry/index.json', JSON.stringify(catalog, null, 2) + '\n');

modules.sort((a, b) => (a.official === b.official ? a.name.localeCompare(b.name) : a.official ? -1 : 1));
const categories = [...new Set(modules.map((m) => m.category))].sort();
mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/modules.json', JSON.stringify({ modules, categories, count: modules.length }, null, 2) + '\n');

console.log(`✓ prepared — ${modules.length} module(s), ${categories.length} categor(ies); machine files in public/registry/`);

// semverDesc orders x.y.z strings newest-first (numeric per part).
function semverDesc(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pb[i] || 0) - (pa[i] || 0);
		if (d) return d;
	}
	return 0;
}

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
