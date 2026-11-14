// build — the static data host for registry.doze-dev.com (the `doze-registry`
// Cloudflare Pages project). Nobody browses it: the `doze` CLI reads it, and the
// portal people read is the website (https://doze-dev.com/registry/).
//
// 1. validate (fails the build on a bad or unsigned artifact);
// 2. copy the signed files to dist/ byte for byte:
//      <ns>/keys.json, <ns>/<name>/index.yaml, <ns>/<name>/meta.yaml
// 3. generate dist/index.json, the catalog `doze modules search` and the init
//    wizard read (module version, protocol and engine support from the SIGNED
//    index's stable release; the engine platforms from doze-binaries);
// 4. write dist/_headers (content types, caching, nosniff) and dist/_redirects
//    (every non-data path goes to its page on the website).
//
// No Functions, no HTML. Run with node or bun: `bun run build`.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { publicKeyObject, verify, verifyIndex, loadKeys, parseYaml, eachArtifact } from './lib.mjs';

const OUT = 'dist';
const PORTAL = 'https://doze-dev.com/registry';
const OFFICIAL = new Set(['doze']);

// backendInfo resolves the platforms the ENGINE backend is published for, from
// doze-binaries' index: the module plugin is pure Go and says nothing about
// where the engine runs (mariadb publishes x86_64-linux only). Embedded engines
// (kafka, aws) and any lookup failure fall back to the plugin's triples.
const BACKENDS = { postgres: ['postgres'], valkey: ['valkey'], kvrocks: ['kvrocks'], mariadb: ['mariadb'], temporal: ['temporal'], ferret: ['ferretdb', 'documentdb'] };

async function enginePlatforms(name, pluginTriples) {
	const recipes = BACKENDS[name];
	if (!recipes) return pluginTriples;
	try {
		let plats = null;
		for (const recipe of recipes) {
			const res = await fetch(`https://github.com/doze-dev/doze-binaries/releases/download/${recipe}/index.yaml`, { redirect: 'follow' });
			if (!res.ok) throw new Error(`${recipe}: ${res.status}`);
			const e = parseYaml(await res.text())?.engines?.[recipe];
			const triples = new Set();
			for (const art of Object.values(e?.artifacts || {})) for (const t of Object.keys(art || {})) triples.add(t);
			plats = plats ? new Set([...plats].filter((t) => triples.has(t))) : triples;
		}
		return plats && plats.size ? [...plats].sort() : pluginTriples;
	} catch (e) {
		console.warn(`  ! ${name}: backend lookup failed (${e.message}); using the plugin's platforms`);
		return pluginTriples;
	}
}

// 1. Validate signatures.
execFileSync(process.execPath, ['scripts/validate.mjs'], { stdio: 'inherit' });

// 2 + 3. Copy the signed files and assemble the catalog.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const catalog = { generatedBy: 'doze-registry', namespaces: {} };
const browse = []; // [ns, name] pairs, for _redirects

