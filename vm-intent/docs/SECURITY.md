# Sign-in and permissions

vm-intent's REST API can require callers to sign in, in either of two ways:

- **Microsoft Entra ID access tokens.** People and services sign in with Entra, and Entra **app roles**
  decide what each caller may do.
- **Client certificates (PKI).** A caller connects with a certificate from a CA you trust. An **allowlist**
  on the server names the specific certificates that may call, and gives each one a role. See
  [Client certificates (PKI)](#client-certificates-pki).

Both lead to the same four roles and the same rules for each operation.

| `VMINTENT_SECURITY_MODE` | Who may call |
|---|---|
| `none` (default) | Anyone who can reach the API. Keep it on a private network. |
| `entra` | Callers with an Entra ID access token for this API |
| `pki` | Callers with a client certificate on the allowlist |
| `entra,pki` | Either one |

The API docs (`/swagger-ui.html`, `/v3/api-docs`) stay open, so callers can find out how to sign in.

**Entra ID settings**

| Setting (environment variable) | Value |
|---|---|
| `VMINTENT_ENTRA_TENANT_ID` | Your Entra tenant (directory) ID |
| `VMINTENT_ENTRA_AUDIENCES` | The API's Application ID URI and/or client ID, comma-separated, e.g. `api://vm-intent,<client-id>` |
| `VMINTENT_SWAGGER_CLIENT_ID` | Optional: client ID of a SPA registration, for Swagger UI's **Authorize** button |

## Roles

Each role includes the ones below it.

| vm-intent role | Entra app role (value) | Can |
|---|---|---|
| `ADMIN` | `VmIntent.Admin` | Everything, including changing anyone's request or VM, and running the inventory check and archive sweep |
| `OPERATOR` | `VmIntent.Operator` | Technical operators: publish and retire catalog definitions ([DEFINITIONS.md](DEFINITIONS.md)), resume or tear down **anyone's** catalog run; plus REQUESTER |
| `AUDITOR` | `VmIntent.Auditor` | The decision log, the history archive and audit replays ([AUDIT.md](AUDIT.md)); plus READER |
| `BATCH` | `VmIntent.Batch` | `POST /api/v2/batches`, `POST /api/v1/vms` (legacy), plus everything READER can |
| `REQUESTER` | `VmIntent.Request` | Interpret, create, answer, confirm and cancel **their own** requests; renew, resize, power, snapshot and remove **their own** VMs; start catalog runs, resume or tear down **their own**, approve **someone else's**; plus READER |
| `READER` | `VmIntent.Read` | `GET`s: inventory, stats, audit trail, request, batch, definition and run status (not the decision log or archive) |

- With Entra ID, roles come from the token's `roles` claim (app roles) and `scp` claim (delegated scopes with
  the same names). With client certificates, the allowlist gives each certificate its role.
- **Only the requester** (or an ADMIN) can answer, confirm or cancel a request, or change the VM it built. Anyone else gets 403.
- **Catalog runs:** the person who started a run, or an OPERATOR, can resume or tear it down. An approval step
  can be answered by anyone **except** the person who started the run (four-eyes), and only by the step's
  `approvers` if it lists them. If `VMINTENT_OPA_URL` is set, OPA must allow these too.
- **Every authorization decision is logged**, allowed or refused, with the rule that decided
  (`GET /api/v2/compliance/decisions`, AUDITOR). See [AUDIT.md](AUDIT.md).
- **The audit trail records the signed-in caller**: a person's sign-in name, `app:<client-id>` for a service
  with an Entra token, or `pki:<name>` for a client certificate (the name from the allowlist).
  Any `userId` or `requestedBy` in the request body is ignored when sign-in is on.
- Each operation's required role is listed in Swagger UI under **Required role**.
- To use different role names, set `vmintent.security.entra.role-map` in `application.yml`. Keep the
  brackets so the dots stay part of the name: `role-map: { "[Contoso.VM.Admins]": ADMIN, "[Contoso.VM.Readers]": READER }`.
  A custom map replaces the default names; list every role you use.

**What the API checks on every Entra token:**
- the signature, against Entra's published signing keys;
- the expiry, allowing the standard 60 seconds of clock difference;
- the issuer, which must be your tenant (both the v2.0 and v1.0 token formats are accepted);
- the audience, which must be this API.

