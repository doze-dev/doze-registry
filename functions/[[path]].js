// The doze-registry router. This Pages project serves the signed registry at
// registry.doze-dev.com (and at doze-registry.pages.dev): doze fetches
// /<ns>/<module>/index.yaml from the root of that host. The website, docs and
// the registry's browse pages included, is its own Pages project at
// doze-dev.com.
//
// Kept deliberately tiny: it maps registry hosts onto the /registry tree, and
// sends any other host to the website.

const SITE_ORIGIN = "https://doze-dev.com";

// Paths served by THIS project as they are.
function isRegistryPath(pathname) {
	return (
		pathname === "/registry" ||
		pathname.startsWith("/registry/") ||
		pathname.startsWith("/_registry-assets/")
	);
}

function isRegistryHost(hostname) {
	return (
		hostname.startsWith("registry.") ||
		hostname.endsWith("doze-registry.pages.dev")
	);
}

export async function onRequest({ request, next, env }) {
	const url = new URL(request.url);
	// registry.<domain> (and this project's own pages.dev host) serves the signed
	// registry at the root — /<ns>/<module>/index.yaml — which is what doze fetches.
	if (isRegistryHost(url.hostname)) {
		// The host is for doze; people browse the registry on the website. A page
		// (a path ending in "/") goes to its twin there: / → /registry/,
		// /doze/postgres/ → /registry/doze/postgres/. Files are served as they are.
		if (url.pathname.endsWith("/")) {
			const page = url.pathname.replace(/^\/registry(?=\/)/, "");
			return Response.redirect(SITE_ORIGIN + "/registry" + page + url.search, 301);
		}
		if (isRegistryPath(url.pathname)) return next();
		const inner = new URL("/registry" + url.pathname + url.search, url);
		const resp = await env.ASSETS.fetch(new Request(inner, request));
		// The site's own root files (favicons, logo, og.png) live outside
		// /registry; serve them as they are rather than 404.
		if (resp.status === 404) return next();
		return resp;
	}
	if (url.pathname.startsWith("/registry/") && url.pathname.endsWith("/")) {
		return Response.redirect(SITE_ORIGIN + url.pathname + url.search, 301); // a browse page
	}
	if (isRegistryPath(url.pathname)) {
		return next(); // the signed files, under /registry as doze 0.1 reads them
	}

	// Any other host attached to this project (the retired doze.nerdmenot.in,
	// say) sends everything that is not the registry to the website, which
	// redirects the old docs paths itself.
	return Response.redirect(SITE_ORIGIN + url.pathname + url.search, 301);
}
