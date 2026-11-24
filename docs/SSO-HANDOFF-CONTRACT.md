# SSO handoff contract: user-service → external brand services

> Normative contract between:
> **issuer** = `user-service`, `POST /api/v1/auth/handoff`
> **sender** = the brand's loyalty SPA (where the user is already logged in)
> **receiver** = an external service of the *same brand* (a promo site, an
> ordering page, …) that wants to sign that user in without a second login.
>
> The generic sibling of `/pm-handoff` (see `SSO-PM-CONTRACT.md`), open to every
> role — customers included. `/pm-handoff` is unchanged.

---

## 1. Flow

```
 SPA (user logged in)                user-service                     receiver
 ────────────────────                ────────────                     ────────
 POST /api/v1/auth/handoff  ───────▶  checks session, target,
   Authorization: Bearer <user>       brand, membership
   { "target": "promo-site" }
                            ◀───────  200 { token, expiresIn: 60, url }

 auto-submit <form method=POST action=url> with token  ─────────────▶  verify token (§4)
                                                                         open its OWN session
                                                                         discard the token
```

The client never chooses where the token goes: `url` comes from server-side
configuration (§3).

---

## 2. Endpoint

`POST /api/v1/auth/handoff`, authenticated exactly like every other user
endpoint (user access token in `Authorization: Bearer …` or the access-token
cookie).

Request body:

```json
{ "target": "promo-site" }
```

Response `200` (`Cache-Control: no-store`):

```json
{ "token": "<jwt>", "expiresIn": 60, "url": "https://promo.example.com/handoff" }
```

Errors:

| Status | `error` | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | no user token (an invalid or expired token is refused earlier by the auth layer, also with `401`) |
| 404 | `UNKNOWN_HANDOFF_TARGET` | `target` missing, not a string, not configured, configured but invalid, **or** belonging to a different brand than the one resolved from the request host, **or** the host resolves to no brand |
| 403 | `FORBIDDEN` | user unknown, no membership in the resolved brand, or membership role not allowed by the target |
| 500 | `HANDOFF_FAILED` | unexpected error (e.g. signing keys not configured) |

A target of brand A is indistinguishable from a non-existent one when asked
from brand B's app: same `404`, no oracle.

---

## 3. Configuration — `HANDOFF_TARGETS`

A JSON object keyed by target key, set on user-service:

```json
{
  "promo-site": {
    "audience": "promo-site",
    "brandId": "3f2b8c1e-0000-4000-8000-000000000001",
    "url": "https://promo.example.com/handoff",
    "roles": ["USER", "STAFF", "MANAGER", "BRAND_MANAGER", "ADMIN"]
  }
}
```

| Field | Required | Rule |
|---|:--:|---|
| `audience` | ✅ | `aud` of the minted token. `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (no `:`), and **not** a reserved audience (below). |
| `brandId` | ✅ | UUID of the brand that owns the receiver. The target only exists for requests whose host resolves to this brand. |
| `url` | ✅ | Where the SPA posts the token. Must be `https://`; `http://` is accepted only for host `localhost` (development). |
| `roles` | ➖ | Non-empty array of `USER`, `STAFF`, `MANAGER`, `BRAND_MANAGER`, `ADMIN`. Omitted = any role with a membership in the brand. |

**Fail-closed.** Unset → the endpoint answers `404` to everything (the feature is
inert). Invalid JSON or a non-object → no target exists. An individual entry that
breaks any rule is dropped on its own and logged at boot as
`[handoff] HANDOFF_TARGETS entry ignored` with the key and the reason; the other
entries stay valid. The variable is parsed once per process: changes need a
restart.

**Reserved audiences.** Rejected at parse time so a misconfiguration can never
mint a token that a first-party verifier would accept:

- `frontend-spa` — default audience of user access tokens;
- `pizzeria-manager` — audience of `/pm-handoff` tokens;
- `campaign-service`, `messaging-service`, `user-service`, `business-service`,
  `domain-mapper-service` — the built-in service client ids;
- the value of `JWT_ISSUER` — audience of refresh tokens;
- every entry of `KEYCLOAK_AUDIENCE`, `KEYCLOAK_ALLOWED_AUDIENCES`,
  `KEYCLOAK_SERVICE_AUDIENCE`, `KEYCLOAK_CLIENT_ID`, `SERVICE_CLIENT_ID`;
- every client id in `INTERNAL_SERVICE_CLIENTS`, including the family of a
  per-tenant id (`report-service:tenant-x` reserves `report-service` too).

Matching is case-insensitive.

---

## 4. Token