A caller who isn't signed in (no token or certificate, or a refused one) gets **401**; a signed-in caller
without the needed role gets **403**. Both have the usual `{"error": "..."}` body, which says why.

## Set up Entra ID (one time, about 15 minutes)

Use the Entra admin center (entra.microsoft.com), with rights to create app registrations.

**1. Register the API**
1. **App registrations → New registration.** Name it `vm-intent-api`. Use single tenant and no redirect URI.
2. **Expose an API → Application ID URI → Add**, and set it to `api://vm-intent` (or keep the default `api://<client-id>`).
3. **Expose an API → Add a scope**, twice: `VmIntent.Request` and `VmIntent.Read`, consented by admins and users.
   These are for people signing in through an app.
4. **App roles → Create app role**, four times:

   | Display name | Value | Allowed member types |
   |---|---|---|
   | VM Intent admin | `VmIntent.Admin` | Users/Groups + Applications |
   | VM Intent batch | `VmIntent.Batch` | Applications (and Users/Groups if people run batches) |
   | VM Intent requester | `VmIntent.Request` | Users/Groups |
   | VM Intent reader | `VmIntent.Read` | Users/Groups + Applications |

5. Optional: in **Manifest**, set `"requestedAccessTokenVersion": 2`. Both versions work.

**2. Give people roles.** Go to **Enterprise applications → vm-intent-api → Users and groups → Add
user/group**, and pick a user or group and a role. Assigning roles to groups is easiest to manage.

**3. Give a service a role** (another app calling the API as itself):
1. Register the service (or use its existing registration), then **Certificates & secrets → New client
   secret**. A certificate is better for production.
2. Go to **API permissions → Add a permission → My APIs → vm-intent-api → Application permissions**, tick
   `VmIntent.Batch` (and/or `VmIntent.Read`), then **Grant admin consent**.
3. The service gets a token with the client-credentials flow:

   ```bash
   curl -s -X POST https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token \
     -d grant_type=client_credentials -d client_id=$SERVICE_CLIENT_ID -d client_secret=$SERVICE_SECRET \
     -d scope=api://vm-intent/.default | jq -r .access_token
   ```
   Then it calls the API with `Authorization: Bearer <token>`. Tokens last about an hour; get a new one
   before it expires. Entra's libraries (MSAL) cache and refresh tokens for you.

**4. Optional: Swagger UI's Authorize button.** Register a single-page app (or add the platform to an
existing registration):
1. **Authentication → Add a platform → Single-page application**, with redirect URI
   `https://<your-host>/swagger-ui/oauth2-redirect.html`.
2. Under **API permissions**, add the delegated `VmIntent.Request` and `VmIntent.Read` scopes.
3. Set `VMINTENT_SWAGGER_CLIENT_ID` to its client ID. **Authorize** in Swagger UI then signs you in with Entra.

**5. Turn it on.** For example in `deploy/.env`:
```
VMINTENT_SECURITY_MODE=entra
VMINTENT_ENTRA_TENANT_ID=<tenant id>
VMINTENT_ENTRA_AUDIENCES=api://vm-intent,<vm-intent-api client id>
```
Then restart the API: `docker compose up -d api`. The API logs `API sign-in: Entra ID tenant ...` when it's on.

## Client certificates (PKI)

With `pki` on, the API serves **HTTPS** and asks each caller for a client certificate (mutual TLS). A call is
accepted only if the certificate:

1. was issued by one of **your trusted CAs** (`ca-bundle.pem`), directly or through an issuing CA;
2. is within its validity dates;
3. is **not revoked**, if you supply CRLs (`crl.pem`);
4. is **on the allowlist** (`pki-clients.yml`), which also gives it its role.

The first three make sure the certificate is genuine. The allowlist makes sure it is one of *the specific
certificates* you chose: a certificate from a trusted CA that isn't listed is refused.

### The allowlist

```yaml
clients:
  - name: ci-pipeline            # audit trail: "pki:ci-pipeline"
    role: BATCH                  # ADMIN, BATCH, REQUESTER or READER
    subject: "CN=ci-pipeline,OU=Build Services,O=Example Corp,C=US"
    issuer: "CN=Example Issuing CA 1,O=Example Corp,C=US"   # recommended with subject
  - name: reporting
    role: READER
    sha256: "3A:4F:...:9C"       # this one certificate only
```

