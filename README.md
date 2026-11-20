# doze-registry

> [!WARNING]
> **Still in active development.** This project is not cleared for use yet. Expect breaking changes, and do not rely on it for real work.

The signed module registry for [doze](https://github.com/doze-dev/doze): the data and
the publishing, nothing to browse. It holds the **discovery layer** — tiny, signed
text files that tell doze where each engine module lives and let it verify the module
is authentic — and the tooling and workflows that sign releases into it. The files are
deployed as plain static files to **Cloudflare Pages** (project `doze-registry`) and
served at the root of `registry.doze-dev.com`, which only the `doze` CLI reads.

**The registry portal people read is the website:
[doze-dev.com/registry](https://doze-dev.com/registry/)** (repo
[doze-website](https://github.com/doze-dev/doze-website), built from this repo's
`registry/`). Every deploy here asks the website to rebuild.

Archives (the actual plugin tarballs) are **not** hosted here — each module's
`index.yaml` points at wherever the archive lives (GitHub Releases). The ed25519
signature is over the archive's SHA256, so the archive host is untrusted by design:
a tampered download fails verification no matter who serves it.

## Layout

```
registry/
  <namespace>/
    keys.json                  # { namespace, key }  — the publisher's ed25519 public key
    <name>/
      index.yaml               # schema-1 module index: releases + channels, signed
      meta.yaml                # docs prose (from the module's --describe, by doze-module-release)
      source                   # owner/repo whose release it is signed from (doze-dev/doze-rs)
```

Served (Cloudflare Pages, static files only, no Functions). `bun run build`
(`scripts/build.mjs`) validates, copies the signed files into `dist/` byte for
byte, and generates the catalog and the two Pages control files:

```
registry.doze-dev.com/<namespace>/keys.json
registry.doze-dev.com/<namespace>/<name>/index.yaml
registry.doze-dev.com/<namespace>/<name>/meta.yaml   # docs for `doze modules docs`
registry.doze-dev.com/index.json                     # generated machine catalog
```

- `_headers`: `text/yaml; charset=utf-8` for the YAML, `application/json;
  charset=utf-8` for the JSON, `X-Content-Type-Options: nosniff` everywhere, and
  short caching (60 s for `index.yaml` and `index.json`, 5 min for `meta.yaml`,
  1 h for `keys.json`). Nothing here is immutable: the archives live on GitHub
  Releases.
- `_redirects`: anything that is not a data file is a 301 to the website. `/` goes
  to `https://doze-dev.com/registry/`, `/<ns>` to `…/registry/<ns>/`,
  `/<ns>/<name>/…` to `…/registry/<ns>/<name>/…`, the old `/registry/…` prefix
  drops the prefix (so `/registry/doze/postgres/index.yaml` still reaches the file),
  and everything else goes to `…/registry/`. On Pages a rule beats a static file,
  so each data file is listed first as a `200` rule to itself.

`index.yaml` is the schema-1 module index (`doze-sdk/modindex`). It versions the
**module** (the plugin binary) — a separate axis from the **engine** version a
user declares (`version = 18`) — and states, per release, which engine majors
the release supports and which doze plugin protocol it speaks:

```yaml
schema: 1
module: valkey
namespace: doze
releases:
  "0.3.0":
    protocol: 2                     # doze module protocol this binary speaks (the Rust doze: 2)
    engines: ["8", "9"]             # engine majors it supports (absent = versionless)
    artifacts:
      aarch64-apple-darwin:
        url: https://github.com/doze-dev/doze-rs/releases/download/valkey/valkey-plugin-0.3.0-aarch64-apple-darwin.tar.gz
        sha256: <hex>
        sig: <base64 ed25519 over the hex sha256>
channels:
  stable: "0.3.0"                   # the head a fresh resolve prefers
signature: <base64 ed25519 over the canonical index payload>
```

Two signatures, two jobs: each artifact `sig` gates what doze will *execute*;
the index-level `signature` covers the *metadata* (protocol, engine support,
channel heads), so a compromised CDN can't claim false compatibility or roll a
channel back.

## How doze consumes it

A doze engine type resolves to the registry **source** `doze/<type>`: `module
postgres "db" { version = 18 }` is the module `doze/postgres`. The engine version
stays the block's own `version =`; the module release is chosen by doze and pinned
in `doze.lock`.

For each source doze:

1. trusts only the registry key compiled into it (`RegistryKey`), never a key it
   fetches, so a compromised registry host can't hand a fresh install its own key.
   `<namespace>/keys.json` publishes the same key for people and tools.
2. fetches `<base>/<namespace>/<name>/index.yaml`, verifies the **index signature**, and
   selects the newest release compatible with its plugin protocol and the engine majors
   the config declares (preferring the `stable` head). The archive is accepted only if
   its SHA256 matches **and** carries a valid signature from that key.
3. pins the selected release (version, protocol, engine support, per-triple checksums)
   in `doze.lock` — the developer never names a module version. `doze modules upgrade`
   moves the pin; an unsupported declared engine version fails with that exact command.

`<base>` is `https://registry.doze-dev.com`, compiled into doze (`RegistryBase` in
`internal/modules/modules.go`) together with the registry key (`RegistryKey`); doze 0.2
has no override. doze 0.1 builds used `https://doze.nerdmenot.in/registry` and read
`DOZE_MODULES_MIRROR`.

## Publishing a module

> **Runtimes.** Every `npm run …` script is mapped to **node**, and that is not
> cosmetic: Bun (≤1.2.x) silently mangles ed25519 key derivation, which with a
> namespace key at stake could write a `keys.json` that doesn't match its own
> secret. The key-handling scripts (`keygen`, `sign`, `publish`) run a
> functional ed25519 self-test on startup and refuse to continue on a broken
> runtime — so `bun scripts/publish.mjs` fails loudly instead of subtly.
> Verification is unaffected; `validate` and `build` work anywhere.

1. **One-time, per namespace** — generate a keypair:
   ```sh
   npm run keygen <namespace>
   ```
   Commit `registry/<namespace>/keys.json` (public). Keep `<namespace>.secret.key`
   secret (it's gitignored) — store it in a vault / CI secret. It is the only thing that
   can sign for your namespace.

2. **Per release** — build the schema-1 release layout with `doze-module-release` (doze-rs),
   upload the archives (e.g. to a GitHub release), then sign the whole release
   into the registry:
   ```sh
   export DOZE_SIGNING_KEY="$(cat <namespace>.secret.key)"
   npm run publish <namespace>/<name>
   ```
   (`npm run sign …` is the manual per-artifact fallback; both sign each
   artifact's SHA256 *and* the index itself.)

3. **Open a PR.** CI runs `validate` (structure + every signature) and, on PRs,
   `validate:remote` (each archive is reachable and its SHA256 matches the manifest).

## Protocols and withdrawn versions

Every module is the Rust build from doze-rs and speaks module protocol 2. A doze selects only
releases whose protocol is its own (the Go doze: `r.Protocol == dozeplugin.ProtocolVersion`), so
the Go doze (protocol 1) never picks a protocol-2 release; it says no release fits instead.

The Go-built modules (protocol 1) were withdrawn on 2026-11-18. `withdrawn.yaml` lists each one
with the versions it took out. A withdrawal covers those versions, not the name: `validate` and
`publish` refuse a withdrawn version anywhere, and once the module is back every new version is
append-only as usual. The Rust releases start at 0.3.0, above every Go version (the highest was
aws 0.2.0 and postgres 0.2.4).

## The publishing lifecycle (and provisional indexes)

The **authoritative** path is fully automated and needs no human key handling:

```
doze-rs tag module/<name>/v<x> → modules-release.yml runs the acceptance on every target, builds,
                  uploads the rolling release <name> in doze-rs (index.yaml + archives + meta.yaml)
                  → this repo's publish workflow finds it (hourly schedule, or a manual
                    `gh workflow run publish.yml -f modules="<name>"`) and signs it (DOZE_SIGNING_KEY)
                  → validate + validate:remote gate → bot commits → deploy to Pages
                  → repository_dispatch "registry-published" → doze-website rebuilds /registry
```

A **local publish** exists for development and for staging a release before CI
has produced it:

```sh
# sign a locally built doze-module-release dist against its future public URLs
npm run publish doze/postgres -- \
  --release-base file://$PWD/../doze-rs/dist/postgres \
  --artifact-base https://github.com/doze-dev/doze-rs/releases/download/postgres
```

An index published this way is **provisional**: it is correctly signed and
passes offline `validate`, but its artifact URLs point at a release that may not
exist yet (and CI's own build may produce different bytes, hence different
SHA256s). That is expected and self-healing — the next dispatch-triggered
publish re-signs from the *actual* release and overwrites the provisional
entries. The two validate modes encode exactly this split:

| gate | question it answers | when it can fail legitimately |
| --- | --- | --- |
| `npm run validate` (offline) | is every file well-formed and every signature valid? | never — this always gates deploys |
| `npm run validate:remote` | do the signed SHA256s match what the URLs actually serve? | while an index is provisional (release not yet uploaded) |

So: a red `validate` is always a bug; a red `validate:remote` right after a
local publish usually just means "the GitHub release isn't up yet."

## Scripts

| command | what it does |
| --- | --- |
| `npm run validate` | offline: structure, schema, index signature + every artifact signature |
| `npm run validate:remote` | also fetch each archive and re-check its SHA256 |
| `npm run build` | validate, then assemble `dist/`: the signed files, `index.json`, `_headers`, `_redirects` |
| `npm run keygen <ns>` | create a namespace publisher keypair (node — self-tests ed25519 first) |
| `npm run sign …` | sign one archive into a module's `index.yaml` (+ re-sign the index) |
| `npm run publish <ns>/<name>` | sign a whole release into the registry (the usual path) |
| `npm run deploy` | build + `wrangler pages deploy dist --project-name=doze-registry` |
| `npm run domain-check` | check the public hosts from the outside (see below) |

Validation mirrors exactly what the doze client enforces, so a green `validate` means
clients will accept the registry.

## Deploy (Cloudflare Pages)

One Pages project (`doze-registry`) serves the data. The website, its registry
portal and the docs are a separate project (`doze-website`) at `doze-dev.com`.

One-time setup:

```sh
# 1. create the Pages project
bunx wrangler pages project create doze-registry --production-branch main

# 2. point the domain at it (doze-dev.com is a Cloudflare zone):
#    Dashboard → Workers & Pages → doze-registry → Custom domains
#    → add registry.doze-dev.com (Cloudflare creates the CNAME)
```

Deploy manually:

```sh
bun run deploy
```

Or automatically: the `deploy` workflow publishes on every push to `main` given repo
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It then sends a
`repository_dispatch` of type `registry-published` to `doze-dev/doze-website`, which
rebuilds its registry pages from this repo. That step needs the secret
`WEBSITE_DISPATCH_TOKEN`: a fine-grained token on `doze-dev/doze-website` with
**Contents: read and write**. Without it the step skips with a notice, and the
website's nightly build picks the change up instead.

Check what a fresh user would hit, from the outside:

```sh
scripts/domain-check.sh            # doze-dev.com, www, registry.doze-dev.com
scripts/domain-check.sh --pages    # the same checks against the *.pages.dev hosts
scripts/domain-check.sh --deep     # also download every module archive and check its sha256
```

It checks https and the certificate on each host, `www` → apex as a 301, that the
registry host's `/` and module paths 301 to the website, that every data file answers
200 with its content type and `nosniff`, every
module's `index.yaml` and artifact signatures against the key doze compiles in,
that every artifact URL resolves, and the install paths (install script, Homebrew
tap, the latest doze release). It prints a pass/fail table and exits non-zero on
any failure.

## Why a separate discovery layer?

doze pins both the resolved version+checksum and the publisher key in `doze.lock`, so
the registry only has to be *available*, not *trusted*: every byte doze runs is checked
against keys committed here and a lock the user controls. Hosting it as static files on
a CDN (rather than a server) keeps it cheap, fast, and tamper-evident.

## License

Apache 2.0 — see [LICENSE](LICENSE).
