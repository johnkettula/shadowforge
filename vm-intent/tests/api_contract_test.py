"""
API contract test: calls every endpoint of a running backend and checks that each real
request and response matches the OpenAPI document the server publishes (/v3/api-docs).
If the code and the document ever drift apart, this fails.

    pip install openapi-core requests
    python tests/api_contract_test.py                      # http://localhost:8080
    python tests/api_contract_test.py http://server:8080
    VMINTENT_TOKEN=<Entra access token with VmIntent.Admin> python tests/api_contract_test.py   # Entra sign-in on
    # Client-certificate sign-in on (a certificate listed with role ADMIN; VMINTENT_CA = the server's CA):
    VMINTENT_CLIENT_CERT=admin.crt VMINTENT_CLIENT_KEY=admin.key VMINTENT_CA=ca-bundle.pem \
        python tests/api_contract_test.py https://server:8443

Uses the simulated clouds; builds a handful of VMs (they boot in 20-60 s by default).
"""
import json
import sys
import time
import uuid

import os

import requests
from openapi_core import OpenAPI
from openapi_core.contrib.requests import RequestsOpenAPIRequest, RequestsOpenAPIResponse

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
RUN = uuid.uuid4().hex[:6]


class _Session(requests.Session):
    """Sends the client certificate, and checks the server against VMINTENT_CA, on every call."""

    def request(self, *args, **kwargs):
        if os.environ.get("VMINTENT_CLIENT_CERT"):
            kwargs.setdefault("cert", (os.environ["VMINTENT_CLIENT_CERT"], os.environ.get("VMINTENT_CLIENT_KEY")))
        if os.environ.get("VMINTENT_CA"):
            kwargs.setdefault("verify", os.environ["VMINTENT_CA"])   # a session-level verify loses to REQUESTS_CA_BUNDLE
        return super().request(*args, **kwargs)


HTTP = _Session()
TOKEN = os.environ.get("VMINTENT_TOKEN")
AUTH = {"Authorization": "Bearer " + TOKEN} if TOKEN else {}

doc = HTTP.get(BASE + "/v3/api-docs", timeout=10).json()
doc["servers"] = [{"url": BASE}]          # validate against the address we're actually calling
api = OpenAPI.from_dict(doc)

results = []


def call(method, path, expect, body=None, raw=None, name=None, check=None):
    """Make the call, check the status code, and validate request + response against the document.
    check(body) may return a problem with the response's content, or None."""
    headers = dict(AUTH)
    if body is not None or raw is not None:
        headers["Content-Type"] = "application/json"
    data = raw if raw is not None else (json.dumps(body) if body is not None else None)
    resp = HTTP.request(method, BASE + path, data=data, headers=headers, timeout=30)
    label = name or f"{method} {path}"
    problems = []
    if resp.status_code != expect:
        problems.append(f"status {resp.status_code}, expected {expect}: {resp.text[:200]}")
    try:
        api.validate_response(RequestsOpenAPIRequest(resp.request), RequestsOpenAPIResponse(resp))
    except Exception as e:  # noqa: BLE001 - report any validation error
        problems.append(f"response does not match the OpenAPI document: {e}")
    try:
        data = resp.json() if resp.content else None
    except ValueError:
        data = resp.text
    if check and not problems:
        problem = check(data)
        if problem:
            problems.append(problem)
    results.append((label, problems))
    print(("PASS " if not problems else "FAIL ") + label + ("" if not problems else "\n     " + "\n     ".join(problems)))
    return data