- **subject** (with **issuer**) matches the certificate's names, so it keeps working when the certificate is
  renewed under the same name. Always add `issuer` when you trust several CAs, so no other CA can issue a
  certificate with the same name.
- **sha256** pins one exact certificate. A renewed certificate needs a new entry.
- Names are compared as X.500 names: case and spacing don't matter, and either order works, so you can paste
  what `openssl x509 -in client.crt -noout -subject -issuer -nameopt RFC2253` prints. For the fingerprint:
  `openssl x509 -in client.crt -noout -fingerprint -sha256`.
- Two entries may share a name, for example the old and the new certificate while a service changes over.
- **No restart needed.** The API re-reads the file within a few seconds of a change. If an edited file has a
  mistake, the API logs an error and keeps using the previous list.
- A valid certificate that isn't listed gets a 401 that shows its subject, issuer and fingerprint, and the
  same goes into the API log, so adding it is copy and paste.

Template: `deploy/pki/pki-clients.example.yml`.

### Settings

| Setting (environment variable) | Value |
|---|---|
| `VMINTENT_SECURITY_MODE` | `pki`, or `entra,pki` for both |
| `SPRING_PROFILES_ACTIVE` | Add `tls`, e.g. `api,tls`. The API then serves HTTPS on port **8443**. With Docker: `VMINTENT_API_PROFILES=api,tls` |
| `VMINTENT_TLS_CERT` | The API's own TLS certificate, plus any intermediate CAs (PEM) |
| `VMINTENT_TLS_KEY` | Its private key (PEM, unencrypted: protect it with file permissions) |
| `VMINTENT_PKI_CA_FILE` | The CAs that issue client certificates (PEM; several in one file is fine) |
| `VMINTENT_PKI_CLIENTS_FILE` | The allowlist |
| `VMINTENT_PKI_CRL_FILE` | Optional: CRLs (PEM or DER) |

The API asks for a certificate but doesn't insist during the TLS handshake. That keeps the docs open, and
lets Entra callers in when both methods are on. The rules then refuse any `/api` call without a valid one.
A certificate from an unknown CA, or an expired one, may be refused during the handshake itself, before any
error body can be sent.

### Revocation (CRLs)