for (const ns of dirs('registry')) {
	const keysPath = `registry/${ns}/keys.json`;
	if (!existsSync(keysPath)) continue;
	const keysDoc = loadKeys(keysPath);
	const pub = publicKeyObject(keysDoc.key);
	mkdirSync(`${OUT}/${ns}`, { recursive: true });
	cpSync(keysPath, `${OUT}/${ns}/keys.json`);
	catalog.namespaces[ns] = { key: keysDoc.key, official: OFFICIAL.has(ns), modules: {} };

	for (const name of dirs(`registry/${ns}`)) {
		const idxPath = `registry/${ns}/${name}/index.yaml`;
		if (!existsSync(idxPath)) continue;
		mkdirSync(`${OUT}/${ns}/${name}`, { recursive: true });
		cpSync(idxPath, `${OUT}/${ns}/${name}/index.yaml`);
		// meta.yaml is served too: `doze modules docs <type>` renders it.
		const metaPath = `registry/${ns}/${name}/meta.yaml`;
		if (existsSync(metaPath)) cpSync(metaPath, `${OUT}/${ns}/${name}/meta.yaml`);
		browse.push([ns, name]);

		const manifest = parseYaml(readFileSync(idxPath, 'utf8'));
		const meta = loadMeta(metaPath);
		const triples = new Set();
		let signed = verifyIndex(pub, manifest);
		for (const { triple, art } of eachArtifact(manifest)) {
			triples.add(triple);
			if (!art?.sig || !verify(pub, String(art.sha256).toLowerCase(), art.sig)) signed = false;
		}
		const stableVersion = manifest?.channels?.stable ?? null;
		const stable = stableVersion ? manifest?.releases?.[stableVersion] : null;
		const engines = (stable?.engines || []).map(String);
		const versions = Object.keys(manifest?.releases || {}).sort(semverDesc);
		catalog.namespaces[ns].modules[name] = {
			source: `${ns}/${name}`,
			version: stableVersion,
			protocol: stable?.protocol ?? null,
			tagline: meta.tagline || '',
			category: meta.category || 'other',
			engineVersions: engines.length ? engines : null,
			port: meta.port || null,
			label: meta.exampleLabel || name,
			platforms: await enginePlatforms(name, [...triples].sort()), // where the ENGINE runs
			signed,
			versions, // every published release, newest first
		};
	}
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(catalog, null, 2) + '\n');

// 4a. _headers. Pages already types .yaml and .json; the rules make it explicit
// and set caching. Everything here can change on a publish (the archives, the
// only immutable bytes, live on GitHub Releases), so TTLs are short: a minute
// for the indexes doze resolves from, longer for docs and the key.
const yaml = 'text/yaml; charset=utf-8';
const json = 'application/json; charset=utf-8';
const rule = (path, type, cache) => `${path}\n  ! Content-Type\n  Content-Type: ${type}\n  Cache-Control: ${cache}\n`;
writeFileSync(
	`${OUT}/_headers`,
	[
		'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Access-Control-Allow-Origin: *\n',
		rule('/index.json', json, 'public, max-age=60, must-revalidate'),
		rule('/:ns/keys.json', json, 'public, max-age=3600'),
		rule('/:ns/:name/index.yaml', yaml, 'public, max-age=60, must-revalidate'),
		rule('/:ns/:name/meta.yaml', yaml, 'public, max-age=300'),
	].join('\n'),
);

const data = served().sort();

// 4b. _redirects. A person who lands here is sent to the matching website page
// (the website's routes are /registry/<ns>/ and /registry/<ns>/<module>/...).
// On Pages a matching rule wins over a static file, so every data file comes
// first as a 200 rule to itself (served as is), and only then the redirects.
// /registry/* is the old portal's prefix (doze 0.1 read data under it): it drops
// the prefix, which serves the data file or redirects onward to the website.
const lines = data.map((p) => `${p}  ${p}  200`);
lines.push(
	`/                    ${PORTAL}/ 301`,
	`/registry            / 301`,
	`/registry/*          /:splat 301`,
);
for (const ns of [...new Set(browse.map(([n]) => n))]) {
	lines.push(`/${ns}                ${PORTAL}/${ns}/ 301`);
	lines.push(`/${ns}/               ${PORTAL}/${ns}/ 301`);
}
for (const [ns, name] of browse) {
	lines.push(`/${ns}/${name}          ${PORTAL}/${ns}/${name}/ 301`);
	lines.push(`/${ns}/${name}/*        ${PORTAL}/${ns}/${name}/:splat 301`);
}
lines.push(`/*                   ${PORTAL}/ 301`);
writeFileSync(`${OUT}/_redirects`, lines.join('\n') + '\n');

// Every file served from dist/ (the data), as a URL path.
function served(dir = OUT, prefix = '') {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		if (d.isDirectory()) return served(`${dir}/${d.name}`, `${prefix}/${d.name}`);
		return d.name.startsWith('_') ? [] : [`${prefix}/${d.name}`];
	});
}

console.log(`built ${OUT}/: ${browse.length} module(s), index.json, _headers, _redirects (${lines.length} rules)`);

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
	return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
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