def wait_request(rid, states, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        s = HTTP.get(f"{BASE}/api/v2/requests/{rid}", headers=AUTH, timeout=10).json()
        if s["state"] in states:
            return s
        time.sleep(2)
    raise SystemExit(f"request {rid} never reached {states}")


def spec(name, provider="aws", region="us-east"):
    return {"name": name, "provider": provider, "region": region, "vcpu": 2, "memoryGiB": 4, "os": "ubuntu",
            "osVersion": "24.04", "diskGiB": 80, "diskTier": "ssd", "env": "test", "ttlDays": 1, "publicIp": False}


# --- Requests: preview
call("POST", "/api/v2/interpret", 200, {"text": "Ubuntu box, 4 cores, 16 gigs, us-east on AWS"},
     name="interpret: complete request")
call("POST", "/api/v2/interpret", 200, {"text": "I need a big linux machine"}, name="interpret: needs a question")

# --- Requests: full flow with a question, an answer and a cancel
r = call("POST", "/api/v2/requests", 200, {"text": "I need a big linux machine", "userId": "contract-test"},
         name="createRequest (will ask a question)")
s = wait_request(r["requestId"], {"AWAITING_CLARIFICATION"})
call("GET", f"/api/v2/requests/{r['requestId']}", 200, name="getRequest: awaiting clarification")
call("POST", f"/api/v2/requests/{r['requestId']}/clarify", 204, {"answer": "azure"}, name="clarifyRequest")
wait_request(r["requestId"], {"AWAITING_CONFIRMATION"})
call("POST", f"/api/v2/requests/{r['requestId']}/cancel", 204, name="cancelRequest")
wait_request(r["requestId"], {"CANCELLED"})
call("POST", f"/api/v2/requests/{r['requestId']}/cancel", 409, name="cancelRequest: already finished -> 409")
call("POST", f"/api/v2/requests/{r['requestId']}/clarify", 409, {"answer": "azure"},
     name="clarifyRequest: already finished -> 409")

# --- Requests: full flow to a running VM
r = call("POST", "/api/v2/requests", 200,
         {"text": f"small debian 12 box on gcp us-central called ct-{RUN}", "userId": "contract-test"},
         name="createRequest (to build)")
wait_request(r["requestId"], {"AWAITING_CONFIRMATION"})
pending = call("GET", f"/api/v2/requests/{r['requestId']}", 200, name="getRequest: awaiting confirmation")
call("POST", f"/api/v2/requests/{r['requestId']}/confirm", 409, {"specHash": "0" * 64},
     name="confirmRequest: a different spec -> 409")
call("POST", f"/api/v2/requests/{r['requestId']}/confirm", 200,
     {"specHash": pending["interpretation"]["specHash"]}, name="confirmRequest")
done = wait_request(r["requestId"], {"COMPLETED", "FAILED", "DUPLICATE"})
call("GET", f"/api/v2/requests/{r['requestId']}", 200, name=f"getRequest: final ({done['state']})")
call("POST", f"/api/v2/requests/{r['requestId']}/confirm", 409, name="confirmRequest: already finished -> 409")
call("GET", "/api/v2/requests?limit=5", 200, name="listRequests")

# --- VM lifecycle (day 2), on the VM just built
if done["state"] == "COMPLETED":
    h = done["interpretation"]["specHash"]
    time.sleep(1)
    call("GET", f"/api/v2/vms/{h}", 200, name="getVm",
         check=lambda v: None if v["specHash"] == h and v["spec"]["name"] == done["interpretation"]["spec"]["name"]
         else f"getVm returned {v['specHash']} / {v['spec']['name']}")
    call("GET", f"/api/v2/vms/{h}/lifecycle", 200, name="getVmLifecycle")
    call("POST", f"/api/v2/vms/{h}/renew", 200, {"days": 7}, name="renewVm")
    call("POST", f"/api/v2/vms/{h}/renew", 409, {"days": 0}, name="renewVm: 0 days -> 409")
    call("POST", f"/api/v2/vms/{h}/resize", 200, {"vcpu": 4, "memoryGiB": 16}, name="resizeVm")
    call("POST", f"/api/v2/vms/{h}/power", 200, {"on": False}, name="powerVm")
    call("POST", f"/api/v2/vms/{h}/snapshot", 200, {"label": "contract-test"}, name="snapshotVm")
    call("POST", f"/api/v2/vms/{h}/decommission", 200, {"reason": "contract test"}, name="decommissionVm")
    call("POST", f"/api/v2/vms/{h}/decommission", 409, name="decommissionVm: already decommissioned -> 409")
    call("GET", f"/api/v2/vms/{h}", 200, name="getVm: after decommission")
call("GET", "/api/v2/vms/abc", 400, name="getVm: malformed hash -> 400")
call("GET", "/api/v2/vms/" + "0" * 64, 404, name="getVm: unknown VM -> 404")
call("GET", "/api/v2/vms/" + "0" * 64 + "/lifecycle", 404, name="getVmLifecycle: unknown VM -> 404")
call("POST", "/api/v2/vms/" + "0" * 64 + "/renew", 404, {"days": 7}, name="renewVm: unknown VM -> 404")

# --- Requests: errors
call("GET", "/api/v2/requests/intent-does-not-exist", 404, name="getRequest: unknown ID -> 404")
call("POST", "/api/v2/requests/intent-does-not-exist/confirm", 404, name="confirmRequest: unknown ID -> 404")
call("POST", "/api/v2/requests/intent-does-not-exist/cancel", 404, name="cancelRequest: unknown ID -> 404")
call("POST", "/api/v2/requests", 400, raw="{not json", name="createRequest: bad JSON -> 400")

# --- Batches
b = call("POST", "/api/v2/batches", 202, {
    "items": [{"spec": spec(f"ct-{RUN}-a")}, {"spec": spec(f"ct-{RUN}-b", "vsphere", "dc1")},
              {"text": "I need a big linux machine"}],
    "shardSize": 2, "requestedBy": "contract-test"}, name="createBatch (1 item rejected)")
assert b["accepted"] == 2 and len(b["rejected"]) == 1, b
end = time.time() + 180
while time.time() < end:
    st = HTTP.get(f"{BASE}/api/v2/batches/{b['batchId']}", headers=AUTH, timeout=10).json()
    if st["state"] == "COMPLETED":
        break
    time.sleep(3)
call("GET", f"/api/v2/batches/{b['batchId']}", 200, name="getBatch: completed")
call("POST", "/api/v2/batches", 400, {"items": []}, name="createBatch: empty -> 400")
call("GET", "/api/v2/batches/batch-does-not-exist", 404, name="getBatch: unknown ID -> 404")

# --- Inventory
call("GET", "/api/v2/vms", 200, name="listVms")
call("GET", "/api/v2/stats", 200, name="getStats")
call("GET", f"/api/v2/audit?requestId={b['batchId']}&limit=20", 200, name="getAuditTrail")
chk = call("POST", "/api/v2/inventory-checks", 202, name="runInventoryCheck")
time.sleep(5)
call("GET", "/api/v2/inventory-checks?limit=1", 200, name="listInventoryChecks")

# --- Legacy
legacy = {"name": f"legacy-{RUN}", "cloud": "GCP", "location": "us-central1", "cpu": 2, "ramGb": 8,
          "image": {"os": "Debian", "version": "12"}, "disk": {"sizeGb": 80, "type": "SSD"}, "environment": "test"}
call("POST", "/api/v1/vms", 202, legacy, name="createLegacyVm")
call("POST", "/api/v1/vms", 409, legacy, name="createLegacyVm: same again -> 409")

# --- vSphere (this server isn't set up for vCenter or VCF Automation, so the lookups are 503)
call("GET", "/api/v2/vsphere/status", 200, name="getVsphereStatus")
call("GET", "/api/v2/vsphere/templates", 503, name="listVsphereTemplates: vCenter not set up -> 503")
call("GET", "/api/v2/vsphere/blueprints", 503, name="listVsphereBlueprints: VCF Automation not set up -> 503")
call("GET", "/api/v2/vsphere/blueprints/anything", 503, name="getVsphereBlueprint: VCF Automation not set up -> 503")

# --- Catalog (reads the built-in definitions seeded from backend/src/main/resources/catalog; publishes nothing)
call("GET", "/api/v2/definitions", 200, name="listDefinitions",
     check=lambda d: None if any(e["kind"] == "Provisioning" and e["name"] == "web-server" for e in d)
     else "the list has no Provisioning web-server")
web = call("GET", "/api/v2/definitions/Provisioning/web-server", 200, name="getDefinition: web-server")
call("GET", "/api/v2/definitions/Provisioning/does-not-exist", 404, name="getDefinition: unknown -> 404",
     check=lambda d: None if isinstance(d.get("error"), str) else "no {'error': ...} body")
call("POST", "/api/v2/definitions/validate", 200, {"yaml": (web or {}).get("yaml", "")},
     name="validateDefinition (JSON): web-server",
     check=lambda d: None if d["ok"] is True else f"ok is not true: {d.get('problems')}")
call("GET", "/api/v2/classifications", 200, name="listClassifications",
     check=lambda d: None if d["default"] in [c["code"] for c in d["classifications"]]
     else f"default {d['default']} isn't one of the listed codes")

# --- Catalog runs (no run is started: only the error cases)
call("GET", "/api/v2/runs?limit=5", 200, name="listRuns")
call("GET", "/api/v2/runs/run-does-not-exist", 404, name="getRun: unknown ID -> 404")
call("POST", "/api/v2/runs", 404, {"definition": "does-not-exist"}, name="startRun: unknown definition -> 404")
call("POST", "/api/v2/runs", 400, {}, name="startRun: no definition -> 400")

# --- Compliance
call("GET", "/api/v2/compliance/decisions?limit=5", 200, name="listDecisions")
call("GET", "/api/v2/compliance/archive?limit=5", 200, name="listArchive")
call("GET", "/api/v2/compliance/archive/wf-does-not-exist/run-does-not-exist", 404,
     name="downloadArchivedHistory: not archived -> 404")
call("POST", "/api/v2/compliance/replays", 400, {}, name="replayWorkflow: no workflowId -> 400")

failed = [n for n, p in results if p]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
covered = {(m.upper(), p) for p, ops in doc["paths"].items() for m in ops}
print(f"{len(covered)} operations in the document")
sys.exit(1 if failed else 0)