RS256, header `alg=RS256`, `kid=<JWT_KID>`, `typ=JWT`. Signed with the same key
as every other user-service token; public key at `<issuer>/.well-known/jwks.json`.

| Claim | Present | Value |
|---|:--:|---|
| `iss` | ✅ | `JWT_ISSUER` of user-service |
| `aud` | ✅ | the target's `audience` |
| `azp` | ✅ | the target's `audience` (not `user-service`, so first-party gates that accept on `azp` refuse it) |
| `sub` | ✅ | stable user id — use it as the identity key, not a name |
| `iat`, `exp` | ✅ | `exp = iat + 60` |
| `jti` | ✅ | random, unique per token |
| `brandId` | ✅ | brand resolved server-side from the request host |
| `membershipRole` | ✅ | `USER` \| `STAFF` \| `MANAGER` \| `BRAND_MANAGER` \| `ADMIN` |
| `businessId` | ➖ | location of the membership, when it has one |
| `given_name` | ➖ | first name, when known |
| `typ` | ✅ | `Bearer` |
| `scope` | ✅ | `openid` |

**Deliberately absent:** `email`, `email_verified`, `preferred_username`,
`family_name`, `name`. The token leaves the platform; it carries only what a
receiver needs to open a session. A receiver that needs more must get the user's
consent on its own side.

Example payload:

```json
{
  "iss": "https://auth.example.com",
  "aud": "promo-site",
  "azp": "promo-site",
  "sub": "7d0c4a52-0000-4000-8000-000000000002",
  "given_name": "Alex",
  "brandId": "3f2b8c1e-0000-4000-8000-000000000001",
  "membershipRole": "USER",
  "businessId": "9a6e1f30-0000-4000-8000-000000000003",
  "typ": "Bearer",
  "scope": "openid",
  "iat": 1767225600,
  "exp": 1767225660,
  "jti": "5b8e2c14-0000-4000-8000-000000000004"
}
```

---

## 5. Issuer guarantees (user-service)

1. The brand comes from the request host (`resolveDomainFromRequest`), never
   from the body. The target's `brandId` must equal it.
2. The user must hold a membership **in that brand** (`findMembershipInBrand`,
   which also counts legacy rows that carry only a `businessId` of the brand). An
   account that exists only under another brand never receives a token.
3. The role check uses the membership's role against the target's `roles`.
4. No refresh token, no database write, no server-side state.

---

## 6. Receiver requirements (normative)

A receiver **MUST**:

1. Accept the token **only in a POST body** (form field `token`). Never in a URL
   query or fragment — that puts it in access logs, browser history and
   `Referer` headers.
2. Verify the signature against `<issuer>/.well-known/jwks.json` (cache the JWKS,
   select the key by `kid`, allow only `RS256`).
3. Verify `iss` equals the configured issuer exactly.
4. Verify `aud` equals **its own** audience exactly.
5. Verify `exp` (a small clock tolerance, ≤ 60 s, is fine).
6. Verify `brandId` equals **its own** brand id. A token of another brand is
   refused before any user record is created.
7. Treat the token as **single-use** where it has storage: remember each `jti`
   until its `exp` and refuse a repeat.
8. Then open **its own** session (its own cookie / token) and **discard** the
   handoff token. Never store it, never log it.
9. **Never** use the token to call user-service or any other platform API. It is
   an identity assertion for the receiver, not an API credential.

A receiver **SHOULD** use `sub` as the stable key for the user and treat
`given_name` as display data only.

---

## 7. Sender (SPA) side

1. Call the endpoint with the user's access token:

   ```ts
   const res = await api.post('/api/v1/auth/handoff', { target: 'promo-site' });
   const { token, url } = res.data;
   ```

2. Navigate by auto-submitting a form POST of `token` to the returned `url` —
   do not build a URL containing the token:

   ```ts
   const form = document.createElement('form');
   form.method = 'POST';
   form.action = url; // from the response, never from user input
   const input = document.createElement('input');
   input.type = 'hidden';
   input.name = 'token';
   input.value = token;
   form.appendChild(input);
   document.body.appendChild(form);
   form.submit();
   ```

3. Request the token right before navigating: it expires in 60 seconds. On
   `404` the target is not available for this brand; on `403` the user is not
   allowed — hide or disable the entry point rather than retry.

---

## 8. Environment variables

**user-service**

| Var | Value |
|---|---|
| `HANDOFF_TARGETS` | JSON described in §3. Unset = feature off. |
| `JWT_ISSUER`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID` | existing signing configuration |
| `DOMAIN_MAPPER_URL` | existing; used to resolve the brand from the request host |

**Receiver**: the issuer URL, the JWKS URL, its own audience, its own brand id.
