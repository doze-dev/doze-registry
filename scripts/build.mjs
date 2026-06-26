// build — assemble the deployable site into dist/.
//
// Layout produced (served by Cloudflare Pages at doze.nerdmenot.in):
//   dist/                         <- public/ (root site; doze docs land here later)
//   dist/registry/<ns>/keys.json  <- verbatim signed discovery files
//   dist/registry/<ns>/<name>/index.yaml
//   dist/registry/index.json      <- machine catalog (generated)
//   dist/registry/index.html      <- human browse page (generated)
//
// Archives are NOT hosted here — index.yaml URLs point at GitHub Releases. This
// keeps the Pages deploy tiny (just signed text) and dodges the 25 MiB/file limit.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseYaml, eachArtifact } from './lib.mjs';

// Gate the build on a clean validate.
execFileSync(process.execPath, ['scripts/validate.mjs'], { stdio: 'inherit' });

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/registry', { recursive: true });
if (existsSync('public')) cpSync('public', 'dist', { recursive: true });
if (existsSync('registry')) cpSync('registry', 'dist/registry', { recursive: true });

// Build the catalog from the registry tree.
const catalog = { generatedBy: 'doze-registry build', namespaces: {} };
for (const ns of dirs('registry')) {
	const mods = {};
	for (const name of dirs(`registry/${ns}`)) {
		const idx = `registry/${ns}/${name}/index.yaml`;
		if (!existsSync(idx)) continue;
		const m = parseYaml(readFileSync(idx, 'utf8'));
		const versions = new Set();
		const triples = new Set();
		for (const { version, triple } of eachArtifact(m)) {
			versions.add(version);
			triples.add(triple);
		}
		mods[name] = {
			source: `${ns}/${name}`,
			versions: [...versions].sort(),
			platforms: [...triples].sort(),
		};
	}
	catalog.namespaces[ns] = mods;
}
writeFileSync('dist/registry/index.json', JSON.stringify(catalog, null, 2) + '\n');
writeFileSync('dist/registry/index.html', browsePage(catalog));

const counts = Object.values(catalog.namespaces).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`✓ built dist/ — ${Object.keys(catalog.namespaces).length} namespace(s), ${counts} module(s)`);

function dirs(p) {
	if (!existsSync(p)) return [];
	return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

function browsePage(cat) {
	const rows = [];
	for (const [ns, mods] of Object.entries(cat.namespaces)) {
		for (const [name, info] of Object.entries(mods)) {
			rows.push(
				`<tr><td><code>${ns}/${name}</code></td>` +
					`<td>${info.versions.join(', ') || '—'}</td>` +
					`<td>${info.platforms.length} platform(s)</td>` +
					`<td><a href="/registry/${ns}/${name}/index.yaml">index.yaml</a></td></tr>`,
			);
		}
	}
	return `<!doctype html><meta charset="utf-8"><title>doze module registry</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}</style>
<h1>doze module registry</h1>
<p>Signed engine modules for <a href="https://github.com/doze-dev/doze">doze</a>.
Use one as <code>modules { &lt;type&gt; { source = "ns/name" } }</code>, or rely on the
default <code>doze/&lt;type&gt;</code>. Every artifact is ed25519-signed by its
namespace's publisher key (pinned on first use).</p>
<table><tr><th>source</th><th>versions</th><th>platforms</th><th>manifest</th></tr>
${rows.join('\n') || '<tr><td colspan="4">no modules yet</td></tr>'}
</table>`;
}
