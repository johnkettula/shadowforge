"""
API contract test: calls every endpoint of a running backend and checks that each real
request and response matches the OpenAPI document the server publishes (/v3/api-docs).
If the code and the document ever drift apart, this fails.

    pip install openapi-core requests
    python tests/api_contract_test.py                      # http://localhost:8080
    python tests/api_contract_test.py http://server:8080

Uses the simulated clouds; builds a handful of VMs (they boot in 20-60 s by default).
"""
import json
import sys
import time
import uuid

import requests
from openapi_core import OpenAPI
from openapi_core.contrib.requests import RequestsOpenAPIRequest, RequestsOpenAPIResponse

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
RUN = uuid.uuid4().hex[:6]

doc = requests.get(BASE + "/v3/api-docs", timeout=10).json()
doc["servers"] = [{"url": BASE}]          # validate against the address we're actually calling
api = OpenAPI.from_dict(doc)

results = []


def call(method, path, expect, body=None, raw=None, name=None):
    """Make the call, check the status code, and validate request + response against the document."""
    headers = {"Content-Type": "application/json"} if (body is not None or raw is not None) else {}
    data = raw if raw is not None else (json.dumps(body) if body is not None else None)
    resp = requests.request(method, BASE + path, data=data, headers=headers, timeout=30)
    label = name or f"{method} {path}"
    problems = []
    if resp.status_code != expect:
        problems.append(f"status {resp.status_code}, expected {expect}: {resp.text[:200]}")
    try:
        api.validate_response(RequestsOpenAPIRequest(resp.request), RequestsOpenAPIResponse(resp))
    except Exception as e:  # noqa: BLE001 - report any validation error
        problems.append(f"response does not match the OpenAPI document: {e}")
    results.append((label, problems))
    print(("PASS " if not problems else "FAIL ") + label + ("" if not problems else "\n     " + "\n     ".join(problems)))
    return resp.json() if resp.content else None


def wait_request(rid, states, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        s = requests.get(f"{BASE}/api/v2/requests/{rid}", timeout=10).json()
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

# --- Requests: full flow to a running VM
r = call("POST", "/api/v2/requests", 200,
         {"text": f"small debian 12 box on gcp us-central called ct-{RUN}", "userId": "contract-test"},
         name="createRequest (to build)")
wait_request(r["requestId"], {"AWAITING_CONFIRMATION"})
call("POST", f"/api/v2/requests/{r['requestId']}/confirm", 204, name="confirmRequest")
done = wait_request(r["requestId"], {"COMPLETED", "FAILED", "DUPLICATE"})
call("GET", f"/api/v2/requests/{r['requestId']}", 200, name=f"getRequest: final ({done['state']})")

# --- Requests: errors
call("GET", "/api/v2/requests/intent-does-not-exist", 404, name="getRequest: unknown ID -> 404")
call("POST", "/api/v2/requests/intent-does-not-exist/confirm", 404, name="confirmRequest: unknown ID -> 404")
call("POST", "/api/v2/requests", 400, raw="{not json", name="createRequest: bad JSON -> 400")

# --- Batches
b = call("POST", "/api/v2/batches", 202, {
    "items": [{"spec": spec(f"ct-{RUN}-a")}, {"spec": spec(f"ct-{RUN}-b", "vsphere", "dc1")},
              {"text": "I need a big linux machine"}],
    "shardSize": 2, "requestedBy": "contract-test"}, name="createBatch (1 item rejected)")
assert b["accepted"] == 2 and len(b["rejected"]) == 1, b
end = time.time() + 180
while time.time() < end:
    st = requests.get(f"{BASE}/api/v2/batches/{b['batchId']}", timeout=10).json()
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

# --- Legacy
legacy = {"name": f"legacy-{RUN}", "cloud": "GCP", "location": "us-central1", "cpu": 2, "ramGb": 8,
          "image": {"os": "Debian", "version": "12"}, "disk": {"sizeGb": 80, "type": "SSD"}, "environment": "test"}
call("POST", "/api/v1/vms", 202, legacy, name="createLegacyVm")
call("POST", "/api/v1/vms", 409, legacy, name="createLegacyVm: same again -> 409")

failed = [n for n, p in results if p]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
covered = {(m.upper(), p) for p, ops in doc["paths"].items() for m in ops}
print(f"{len(covered)} operations in the document")
sys.exit(1 if failed else 0)
