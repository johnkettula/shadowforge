# Requirements built by the agent pipeline

Each entry was chosen, built, tested, reviewed and merged by the agent pipeline (agent-pipeline/). Newest last.

## AP-0002: AP-0001 (retry): Bring the vSphere endpoints into line with the API contract: stable operation IDs, a typed status response, a 503 when vSphere isn't set up, documented error responses, and API.md and

The four /api/v2/vsphere endpoints are the only ones without stable operation IDs or documented errors. Their OpenAPI schema for /status is wrong: Map<String,Object> is documented as additionalProperties of type object, but `defaultRoute` is a string, so validating the live response against /v3/api-docs fails. When vCenter or VCF Automation isn't configured, the endpoints return 404 (the InvalidSpec failure type is mapped to NOT_FOUND). A 404 means 'unknown ID' under the API.md conventions; this case is really 'service unavailable'. A person asked for this item in the backlog. Cycle 1 failed only on the /status schema mismatch, and only because of a pipeline limit that has since been fixed. Keep the hand-written change small (about 300 lines). The regenerated docs/openapi.json and docs/openapi.yaml don't count toward the limit.

Acceptance criteria:
- In GET /v3/api-docs, the four vSphere operations have these operationIds: getVsphereStatus (GET /api/v2/vsphere/status), listVsphereTemplates (GET /api/v2/vsphere/templates), listVsphereBlueprints (GET /api/v2/vsphere/blueprints), getVsphereBlueprint (GET /api/v2/vsphere/blueprints/{nameOrId}).
- GET /api/v2/vsphere/status returns 200 with a body that validates against the server's own /v3/api-docs. The response is a named type (for example a VsphereStatusResponse record), not Map<String,Object>. It has `defaultRoute` (string), `datacenters` (an object mapping datacenter name to route string) and `vcenter` and `automation` objects, each with `configured` (boolean) and optional `url`, `ok` (boolean) and `detail` (string). Fields with no value are left out, never sent as null. On a server without vSphere set up, the body looks like {"defaultRoute":"simulated","datacenters":{...},"vcenter":{"configured":false},"automation":{"configured":false}}.
- On a server where vCenter isn't configured, GET /api/v2/vsphere/templates returns 503 with the standard error body {"error": "..."}. The message says vCenter isn't set up. The status code was 404 before this change.
- On a server where VCF Automation isn't configured, GET /api/v2/vsphere/blueprints and GET /api/v2/vsphere/blueprints/anything return 503 with {"error": "..."}. The message says VCF Automation isn't set up.
- When VCF Automation is configured, an unknown blueprint name still returns 404, and a CloudAuth failure still returns 502. A unit test covers how each failure type maps to a status: 'not set up' gives 503, NotFound gives 404, CloudAuth gives 502, anything else gives 503.
- In /v3/api-docs, each vSphere operation documents its error responses with the ApiError schema: 503 on all four that can be unavailable (templates, blueprints, blueprint), 404 on getVsphereBlueprint, and 502 where a CloudAuth failure can happen. The style matches VmController and CatalogController (@ApiResponse with content = @Schema(implementation = ApiError.class)).
- The Operations table in docs/API.md lists the four vSphere operations with their operation ID, method and path, and a short description that notes the OPERATOR role and the 503 when vSphere isn't set up. The Conventions errors bullet mentions 503. Any operation count in API.md (for example 'all 38 operations') is updated to the new total.
- tests/api_contract_test.py calls getVsphereStatus (expects 200), listVsphereTemplates and listVsphereBlueprints (expect 503 on staging, where vSphere isn't configured), and getVsphereBlueprint (expects 503). Every response validates against the live OpenAPI document, and all of the contract test's existing checks still pass.
- docs/openapi.json and docs/openapi.yaml are regenerated so they match the live document. mvn test passes, including any test that compares the snapshots with the live spec.

Risk: low. Attempts: 1. Built: 2026-10-30.

02:03:11 attempt 1: developer: The four /api/v2/vsphere endpoints now follow the API contract. The full backend suite passes (`mvn -q test`, exit 0), and the new VsphereControllerTest passes 5/5, also re-run after the last edit. Tw
02:12:39 attempt 1: review: approved: I'm approving this change. It meets all nine acceptance criteria and every check passed.
