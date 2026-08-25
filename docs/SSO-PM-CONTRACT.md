# Contratto SSO Returnacy → PizzeriaManager

> Contratto normativo fra due repo separati:
> **emittente** = `user-service` (Returnacy), `POST /api/v1/auth/pm-handoff`
> **consumatore** = `PizzeriaManager`, `server/sso-service.ts` + rotta `GET /sso`
>
> Versione contratto: **v2** (aggiunge il tenant nei claim).
> v1 = quanto in produzione oggi (2026-08-25): **senza** claim di tenant.
> Nessuna delle due parti è ancora deployata con v2.

---

## 1. Perché v2 esiste (il buco che chiude)

In v1 il token handoff porta `aud=pizzeria-manager` e `membershipRole`, **ma nessun
identificativo di tenant**. Tutti i tenant Returnacy condividono **lo stesso issuer e
lo stesso JWKS** (`user.returnacy.app`), quindi la firma di un token Che Pizza è valida
per *qualunque* istanza PizzeriaManager.

La sede a cui il token si applica viaggia solo nel **fragment URL**, costruito lato
client (`chepizzadasalva/frontend-spa/src/features/scan/hooks/useChiusuraHandoff.tsx:44`):

```
https://<PM>/sso#token=<jwt>&loc=<businessId>&locName=<nome>
```

Il fragment è interamente controllabile da chi tiene il browser. Attacco concreto in v1:
uno *staff* Che Pizza mint il proprio token, apre a mano
`https://<PM-del-cliente-B>/sso#token=<suo-token>&loc=<businessId-del-cliente-B>`;
PM del cliente B verifica firma + issuer + audience → validi, e
`provisionSsoUser` **crea l'utente con `role: "Staff"`** e gli assegna la sede.
Risultato: accesso Staff alla contabilità di un altro cliente.

**v2 sposta la decisione di tenant dal fragment ai claim firmati.**

---

## 2. Claim del token v2

Algoritmo `RS256`. Header: `alg=RS256`, `kid=<JWT_KID>`, `typ=JWT`.

| Claim | Tipo | Obbl. | Valore | Note per PM |
|---|---|:--:|---|---|
| `iss` | string | ✅ | `JWT_ISSUER` di user-service | deve combaciare con `RETURNACY_ISSUER` |
| `aud` | string | ✅ | **`pizzeria-manager`** (invariato da v1) | verificare esattamente |
| `sub` | string | ✅ | `User.keycloakSub` di Returnacy | identità stabile, **non** l'email |
| `exp` | number | ✅ | `iat + 60` | TTL **60 s**, invariato da v1 |
| `iat`, `jti` | number/string | ✅ | standard | nessun jti-store: il TTL è il bound anti-replay |
| `email` | string | ✅ | email Returnacy, **già lowercase** | chiave di match utente lato PM |
| `email_verified` | boolean | ✅ | sempre `true` | |
| `preferred_username` | string | ✅ | = `email` | |
| `given_name` | string | ➖ | nome | assente se vuoto |
| `family_name` | string | ➖ | cognome | assente se vuoto |
| `name` | string | ➖ | `"nome cognome"` | assente se entrambi vuoti |
| `membershipRole` | string | ✅ | `STAFF` \| `MANAGER` \| `BRAND_MANAGER` \| `ADMIN` | maiuscolo, invariato da v1 |
| **`brandId`** | string (UUID) | ✅ **NUOVO** | brand Returnacy risolto **server-side** dall'host della richiesta | **il confine di sicurezza — vedi §3** |
| **`businessId`** | string (UUID) | ➖ **NUOVO** | sede, validata server-side; **omesso** se non validabile | vedi §4 |
| `typ` | string | ✅ | `Bearer` | |
| `azp` | string | ✅ | `user-service` | |
| `scope` | string | ✅ | `openid email profile` | |

### Esempio (payload decodificato)

```json
{
  "iss": "https://user.returnacy.app",
  "aud": "pizzeria-manager",
  "sub": "9f1c...-...-...",
  "email": "sara@example.com",
  "email_verified": true,
  "preferred_username": "sara@example.com",
  "given_name": "Sara",
  "family_name": "Rossi",
  "name": "Sara Rossi",
  "membershipRole": "STAFF",
  "brandId": "385d4ebb-4c4b-46e9-8701-0d71bfd7ce47",
  "businessId": "f103ce67-ad79-4bf6-99ca-1d632caf7786",
  "typ": "Bearer",
  "azp": "user-service",
  "scope": "openid email profile",
  "iat": 1756100000,
  "exp": 1756100060,
  "jti": "..."
}
```

---

## 3. `brandId` — il confine di sicurezza (obbligatorio per PM)

**Emittente (Returnacy).** `brandId` è risolto server-side dall'host della richiesta via
domain-mapper (`resolveDomainFromRequest`), **mai** dal body o da un header applicativo.
Se l'host non risolve a un brand → `403 FORBIDDEN`, nessun token emesso. Il chiamante
deve poi avere una membership `STAFF|MANAGER|BRAND_MANAGER|ADMIN` **su quel brand**
(`getMembershipByBrand`), altrimenti `403`. Questo è già il comportamento v1: l'unica
novità è che il brand così determinato ora **finisce nel token**.

**Consumatore (PizzeriaManager) — requisito normativo.**
PM DEVE dichiarare il proprio brand Returnacy in una env var e rifiutare ogni token il
cui `brandId` non combaci:

```
RETURNACY_BRAND_ID=385d4ebb-4c4b-46e9-8701-0d71bfd7ce47   # es. Che Pizza
```

