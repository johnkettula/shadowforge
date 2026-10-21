# Sign-in and permissions (Microsoft Entra ID)

vm-intent's REST API can require a **Microsoft Entra ID access token** on every call. People and services
sign in with Entra, and Entra **app roles** decide what each caller may do.

| Setting (environment variable) | Value |
|---|---|
| `VMINTENT_SECURITY_MODE` | `none` (default: no sign-in; keep the API on a private network) or `entra` |
| `VMINTENT_ENTRA_TENANT_ID` | Your Entra tenant (directory) ID |
| `VMINTENT_ENTRA_AUDIENCES` | The API's Application ID URI and/or client ID, comma-separated, e.g. `api://vm-intent,<client-id>` |
| `VMINTENT_SWAGGER_CLIENT_ID` | Optional: client ID of a SPA registration, for Swagger UI's **Authorize** button |

The API docs (`/swagger-ui.html`, `/v3/api-docs`) stay open, so callers can find out how to sign in.

## Roles

Each role includes the ones below it.

| vm-intent role | Entra app role (value) | Can |
|---|---|---|
| `ADMIN` | `VmIntent.Admin` | Everything, including changing anyone's request |
| `BATCH` | `VmIntent.Batch` | `POST /api/v2/batches`, `POST /api/v1/vms` (legacy), plus everything READER can |
| `REQUESTER` | `VmIntent.Request` | Interpret, create, answer, confirm and cancel **their own** requests, plus READER |
| `READER` | `VmIntent.Read` | All `GET`s: inventory, stats, audit, request and batch status |

- Roles come from the token's `roles` claim (app roles) and `scp` claim (delegated scopes with the same names).
- **Only the requester** (or an ADMIN) can answer, confirm or cancel a request. Anyone else gets 403.
- **The audit trail records the signed-in caller**: a person's sign-in name, or `app:<client-id>` for a service.
  Any `userId` or `requestedBy` in the request body is ignored when sign-in is on.
- Each operation's required role is listed in Swagger UI under **Required role**.
- To use different role names, set `vmintent.security.entra.role-map` in `application.yml`. Keep the
  brackets so the dots stay part of the name: `role-map: { "[Contoso.VM.Admins]": ADMIN, "[Contoso.VM.Readers]": READER }`.
  A custom map replaces the default names; list every role you use.

**What the API checks on every token:**
- the signature, against Entra's published signing keys;
- the expiry, allowing the standard 60 seconds of clock difference;
- the issuer, which must be your tenant (both the v2.0 and v1.0 token formats are accepted);
- the audience, which must be this API.

A missing or bad token gets **401**; a valid token without the needed role gets **403**. Both have the
usual `{"error": "..."}` body.

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

## Other clients

- **MCP server (Claude):** set `VMINTENT_API_TOKEN` in its environment to a token with the role it needs.
- **Contract test:** `VMINTENT_TOKEN=<admin token> python tests/api_contract_test.py`.
- **Web app:** with sign-in on, the web app's calls are refused (401) until it gains an Entra sign-in
  (MSAL.js). That isn't built yet; for now, use it only with sign-in off on a private network.

## Testing without a tenant

`tests/security_test.py` runs a stand-in for Entra ID on your machine: it publishes signing keys and
issues tokens shaped like Entra's. It then runs 28 checks:
- bad tokens are refused: wrong key, expired, wrong audience, wrong tenant, not a token;
- both token versions are accepted;
- every role gets exactly its permissions;
- one user can't confirm another's request;
- the audit trail names the real caller;
- the document describes sign-in.

The file's header has the three commands to run it. Never point a real deployment at the stand-in.

## Adding another sign-in method later

The roles and per-operation rules live in one place (`security/ApiAccessRules.java`), separate from how
callers prove who they are. Another method, such as PKI client certificates with an attribute service,
can be added to `SecurityConfig` and map its attributes to the same four roles. Nothing else changes.
