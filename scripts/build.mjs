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
//
// The browse page surfaces two distinct version axes (a common point of confusion):
//   - ENGINE versions  — the actual database you pick with `version =` (Postgres 18,
//     Valkey 9, …), resolved by the plugin from doze-binaries at boot.
//   - PLUGIN version   — the doze adapter binary itself (e.g. 0.1.0); rarely pinned.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseYaml, eachArtifact } from './lib.mjs';

// Where the per-engine backing binaries (and their version maps) are published.
const BINARIES_ROOT = 'https://github.com/doze-dev/doze-binaries/releases/download';

// Gate the build on a clean validate.
execFileSync(process.execPath, ['scripts/validate.mjs'], { stdio: 'inherit' });

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/registry', { recursive: true });
if (existsSync('public')) cpSync('public', 'dist', { recursive: true });
if (existsSync('registry')) cpSync('registry', 'dist/registry', { recursive: true });

// Build the catalog from the registry tree, enriched with the engine versions each
// module can run (fetched from doze-binaries — best effort).
const catalog = { generatedBy: 'doze-registry build', namespaces: {} };
for (const ns of dirs('registry')) {
	const mods = {};
	for (const name of dirs(`registry/${ns}`)) {
		const idx = `registry/${ns}/${name}/index.yaml`;
		if (!existsSync(idx)) continue;
		const m = parseYaml(readFileSync(idx, 'utf8'));
		const plugin = new Set();
		const triples = new Set();
		for (const { version, triple } of eachArtifact(m)) {
			plugin.add(version);
			triples.add(triple);
		}
		mods[name] = {
			source: `${ns}/${name}`,
			plugin: [...plugin].sort(),
			engineVersions: await engineVersions(name),
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

// engineVersions returns the selectable backing-engine majors for a module, read
// from doze-binaries (<root>/<name>/index.yaml). A module with no backing binary
// (the built-in AWS services) returns null → shown as "built-in".
async function engineVersions(name) {
	try {
		const res = await fetch(`${BINARIES_ROOT}/${name}/index.yaml`);
		if (!res.ok) return null;
		const man = parseYaml(await res.text());
		const vers = man?.engines?.[name]?.versions ?? {};
		const majors = Object.keys(vers).filter((k) => k !== 'default');
		return majors.length ? majors.sort((a, b) => Number(a) - Number(b)) : null;
	} catch {
		return null;
	}
}

function browsePage(cat) {
	const rows = [];
	for (const [ns, mods] of Object.entries(cat.namespaces)) {
		for (const [name, info] of Object.entries(mods)) {
			const engine = info.engineVersions ? info.engineVersions.join(', ') : '<em>built-in</em>';
			rows.push(
				`<tr><td><code>${ns}/${name}</code></td>` +
					`<td>${engine}</td>` +
					`<td class="muted">${info.plugin.join(', ') || '—'}</td>` +
					`<td class="muted">${info.platforms.length}</td>` +
					`<td><a href="/registry/${ns}/${name}/index.yaml">index.yaml</a></td></tr>`,
			);
		}
	}
	return `<!doctype html><meta charset="utf-8"><title>doze module registry</title>
<style>
  body{font:15px/1.6 system-ui,sans-serif;max-width:64rem;margin:3rem auto;padding:0 1rem;color:#18181b}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  td,th{text-align:left;padding:.45rem .7rem;border-bottom:1px solid #e4e4e7;vertical-align:top}
  th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:#71717a}
  code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px;font-size:.9em}
  .muted{color:#a1a1aa}
  .note{background:#f8fafc;border:1px solid #e4e4e7;border-radius:8px;padding:.8rem 1rem;font-size:.92rem}
  a{color:#2563eb}
</style>
<h1>doze module registry</h1>
<p>Signed engine modules for <a href="https://github.com/doze-dev/doze">doze</a>.
Every artifact is ed25519-signed by its namespace's publisher key (pinned on first use).</p>
<div class="note">
  <strong>Engine version vs plugin version.</strong> The <em>engine version</em> is the
  database you pick — set it with <code>version =</code> in the block, e.g.
  <code>postgres "db" { version = 18 }</code>. The <em>plugin version</em> is doze's
  adapter binary (rarely pinned). Use a module via the default source
  <code>doze/&lt;type&gt;</code>, or override with
  <code>modules { &lt;type&gt; { source = "ns/name" } }</code>.
</div>
<table>
  <tr><th>source</th><th>engine versions (pick with <code>version =</code>)</th><th>plugin</th><th>platforms</th><th>manifest</th></tr>
${rows.join('\n') || '<tr><td colspan="5">no modules yet</td></tr>'}
</table>`;
}
