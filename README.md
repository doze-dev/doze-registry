# doze-registry

The signed module registry for [doze](https://github.com/doze-dev/doze). It serves
the **discovery layer** — tiny, signed text files that tell doze where each engine
module lives and let it verify the module is authentic. It is a static site deployed
to **Cloudflare Pages** at `doze.nerdmenot.in`, with the registry under `/registry`.

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
      index.yaml               # versions + per-platform artifacts {url, sha256, sig}
```

Served (Cloudflare Pages):

```
doze.nerdmenot.in/registry/<namespace>/keys.json
doze.nerdmenot.in/registry/<namespace>/<name>/index.yaml
doze.nerdmenot.in/registry/index.json     # generated machine catalog
doze.nerdmenot.in/registry/               # generated human browse page
```

`index.yaml` matches the manifest doze already understands:

```yaml
engines:
  valkey:
    versions:
      default: "0.1.0"        # the channel doze resolves when nothing is pinned
    artifacts:
      "0.1.0":
        aarch64-apple-darwin:
          url: https://github.com/doze-dev/doze-modules/releases/download/valkey/valkey-0.1.0-aarch64-apple-darwin.tar.gz
          sha256: <hex>
          sig: <base64 ed25519 over the hex sha256>
```

## How doze consumes it

A doze engine type resolves to a registry **source** `<namespace>/<name>`. The default
is `doze/<type>`; override per type in a `modules {}` block:

```hcl
modules {
  postgres { source = "doze/postgres", version = "16" }
  cache    { source = "acme/valkey" }          # a third-party publisher
}
```

For each source doze:

1. fetches `<base>/<namespace>/keys.json` and **pins the publisher key on first use**
   (trust-on-first-use, recorded in `doze.lock` under `keys:`). A later key change is a
   hard error until the pin is cleared — a compromised registry can't silently swap keys.
2. fetches `<base>/<namespace>/<name>/index.yaml`, resolves the version, downloads the
   archive, and accepts it only if its SHA256 matches **and** carries a valid signature
   from the pinned key. Unsigned ⇒ rejected.
3. pins the resolved version + checksum in `doze.lock` (reproducible installs).

`<base>` defaults to `https://doze.nerdmenot.in/registry`; override with
`DOZE_MODULES_MIRROR` (a URL or `file://` path) or a `modules { mirror = … }`.

## Publishing a module

1. **One-time, per namespace** — generate a keypair:
   ```sh
   bun scripts/keygen.mjs <namespace>
   ```
   Commit `registry/<namespace>/keys.json` (public). Keep `<namespace>.secret.key`
   secret (it's gitignored) — store it in a vault / CI secret. It is the only thing that
   can sign for your namespace.

2. **Per release** — build the per-platform archives, upload them (e.g. to a GitHub
   release), then sign each into the module index:
   ```sh
   export DOZE_SIGNING_KEY="$(cat <namespace>.secret.key)"
   bun scripts/sign.mjs <namespace>/<name> <version> <triple> <archive-url> <archive.tar.gz>
   ```
   Repeat per triple (`aarch64-apple-darwin`, `x86_64-apple-darwin`,
   `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`).

3. **Open a PR.** CI runs `validate` (structure + every signature) and, on PRs,
   `validate:remote` (each archive is reachable and its SHA256 matches the manifest).

## Scripts

| command | what it does |
| --- | --- |
| `bun run validate` | offline: structure + every artifact signature verifies against its namespace key |
| `bun run validate:remote` | also fetch each archive and re-check its SHA256 |
| `bun run build` | validate, then assemble `dist/` (registry files + catalog + browse page + root site) |
| `bun run keygen <ns>` | create a namespace publisher keypair |
| `bun run sign …` | sign an archive into a module's `index.yaml` |
| `bun run deploy` | build + `wrangler pages deploy dist` |

Validation mirrors exactly what the doze client enforces, so a green `validate` means
clients will accept the registry.

## Deploy (Cloudflare Pages)

One Pages project (`doze`) serves this whole site; the registry is just the
`/registry` subtree. The **doze docs site** will be built into the root (`public/` /
a docs generator) later — it lands at `doze.nerdmenot.in/` while the registry stays
under `/registry`.

One-time setup:

```sh
# 1. create the Pages project
bunx wrangler pages project create doze --production-branch main

# 2. point the domain at it (domain is already on Cloudflare):
#    Dashboard → Workers & Pages → doze → Custom domains → add doze.nerdmenot.in
#    (auto-creates the CNAME since nerdmenot.in is a Cloudflare zone)
```

Deploy manually:

```sh
bun run deploy
```

Or automatically: the `deploy` workflow publishes on every push to `main` given repo
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Why a separate discovery layer?

doze pins both the resolved version+checksum and the publisher key in `doze.lock`, so
the registry only has to be *available*, not *trusted*: every byte doze runs is checked
against keys committed here and a lock the user controls. Hosting it as static files on
a CDN (rather than a server) keeps it cheap, fast, and tamper-evident.
