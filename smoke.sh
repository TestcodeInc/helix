#!/usr/bin/env bash
# Helix multi-user smoke test: invite → account → OAuth 2.1 → MCP tools + isolation.
# Usage: ./smoke.sh [base_url]   (default http://localhost:8788)
set -euo pipefail
BASE="${1:-http://localhost:8788}"
ADMIN="${ADMIN_SECRET:-admin-local}"
CB="http://localhost:9999/callback"

# --- helper: full OAuth flow for a user, prints access token ---
get_token() {
  local email="$1" pass="$2" scopes="$3"
  local reg client_id v ch cbe oreq loc code args
  reg=$(curl -s -X POST "$BASE/register" -H 'Content-Type: application/json' \
    -d "{\"redirect_uris\":[\"$CB\"],\"client_name\":\"Smoke $email\",\"token_endpoint_auth_method\":\"none\"}")
  client_id=$(echo "$reg" | python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])')
  v=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')
  ch=$(python3 -c "import hashlib,base64;print(base64.urlsafe_b64encode(hashlib.sha256('$v'.encode()).digest()).rstrip(b'=').decode())")
  cbe=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$CB',safe=''))")
  oreq=$(curl -s "$BASE/authorize?response_type=code&client_id=$client_id&redirect_uri=$cbe&scope=identity&code_challenge=$ch&code_challenge_method=S256&state=x" \
    | grep -o 'name="oauthreq" value="[^"]*"' | sed 's/.*value="//;s/"$//')
  args=(--data-urlencode "oauthreq=$oreq" --data-urlencode "client_name=Smoke $email" \
        --data-urlencode "email=$email" --data-urlencode "passphrase=$pass")
  for s in $scopes; do args+=(--data-urlencode "scopes=$s"); done
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/authorize" "${args[@]}")
  code=$(python3 -c "import urllib.parse;print(urllib.parse.parse_qs(urllib.parse.urlparse('$loc').query)['code'][0])")
  curl -s -X POST "$BASE/token" \
    --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$code" \
    --data-urlencode "client_id=$client_id" --data-urlencode "redirect_uri=$CB" \
    --data-urlencode "code_verifier=$v" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])'
}

# --- helper: MCP call, prints response body ---
mcp_call() {
  local token="$1" sid="$2" body="$3"
  curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $token" \
    ${sid:+-H "mcp-session-id: $sid"} -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -d "$body"
}

mcp_session() {
  local token="$1" h; h=$(mktemp)
  curl -s -D "$h" -o /dev/null -X POST "$BASE/mcp" -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  grep -i '^mcp-session-id:' "$h" | tr -d '\r' | awk '{print $2}'
}

# --- helper: cookie from a response ---
get_cookie() { grep -i '^set-cookie' | sed 's/[Ss]et-[Cc]ookie: //I' | tr -d '\r' | cut -d';' -f1; }

# --- helper: create user via admin invite (admin cookie flow) ---
ACOOKIE=""
make_user() {
  local name="$1" email="$2" pass="$3" userid="$4"
  local invite_url
  if [ -z "$ACOOKIE" ]; then
    ACOOKIE=$(curl -s -D - -o /dev/null -X POST "$BASE/admin/unlock" --data-urlencode "secret=$ADMIN" | get_cookie)
    [ -n "$ACOOKIE" ] || { echo "FAIL: admin unlock"; exit 1; }
  fi
  invite_url=$(curl -s -X POST "$BASE/admin" -H "Cookie: $ACOOKIE" \
    --data-urlencode "name=$name" \
    --data-urlencode "email=$email" --data-urlencode "userId=$userid" \
    | grep -o 'id="invite">[^<]*' | sed 's/id="invite">//')
  [ -n "$invite_url" ] || { echo "FAIL: no invite url for $email"; exit 1; }
  curl -s -o /dev/null -w '%{http_code}' -X POST "$invite_url" \
    --data-urlencode "passphrase=$pass" --data-urlencode "passphrase2=$pass" | grep -q 302
}