Set `VMINTENT_PKI_CRL_FILE` to a file holding the current CRL from **each CA that issues client
certificates**, and refresh it on a schedule (a cron job or systemd timer that downloads the CRLs from your
PKI's distribution points). The API re-reads the file when it changes. With a CRL file set:

- a revoked certificate is refused ("has been revoked");
- a certificate whose issuer has **no current CRL** in the file is refused too ("revocation status can't be
  checked"), so an out-of-date CRL file fails closed. Watch the API log for this.

The API never fetches CRLs or asks OCSP responders itself.

### Behind a TLS proxy (optional)

If a load balancer or nginx handles TLS in front of the API, it can check the client certificate and forward
it in a header:

| Setting | Value |
|---|---|
| `VMINTENT_PKI_HEADER` | The header name, e.g. `X-Client-Cert` |
| `VMINTENT_PKI_TRUSTED_PROXIES` | The proxy's address or range, e.g. `10.40.1.10` or `10.40.1.0/28`, comma-separated |

The header is only accepted on connections that come **straight from a trusted proxy**. It is ignored from
anywhere else, even if the request claims to come from the proxy in `X-Forwarded-For`. The API still checks
the forwarded certificate itself: trusted CA, dates, CRL and allowlist. The header can hold URL-encoded PEM
(nginx's `$ssl_client_escaped_cert`), PEM on one line, or base64 DER. Make sure the proxy **removes** any copy
of the header sent by the caller, as the nginx example below does by always setting it.

```nginx
server {
    listen 443 ssl;
    ssl_certificate         /etc/nginx/pki/server.crt;
    ssl_certificate_key     /etc/nginx/pki/server.key;
    ssl_client_certificate  /etc/nginx/pki/ca-bundle.pem;
    ssl_verify_client       optional;    # the API decides; docs stay open
    ssl_verify_depth        3;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Client-Cert $ssl_client_escaped_cert;   # replaces any copy the caller sent
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

With the API on the same machine, set `VMINTENT_PKI_TRUSTED_PROXIES=127.0.0.1` and run the API **without** the
`tls` profile, listening only where the proxy can reach it.

### Turn it on (Docker)

1. Put `server.crt`, `server.key`, `ca-bundle.pem`, `pki-clients.yml` (and optionally `crl.pem`) in
   `deploy/pki/`. The folder is mounted read-only into the API container and is git-ignored.
2. In `deploy/.env`:
   ```
   VMINTENT_SECURITY_MODE=pki
   VMINTENT_API_PROFILES=api,tls
   VMINTENT_WEB_API_UPSTREAM=https://api:8443
   #VMINTENT_PKI_CRL_FILE=/etc/vm-intent/pki/crl.pem
   ```
3. `docker compose up -d api web`. The log shows `API sign-in: client certificates (allowlist ...)` and
   `Tomcat started on port 8443 (https)`.
4. Test as a service would:
   ```bash
   curl --cacert ca-bundle.pem --cert client.crt --key client.key https://<host>:8443/api/v2/stats
   ```

On Linux without Docker, the same settings go in `deploy/linux/vm-intent.env` (examples are in the file), with
`API_PROFILES=api,tls`.

### Calling the API with a certificate

Most HTTP clients take a certificate and key: `curl --cert/--key`, Python `requests` (`cert=(crt, key)`), Java
(a `KeyStore` in an `SSLContext`), .NET (`HttpClientHandler.ClientCertificates`). Give them the API's CA too
(`--cacert`, `verify=`), unless it's already trusted on that machine.

## Other clients

- **MCP server (Claude):** set `VMINTENT_API_TOKEN` in its environment to an Entra token with the role it
  needs. It doesn't send client certificates yet.
- **Contract test:** `VMINTENT_TOKEN=<admin token> python tests/api_contract_test.py`, or with a certificate
  listed as ADMIN: `VMINTENT_CLIENT_CERT=admin.crt VMINTENT_CLIENT_KEY=admin.key VMINTENT_CA=ca-bundle.pem
  python tests/api_contract_test.py https://<host>:8443`.
- **Web app:** with sign-in on, the web app's calls are refused (401) until it gains an Entra sign-in
  (MSAL.js). That isn't built yet; for now, use it only with sign-in off on a private network.

## Testing without a tenant or a PKI

**Entra ID.** `tests/security_test.py` runs a stand-in for Entra ID on your machine: it publishes signing keys
and issues tokens shaped like Entra's. It then runs 28 checks:
- bad tokens are refused: wrong key, expired, wrong audience, wrong tenant, not a token;
- both token versions are accepted;
- every role gets exactly its permissions;
- one user can't confirm another's request;
- the audit trail names the real caller;
- the document describes sign-in.

**Client certificates.** `tests/pki_test.py --make-certs tests/.pki` makes a throwaway PKI: a root CA, an
issuing CA, a server certificate, client certificates for each role, revoked, expired and untrusted ones,
a CRL and an allowlist. Then `python tests/pki_test.py https://localhost:8443 tests/.pki` runs 22 checks (27
with `--header X-Client-Cert`):
- the docs open without a certificate;
- no certificate, an unlisted, revoked or expired one, and a look-alike from an untrusted CA are all refused;
- every role gets exactly its permissions, listed by subject, by subject and issuer, or by fingerprint;
- names written in the other order (as openssl prints them) still match;
- one user can't confirm another's request, and the audit trail names the certificate;
- the allowlist is re-read without a restart;
- certificates forwarded by a trusted proxy are checked the same way.

`--untrusted-proxy` checks that the header is ignored from anywhere else, even with a forged `X-Forwarded-For`.

Each file's header has the exact commands. Never point a real deployment at either stand-in.

## Adding another sign-in method later

The roles and per-operation rules live in one place (`security/ApiAccessRules.java`), separate from how
callers prove who they are. Entra ID (`SecurityConfig`) and client certificates (`PkiAuthenticationFilter`) are
two methods that both end in the same four roles. Another one, such as an attribute service that looks up a
certificate holder's entitlements, would sit next to them: for example, it could replace the allowlist
lookup. Nothing else changes.
