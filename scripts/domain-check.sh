#!/bin/sh
# domain-check.sh: check doze's public hosts the way a fresh user meets them.
#
#   scripts/domain-check.sh            doze-dev.com, www.doze-dev.com, registry.doze-dev.com
#   scripts/domain-check.sh --pages    the same checks against the *.pages.dev hosts
#   scripts/domain-check.sh --deep     also download every module archive and check its sha256
#
# Override a host with APEX=, WWW= or REGISTRY= (full origins, no trailing
# slash). Needs bun. Prints a PASS/FAIL table; exits 1 if anything fails.
set -eu
cd "$(dirname "$0")/.."
command -v bun >/dev/null 2>&1 || { echo "domain-check: bun is required (https://bun.sh)" >&2; exit 2; }
[ -d node_modules/yaml ] || bun install --frozen-lockfile >/dev/null
exec bun scripts/domain-check.mjs "$@"
