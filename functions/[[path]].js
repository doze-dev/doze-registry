// The doze.nerdmenot.in router. This Pages project (the signed registry) owns
// the domain; the documentation site lives in its own Pages project
// (doze-docs) with a fully independent deploy pipeline. This function keeps
// registry paths local and proxies everything else to the docs site — one
// seamless domain, two decoupled deployments.
//
// Kept deliberately tiny: it routes, rewrites redirect Locations back to the
// public host, and nothing else.

const DOCS_ORIGIN = "https://doze-docs.pages.dev";

// Paths served by THIS project (the registry). Everything else is docs.
function isRegistryPath(pathname) {
	return (
		pathname === "/registry" ||
		pathname.startsWith("/registry/") ||
		pathname.startsWith("/_registry-assets/")
	);
}

export async function onRequest({ request, next }) {
	const url = new URL(request.url);
	if (isRegistryPath(url.pathname)) {
		return next(); // this project's static assets
	}

	const upstream = new URL(url.pathname + url.search, DOCS_ORIGIN);
	const resp = await fetch(new Request(upstream, request), {
		redirect: "manual",
	});

	// Don't leak the internal pages.dev host in redirects (e.g. the docs site's
	// trailing-slash normalization).
	const location = resp.headers.get("location");
	if (location) {
		const loc = new URL(location, DOCS_ORIGIN);
		if (loc.origin === DOCS_ORIGIN) {
			const headers = new Headers(resp.headers);
			headers.set("location", loc.pathname + loc.search + loc.hash);
			return new Response(resp.body, {
				status: resp.status,
				statusText: resp.statusText,
				headers,
			});
		}
	}
	return resp;
}