echo "== 1. Create two users via admin invites"
make_user "Alice Test" "alice@test.dev" "alice-pass-123" "alice" && echo "alice ok"
make_user "Bob Test" "bob@test.dev" "bob-pass-1234" "bob" && echo "bob ok"

echo "== 2. Alice: OAuth with full scopes"
TOK_A=$(get_token "alice@test.dev" "alice-pass-123" "identity work projects preferences relationships communication-style propose")
SID_A=$(mcp_session "$TOK_A")
echo "alice token+session ok"

echo "== 3. Alice: propose + read own context (with pending nudge)"
mcp_call "$TOK_A" "$SID_A" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_learning","arguments":{"category":"work","fact":"Alice is testing Helix","source":"smoke"}}}' | grep -o 'Proposed to Helix' | head -1
CTX_A=$(mcp_call "$TOK_A" "$SID_A" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_context","arguments":{"category":"identity"}}}')
echo "$CTX_A" | grep -o 'Alice Test' | head -1
echo "$CTX_A" | grep -q 'review queue' && echo "pending nudge present: ok" || { echo "FAIL: no pending nudge"; exit 1; }

echo "== 4. Bob: OAuth identity-only, verify isolation"
TOK_B=$(get_token "bob@test.dev" "bob-pass-1234" "identity")
SID_B=$(mcp_session "$TOK_B")
BOB_CTX=$(mcp_call "$TOK_B" "$SID_B" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_context","arguments":{}}}')
echo "$BOB_CTX" | grep -q 'Bob Test' && echo "bob sees bob: ok"
if echo "$BOB_CTX" | grep -q 'Alice'; then echo "FAIL: bob can see alice's data"; exit 1; else echo "bob cannot see alice: ok"; fi
if mcp_call "$TOK_B" "$SID_B" '{"jsonrpc":"2.0","id":5,"method":"tools/list"}' | grep -o '"name":"[^"]*"' | grep -q propose_learning; then
  echo "FAIL: bob has propose without scope"; exit 1
else echo "bob has no propose tool: ok"; fi

echo "== 5. Wrong passphrase is rejected"
REG=$(curl -s -X POST "$BASE/register" -H 'Content-Type: application/json' -d "{\"redirect_uris\":[\"$CB\"],\"client_name\":\"BadLogin\",\"token_endpoint_auth_method\":\"none\"}")
CID=$(echo "$REG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])')
CBE=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$CB',safe=''))")
OREQ=$(curl -s "$BASE/authorize?response_type=code&client_id=$CID&redirect_uri=$CBE&scope=identity&code_challenge=AAAA&code_challenge_method=plain&state=x" | grep -o 'name="oauthreq" value="[^"]*"' | sed 's/.*value="//;s/"$//')
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/authorize" \
  --data-urlencode "oauthreq=$OREQ" --data-urlencode "client_name=BadLogin" \
  --data-urlencode "email=alice@test.dev" --data-urlencode "passphrase=WRONG" \
  --data-urlencode "scopes=identity")
if [ "$STATUS" = "401" ]; then echo "wrong passphrase rejected: ok"; else echo "FAIL: expected 401, got $STATUS"; exit 1; fi

echo "== 6. Alice revokes the app; its token dies"
LCOOKIE=$(curl -s -D - -o /dev/null -X POST "$BASE/login" --data-urlencode "email=alice@test.dev" --data-urlencode "passphrase=alice-pass-123" | get_cookie)
GRANT=$(curl -s "$BASE/connections" -H "Cookie: $LCOOKIE" | grep -o 'name="grantId" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//')
[ -n "$GRANT" ] || { echo "FAIL: no grant listed on /connections"; exit 1; }
echo "grant listed: ok"
curl -s -o /dev/null -X POST "$BASE/connections/revoke" -H "Cookie: $LCOOKIE" --data-urlencode "grantId=$GRANT"
RSTATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer $TOK_A" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/list"}')
if [ "$RSTATUS" = "401" ]; then echo "revoked token rejected: ok"; else echo "FAIL: expected 401 after revoke, got $RSTATUS"; exit 1; fi

echo "SMOKE OK"
