// domain-check — what a fresh doze user hits on the public hosts, checked from
// the outside. Run it through scripts/domain-check.sh (it installs deps first).
//
//   bun scripts/domain-check.mjs            doze-dev.com, www, registry.doze-dev.com
//   bun scripts/domain-check.mjs --pages    the same against the *.pages.dev hosts
//   bun scripts/domain-check.mjs --deep     also download every module archive (sha256)
//
// Hosts can be overridden with APEX=, WWW=, REGISTRY= (full origins). Prints one
// row per check and exits 1 if any row FAILs. Read-only: GET/HEAD and TLS
// handshakes, nothing is written anywhere.
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyObject, verify, verifyIndex, parseYaml, sha256Hex, SCHEMA } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const PAGES = args.has('--pages');
const DEEP = args.has('--deep');

// The registry key doze compiles in (RegistryKey, doze internal/modules/modules.go).
// doze trusts this and nothing else; keys.json must publish the same key.
const COMPILED_KEY = process.env.DOZE_REGISTRY_KEY || 'Nu5y8mbjYv7XEtNFBXwPVl+C8SBteVApIROefBwGWjw=';
// Where canonical/og:url/sitemap URLs must point, whichever host serves the page.
const CANON = 'https://doze-dev.com';
// Every module the website and docs promise. A catalog missing one fails.
const EXPECTED = (process.env.EXPECTED_MODULES || 'aws ferret kafka kvrocks mariadb postgres temporal valkey').split(/\s+/);
// Paths on the site that docs, the app and the READMEs link to.
const SITE_PATHS = ['/', '/docs/', '/docs/doze/start/install/', '/download/', '/registry/', '/registry/doze/postgres/', '/changelog/'];
// An old doze.nerdmenot.in docs path the website must still redirect.
const OLD_PATH = '/guides/engines/';
const MIN_CERT_DAYS = 14;

const APEX = process.env.APEX || (PAGES ? 'https://doze-website.pages.dev' : CANON);
const WWW = process.env.WWW ?? (PAGES ? '' : 'https://www.doze-dev.com');
const REGISTRY = process.env.REGISTRY || (PAGES ? 'https://doze-registry.pages.dev' : 'https://registry.doze-dev.com');

const rows = [];
const add = (status, group, check, detail = '') => rows.push({ status, group, check, detail: String(detail) });
const pass = (g, c, d) => add('PASS', g, c, d);
const fail = (g, c, d) => add('FAIL', g, c, d);
const warn = (g, c, d) => add('WARN', g, c, d);
const skip = (g, c, d) => add('SKIP', g, c, d);

async function req(url, opts = {}) {
	for (let i = 0; i < 5; i++) {
		try {
			const r = await fetch(url, { redirect: 'manual', ...opts, signal: AbortSignal.timeout(30000) });
			if (r.status === 429) {
				await Bun.sleep(3000 * (i + 1));
				continue;
			}
			return r;
		} catch (e) {
			if (i === 4) return { status: 0, ok: false, error: e, headers: new Headers(), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
			await Bun.sleep(1000);
		}
	}
	return { status: 429, ok: false, headers: new Headers(), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
}
const get = (url, opts) => req(url, { redirect: 'follow', ...opts });
const why = (r) => (r.error ? `${r.error.code || ''} ${r.error.message}`.trim() : `HTTP ${r.status}`);
const isHTML = (t) => /^\s*<(!doctype|html)/i.test(t.slice(0, 64));

function cert(origin) {
	const host = new URL(origin).hostname;
	return new Promise((resolve) => {
		const s = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
			const c = s.getPeerCertificate();
			const days = Math.floor((new Date(c.valid_to) - Date.now()) / 86400000);
			resolve({ ok: s.authorized, err: s.authorizationError, days, issuer: c.issuer?.O, until: c.valid_to });
			s.end();
		});
		s.on('timeout', () => { s.destroy(); resolve({ ok: false, err: 'timeout' }); });
		s.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
	});
}