```ts
if (claims.brandId !== process.env.RETURNACY_BRAND_ID) {
  // 403 — NON provisionare l'utente, NON creare userShops
}
```

Il confronto va fatto **prima** di `provisionSsoUser`: un token di un altro tenant non
deve mai arrivare a creare una riga in `users`.

---

## 4. `businessId` — sede, e perché è opzionale

**Non è un claim di sicurezza**: una volta che `brandId` è verificato (§3), un
`businessId` di un altro tenant è già impossibile da sfruttare. Serve solo a scegliere
*quale sede* dentro quel PM.

**Emittente.** Il client può proporre una sede nel body (`{"businessId": "..."}`) — è la
scelta giornaliera dello staff, feature viva in produzione (Taggi vs Lissaro). Il server
la accetta **solo** se riesce a dimostrarla appartenente al brand, con due fonti:
1. la membership dell'utente su quel brand (`membership.businessId`);
2. le entry di domain-mapper per quel brand (`fetchDomainBusinesses`).

Se nessuna delle due la conferma, **il claim viene omesso** (non viene messo un valore
non verificato). Nota di realtà: oggi `domain-mapping.json` contiene solo *una* sede
Che Pizza (Taggi `af941888…`); Lissaro `f103ce67…` **non c'è**. Quindi per Lissaro il
claim risulta presente solo se coincide con la membership dello staff. È accettabile
proprio perché non è il confine di sicurezza.

**Consumatore.**
- claim `businessId` **presente** → usarlo, **ignorare** il fragment `loc`;
- claim **assente** → è ammesso il fallback al fragment `loc`, ma **solo** dopo averlo
  mappato con `RETURNACY_SHOP_MAP` (che è per-PM e quindi può risolvere unicamente a
  shop di quel cliente).

Il fragment `loc`/`locName` resta nell'URL come **hint di UI** (preselezione della
pizzeria nel form chiusura). Non deve mai essere l'unica base di una decisione di
autorizzazione.

---

## 5. Ordine di deploy — vincolo forte

I due lati **non** possono essere deployati in ordine libero.

- Se **Returnacy va per prima**: PM v1 ignora i claim sconosciuti → nessuna rottura. ✅
- Se **PM va per prima** con l'enforcement attivo: tutti i token Che Pizza sono privi di
  `brandId` → `403` → **chiusura rotta in produzione su un sistema vivo**. ❌

Quindi PM DEVE introdurre l'enforcement dietro flag, spento di default:

```
RETURNACY_REQUIRE_BRAND_CLAIM=false   # default; true dopo che Returnacy v2 è live e verificato
```

Sequenza corretta:
1. Returnacy v2 in produzione; verificare che i token emessi contengano `brandId`
   (decodifica di un token reale, TTL 60 s).
2. PM deploy con `RETURNACY_BRAND_ID` valorizzata e `RETURNACY_REQUIRE_BRAND_CLAIM=false`
   (il confronto viene loggato ma non blocca).
3. Osservare i log: zero mismatch attesi per il traffico legittimo.
4. Flip a `RETURNACY_REQUIRE_BRAND_CLAIM=true`.
5. Ultimo cliente onboardato → il flag diventa `true` di default e il ramo v1 si rimuove.

Nel passo 2-3 un mismatch nei log **è un rilevamento, non rumore**: significa un token di
un altro tenant arrivato a quel PM.

---

## 6. Env var — riepilogo per lato

**Returnacy / user-service** (nessuna nuova var introdotta da v2):
`JWT_ISSUER`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID`, `DOMAIN_MAPPER_URL`.

**PizzeriaManager**:
| Var | Stato | Valore |
|---|---|---|
| `RETURNACY_ISSUER` | esistente | issuer di user-service |
| `RETURNACY_JWKS_URL` | esistente | `<issuer>/.well-known/jwks.json` |
| `RETURNACY_SHOP_MAP` | esistente | JSON `{"<businessId>": <shopId>}` |
| `RETURNACY_BRAND_ID` | **nuova** | brandId Returnacy del cliente di *questo* PM |
| `RETURNACY_REQUIRE_BRAND_CLAIM` | **nuova** | `false` → `true` dopo il passo 4 di §5 |

**SPA cliente** (`frontend-spa`): `VITE_PM_URL` = base URL del PM di *quel* cliente.

---

## 7. Cosa NON cambia

- Endpoint: `POST /api/v1/auth/pm-handoff`, risposta `{ token, expiresIn: 60 }`.
- Audience `pizzeria-manager`, TTL 60 s, algoritmo RS256, JWKS condiviso.
- Nessun refresh token, nessun jti-store.
- Landing PM: `GET /sso#token=…&loc=…&locName=…` — la forma dell'URL resta identica,
  cambia solo il *peso decisionale* di `loc` (§4).
- `membershipRole` e l'insieme dei ruoli ammessi al mint.

---

## 8. Checklist di verifica congiunta (da fare in staging, non in prod)

- [ ] Token Che Pizza decodificato: `brandId` presente e = brand Che Pizza.
- [ ] PM Che Pizza con `RETURNACY_BRAND_ID` di Che Pizza → handoff OK, sede preselezionata.
- [ ] **Test cross-tenant**: token Che Pizza → PM cliente B con `REQUIRE_BRAND_CLAIM=true`
      → **403**, e **nessuna riga creata** in `users` / `userShops` lato B.
- [ ] Token senza `brandId` (v1 simulato) con flag `false` → passa + warning a log;
      con flag `true` → 403.
- [ ] Staff Lissaro: chiusura sulla sede giusta (claim `businessId` presente **oppure**
      fallback `loc` mappato) — è il caso che rischia la regressione.