async function checkCert(group, origin) {
	const c = await cert(origin);
	const host = new URL(origin).hostname;
	if (!c.ok) return fail(group, `TLS certificate for ${host}`, c.err);
	if (c.days < MIN_CERT_DAYS) return warn(group, `TLS certificate for ${host}`, `valid, but expires in ${c.days} days (${c.until})`);
	pass(group, `TLS certificate for ${host}`, `${c.issuer}, ${c.days} days left`);
}

function metaContent(html, re) {
	const m = html.match(re);
	return m ? m[1] : null;
}

// ── site: apex and www ────────────────────────────────────────────────────
async function site() {
	const g = 'site';
	await checkCert(g, APEX);
	const home = await get(APEX + '/');
	const html = home.status === 200 ? await home.text() : '';
	if (home.status === 200 && isHTML(html)) pass(g, `GET ${APEX}/`, '200 text/html');
	else fail(g, `GET ${APEX}/`, why(home));

	if (!PAGES || process.env.APEX) {
		const host = new URL(APEX).host;
		const r = await req(`http://${host}/`);
		const loc = r.headers.get('location') || '';
		if ([301, 308].includes(r.status) && loc.startsWith(`https://${host}`)) pass(g, `http://${host}/ redirects to https`, `${r.status} → ${loc}`);
		else fail(g, `http://${host}/ redirects to https`, `${why(r)} ${loc}`);
	}

	if (WWW) {
		await checkCert(g, WWW);
		for (const p of ['/', '/docs/']) {
			const r = await req(WWW + p);
			const loc = r.headers.get('location') || '';
			if (r.status === 301 && loc === APEX + p) pass(g, `${WWW}${p} → 301 to apex`, loc);
			else fail(g, `${WWW}${p} → 301 to apex`, `${why(r)}${loc ? ' → ' + loc : ''} (want 301 → ${APEX}${p})`);
		}
	} else skip(g, 'www → 301 to apex', 'no www host in --pages mode');

	const canonical = metaContent(html, /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) ?? metaContent(html, /<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
	if (canonical === CANON + '/') pass(g, 'home canonical', canonical);
	else fail(g, 'home canonical', `${canonical ?? 'missing'} (want ${CANON}/)`);
	const ogurl = metaContent(html, /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i);
	if (ogurl === CANON + '/') pass(g, 'home og:url', ogurl);
	else fail(g, 'home og:url', `${ogurl ?? 'missing'} (want ${CANON}/)`);
	const ogimg = metaContent(html, /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
	if (ogimg && ogimg.startsWith(CANON + '/')) {
		const r = await get(ogimg.replace(CANON, APEX), { method: 'HEAD' });
		if (r.status === 200) pass(g, 'home og:image', ogimg);
		else fail(g, 'home og:image', `${ogimg}: ${why(r)}`);
	} else warn(g, 'home og:image', `${ogimg ?? 'missing'} (want ${CANON}/…)`);

	for (const p of SITE_PATHS.slice(1)) {
		const r = await get(APEX + p);
		if (r.status === 200) pass(g, `GET ${p}`, '200');
		else fail(g, `GET ${p}`, why(r));
	}
	const old = await req(APEX + OLD_PATH);
	const oldLoc = old.headers.get('location') || '';
	if ([301, 308].includes(old.status) && oldLoc.includes('/docs/')) pass(g, `old docs path ${OLD_PATH} redirects`, `${old.status} → ${oldLoc}`);
	else fail(g, `old docs path ${OLD_PATH} redirects`, `${why(old)} ${oldLoc}`);

	const robots = await get(APEX + '/robots.txt');
	const rt = robots.status === 200 ? await robots.text() : '';
	const sm = rt.match(/^sitemap:\s*(\S+)/im)?.[1];
	if (robots.status !== 200 || isHTML(rt)) fail(g, 'robots.txt', why(robots));
	else if (!sm) fail(g, 'robots.txt', 'no Sitemap: line');
	else if (!sm.startsWith(CANON + '/')) fail(g, 'robots.txt', `Sitemap: ${sm} (want ${CANON}/…)`);
	else pass(g, 'robots.txt', `Sitemap: ${sm}`);
	// A sitemap index lists child sitemaps; collect the page URLs from each.
	const locsIn = async (url) => {
		const r = await get(url.replace(CANON, APEX));
		const t = r.status === 200 ? await r.text() : '';
		const found = [...t.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
		return { r, found, index: /<sitemapindex/.test(t) };
	};
	const top = await locsIn(sm ?? CANON + '/sitemap-index.xml');
	const smr = top.r;
	let locs = top.found;
	if (top.index) {
		locs = [];
		for (const child of top.found) {
			if (!child.startsWith(CANON + '/')) { locs.push(child); continue; }
			const c = await locsIn(child);
			if (c.r.status !== 200) { fail(g, 'sitemap', `${child}: ${why(c.r)}`); return; }
			locs.push(...c.found);
		}
	}
	const off = locs.filter((u) => !u.startsWith(CANON + '/'));
	if (smr.status !== 200 || !locs.length) fail(g, 'sitemap', why(smr));
	else if (off.length) fail(g, 'sitemap', `${off.length} of ${locs.length} URLs not on ${CANON}: ${off[0]}`);
	else pass(g, 'sitemap', `${locs.length} URLs, all on ${CANON}`);

	// Every page the sitemap lists answers 200 on this host.
	const pages = locs.filter((u) => u.startsWith(CANON + '/'));
	const dead = [];
	await Promise.all(Array.from({ length: 6 }, async () => {
		for (let u; (u = pages.shift()); ) {
			const r = await get(u.replace(CANON, APEX), { method: 'HEAD' });
			if (r.status !== 200) dead.push(`${u.slice(CANON.length)} ${why(r)}`);
		}
	}));
	if (dead.length) fail(g, 'every sitemap page answers 200', `${dead.length} dead: ${dead.slice(0, 4).join('; ')}`);
	else if (locs.length) pass(g, 'every sitemap page answers 200', `${locs.length} pages`);
}

// ── registry ──────────────────────────────────────────────────────────────
async function registry() {
	const g = 'registry';
	await checkCert(g, REGISTRY);
	// A browser on the registry host is sent to the website's registry pages.
	const home = await req(REGISTRY + '/');
	const homeLoc = home.headers.get('location') || '';
	if (home.status === 301 && homeLoc === CANON + '/registry/') pass(g, `${REGISTRY}/ → website`, `301 → ${homeLoc}`);
	else if (home.status === 200) warn(g, `${REGISTRY}/ → website`, 'serves the old browse page (the router that sends it to doze-dev.com/registry/ is not deployed)');
	else fail(g, `${REGISTRY}/ → website`, `${why(home)} ${homeLoc}`);

	const here = dirname(fileURLToPath(import.meta.url));
	const repoKey = JSON.parse(readFileSync(join(here, '..', 'registry', 'doze', 'keys.json'), 'utf8')).key;
	const kr = await get(REGISTRY + '/doze/keys.json');
	let served = null;
	try { served = kr.status === 200 ? JSON.parse(await kr.text()).key : null; } catch {}
	if (served === COMPILED_KEY && repoKey === COMPILED_KEY) pass(g, 'doze/keys.json = compiled-in key', COMPILED_KEY.slice(0, 12) + '…');
	else fail(g, 'doze/keys.json = compiled-in key', `served ${served ?? why(kr)}, repo ${repoKey}, compiled ${COMPILED_KEY}`);
	const pub = publicKeyObject(COMPILED_KEY);

	const cr = await get(REGISTRY + '/index.json');
	let cat = null;
	try { cat = cr.status === 200 ? JSON.parse(await cr.text()) : null; } catch {}
	const mods = cat?.namespaces?.doze?.modules ?? {};
	const missing = EXPECTED.filter((m) => !mods[m]);
	if (!cat) fail(g, 'index.json catalog', why(cr));
	else if (missing.length) fail(g, 'index.json catalog', `missing ${missing.join(', ')}`);
	else pass(g, 'index.json catalog', `${Object.keys(mods).length} modules: ${Object.keys(mods).sort().join(' ')}`);

	const urls = [];
	for (const name of [...new Set([...Object.keys(mods), ...EXPECTED])].sort()) {
		const r = await get(`${REGISTRY}/doze/${name}/index.yaml`);
		const body = r.status === 200 ? await r.text() : '';
		if (r.status !== 200 || isHTML(body)) { fail(g, `doze/${name}/index.yaml`, r.status === 200 ? 'served HTML, not the index' : why(r)); continue; }
		let idx;
		try { idx = parseYaml(body); } catch (e) { fail(g, `doze/${name}/index.yaml`, `does not parse: ${e.message}`); continue; }
		const problems = [];
		if (idx?.schema !== SCHEMA) problems.push(`schema ${idx?.schema}`);
		if (idx?.module !== name || idx?.namespace !== 'doze') problems.push(`is ${idx?.namespace}/${idx?.module}`);
		if (!verifyIndex(pub, idx)) problems.push('index signature does not verify');
		const rels = idx?.releases ?? {};
		for (const [ch, v] of Object.entries(idx?.channels ?? {})) if (!rels[v]) problems.push(`channel ${ch} → ${v}: no such release`);
		if (!idx?.channels?.stable) problems.push('no stable channel');
		if (mods[name] && mods[name].version !== idx?.channels?.stable) problems.push(`catalog says ${mods[name].version}, stable is ${idx?.channels?.stable}`);
		let arts = 0;
		const triples = new Set();
		for (const [v, rel] of Object.entries(rels)) {
			for (const [t, a] of Object.entries(rel?.artifacts ?? {})) {
				arts++;
				if (v === idx?.channels?.stable) triples.add(t);
				if (!verify(pub, String(a?.sha256 ?? '').toLowerCase(), a?.sig)) problems.push(`${v} ${t}: artifact signature does not verify`);
				urls.push({ name, v, t, url: a?.url, sha: String(a?.sha256 ?? '').toLowerCase() });
			}
		}
		if (problems.length) fail(g, `doze/${name} index + signatures`, problems.join('; '));
		else pass(g, `doze/${name} index + signatures`, `stable ${idx.channels.stable}, ${Object.keys(rels).length} releases, ${arts} artifacts signed; ${[...triples].sort().join(' ')}`);
	}

	// Every artifact URL resolves (HEAD, following redirects); --deep downloads
	// each one and checks its sha256 too.
	const bad = [];
	const queue = [...urls];
	await Promise.all(Array.from({ length: 4 }, async () => {
		for (let u; (u = queue.shift()); ) {
			if (DEEP) {
				const r = await get(u.url);
				if (r.status !== 200) { bad.push(`${u.name} ${u.v} ${u.t}: ${why(r)}`); continue; }
				const got = sha256Hex(Buffer.from(await r.arrayBuffer()));
				if (got !== u.sha) bad.push(`${u.name} ${u.v} ${u.t}: sha256 ${got} ≠ ${u.sha}`);
			} else {
				const r = await get(u.url, { method: 'HEAD' });
				if (r.status !== 200) bad.push(`${u.name} ${u.v} ${u.t}: ${why(r)} ${u.url}`);
			}
		}
	}));
	const what = DEEP ? 'module archives download + sha256' : 'module archive URLs resolve';
	if (!urls.length) fail(g, what, 'no module index could be read');
	else if (bad.length) fail(g, what, `${bad.length} of ${urls.length}: ${bad.slice(0, 3).join('; ')}`);
	else pass(g, what, `${urls.length} of ${urls.length}`);
}

// ── install paths ─────────────────────────────────────────────────────────
async function install() {
	const g = 'install';
	const script = async (label, url) => {
		const r = await get(url);
		const t = r.status === 200 ? await r.text() : '';
		if (r.status === 200 && t.startsWith('#!')) pass(g, label, `${url} (${t.split('\n')[0]})`);
		else fail(g, label, `${url}: ${r.status === 200 ? 'not a shell script' + (isHTML(t) ? ' (HTML)' : '') : why(r)}`);
	};
	await script('doze install script', APEX + '/install.sh');
	await script('doze-aws install script', 'https://raw.githubusercontent.com/doze-dev/doze-aws/main/install.sh');
	await script('doze-kafka install script', 'https://raw.githubusercontent.com/doze-dev/doze-kafka/main/install.sh');
	// Those installers download from the repo's "latest" release, which must be
	// the product's own v* release, not a module's rolling release (tag aws/kafka).
	for (const repo of ['doze-aws', 'doze-kafka']) {
		const r = await get(`https://api.github.com/repos/doze-dev/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
		const t = r.status === 200 ? (await r.json()).tag_name : null;
		if (t && /^v\d/.test(t)) pass(g, `${repo} latest release is a v* tag`, t);
		else fail(g, `${repo} latest release is a v* tag`, t ? `${t}: its install.sh asks this release for the product tarball` : why(r));
	}

	const rel = await get('https://api.github.com/repos/doze-dev/doze/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
	const latest = rel.status === 200 ? await rel.json() : null;
	const tag = latest?.tag_name?.replace(/^v/, '');
	const [maj, min] = (tag || '0.0').split('.').map(Number);
	if (!latest) fail(g, 'latest doze release', why(rel));
	else if (maj === 0 && min < 2) fail(g, 'latest doze release', `v${tag}: doze 0.1 fetches modules from doze.nerdmenot.in and reads the old doze.hcl; the site documents 0.2`);
	else pass(g, 'latest doze release', `v${tag}, ${latest.assets?.length ?? 0} assets`);

	for (const [label, path] of [['Homebrew formula doze-dev/tap/doze', 'Formula/doze.rb'], ['Homebrew cask doze-dev/tap/doze', 'Casks/doze.rb']]) {
		const r = await get(`https://raw.githubusercontent.com/doze-dev/homebrew-tap/main/${path}`);
		const t = r.status === 200 ? await r.text() : '';
		if (r.status !== 200) { fail(g, label, `${path}: ${why(r)}`); continue; }
		const v = t.match(/^\s*version\s+"([^"]+)"/m)?.[1];
		const urlsIn = [...t.matchAll(/url\s+"([^"]+)"/g)].map((m) => m[1].replaceAll('#{version}', v ?? ''));
		const dead = [];
		for (const u of urlsIn) { const h = await get(u, { method: 'HEAD' }); if (h.status !== 200) dead.push(`${u} ${why(h)}`); }
		if (dead.length) fail(g, label, `version ${v}; dead: ${dead.join('; ')}`);
		else if (tag && v !== tag) fail(g, label, `version ${v}, latest release is ${tag}`);
		else pass(g, label, `version ${v}, ${urlsIn.length} download URL(s) resolve`);
	}
}

// ── run ───────────────────────────────────────────────────────────────────
console.log(`domain-check: apex ${APEX}${WWW ? `, www ${WWW}` : ''}, registry ${REGISTRY}${DEEP ? ' (deep)' : ''}\n`);
await site();
await registry();
await install();

const w = (k) => Math.max(...rows.map((r) => r[k].length));
const gw = w('group'), cw = Math.min(w('check'), 48);
for (const r of rows) console.log(`${r.status}  ${r.group.padEnd(gw)}  ${r.check.padEnd(cw)}  ${r.detail}`);
const n = (s) => rows.filter((r) => r.status === s).length;
console.log(`\n${n('PASS')} pass, ${n('FAIL')} fail, ${n('WARN')} warn, ${n('SKIP')} skip`);
process.exit(n('FAIL') ? 1 : 0);
