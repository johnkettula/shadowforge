"""
Sign-in and permission test for vmintent.security.mode=entra, with no real Entra tenant needed.

It runs a stand-in for Entra ID: it publishes signing keys the way Entra does and signs tokens
shaped like Entra's (iss, aud, roles, scp, preferred_username, azp). Then it checks who may do
what against a running backend.

    pip install pyjwt cryptography requests
    python tests/security_test.py --serve-keys        # 1. start the stand-in (port 9999), leave running
    # 2. start the API with:
    #      VMINTENT_SECURITY_MODE=entra
    #      VMINTENT_ENTRA_TENANT_ID=test-tenant
    #      VMINTENT_ENTRA_AUDIENCES=api://vm-intent,11111111-2222-3333-4444-555555555555
    #      VMINTENT_ENTRA_JWKS_URI=http://127.0.0.1:9999/keys
    python tests/security_test.py http://localhost:8080   # 3. run the checks

Never point a real deployment at the stand-in: anyone with its key can mint tokens.
"""
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import jwt
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

TENANT = "test-tenant"
API_URI = "api://vm-intent"
API_CLIENT_ID = "11111111-2222-3333-4444-555555555555"
KEY_FILE = os.path.join(os.path.dirname(__file__), ".security-test-key.pem")   # git-ignored
KID = "test-key-1"


def load_key():
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "rb") as f:
            return serialization.load_pem_private_key(f.read(), None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with open(KEY_FILE, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    return key


def serve_keys(port=9999):
    key = load_key()
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": KID, "use": "sig", "alg": "RS256"})
    body = json.dumps({"keys": [jwk]}).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    print(f"Stand-in Entra keys at http://127.0.0.1:{port}/keys")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


KEY = None


def token(roles=None, scp=None, user=None, app=None, aud=API_URI, iss=None, expired=False, key=None):
    now = int(time.time())
    claims = {"iss": iss or f"https://login.microsoftonline.com/{TENANT}/v2.0", "aud": aud,
              "iat": now - 900 if expired else now - 60, "nbf": now - 900 if expired else now - 60, "exp": now - 600 if expired else now + 3600,
              "sub": str(uuid.uuid4()), "tid": TENANT}
    if roles:
        claims["roles"] = roles
    if scp:
        claims["scp"] = scp
    if user:
        claims["preferred_username"] = user
    if app:
        claims["azp"] = app
    return jwt.encode(claims, key or KEY, algorithm="RS256", headers={"kid": KID})


def main(base):
    global KEY
    KEY = load_key()
    results = []

    def check(label, method, path, tok, expect, body=None):
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if tok:
            headers["Authorization"] = "Bearer " + tok
        r = requests.request(method, base + path, headers=headers, timeout=30,
                             data=json.dumps(body) if body is not None else None)
        ok = r.status_code == expect
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + f"{label}: {method} {path} -> {r.status_code}"
              + ("" if ok else f" (expected {expect}) {r.text[:200]}"))
        return r.json() if r.content and r.headers.get("Content-Type", "").startswith("application/json") else None

    alice = token(roles=["VmIntent.Request"], user="alice@example.com")
    bob = token(roles=["VmIntent.Request"], user="bob@example.com")
    reader = token(roles=["VmIntent.Read"], user="rita@example.com")
    admin = token(roles=["VmIntent.Admin"], user="ada@example.com")
    service = token(roles=["VmIntent.Batch"], app="22222222-aaaa-bbbb-cccc-333333333333")
    delegated = token(scp="VmIntent.Request openid", user="dee@example.com")
    nobody = token(roles=["Something.Else"], user="nobody@example.com")

    print("-- the docs stay open")
    check("API docs without a token", "GET", "/v3/api-docs", None, 200)
    check("Swagger UI without a token", "GET", "/swagger-ui/index.html", None, 200)

    print("-- bad or missing tokens")
    check("no token", "GET", "/api/v2/vms", None, 401)
    check("no token", "POST", "/api/v2/batches", None, 401, {"items": []})
    check("signed with someone else's key", "GET", "/api/v2/vms",
          token(roles=["VmIntent.Admin"], key=rsa.generate_private_key(public_exponent=65537, key_size=2048)), 401)
    check("expired", "GET", "/api/v2/vms", token(roles=["VmIntent.Admin"], expired=True), 401)
    check("wrong audience", "GET", "/api/v2/vms", token(roles=["VmIntent.Admin"], aud="api://other-app"), 401)
    check("wrong tenant", "GET", "/api/v2/vms",
          token(roles=["VmIntent.Admin"], iss="https://login.microsoftonline.com/evil/v2.0"), 401)
    check("not a token", "GET", "/api/v2/vms", "abc.def.ghi", 401)

    print("-- token formats Entra issues")
    check("v1.0 issuer (sts.windows.net)", "GET", "/api/v2/vms",
          token(roles=["VmIntent.Read"], iss=f"https://sts.windows.net/{TENANT}/"), 200)
    check("audience = client ID", "GET", "/api/v2/vms", token(roles=["VmIntent.Read"], aud=API_CLIENT_ID), 200)
    check("delegated scope (scp)", "POST", "/api/v2/interpret", delegated, 200, {"text": "small ubuntu box on aws"})

    print("-- READER")
    check("reader lists VMs", "GET", "/api/v2/vms", reader, 200)
    check("reader reads stats", "GET", "/api/v2/stats", reader, 200)
    check("reader can't interpret", "POST", "/api/v2/interpret", reader, 403, {"text": "x"})
    check("reader can't start a batch", "POST", "/api/v2/batches", reader, 403, {"items": []})
    check("unknown role can't even read", "GET", "/api/v2/vms", nobody, 403)

    print("-- REQUESTER, and only the owner changes a request")
    r = check("alice starts a request (claims to be mallory)", "POST", "/api/v2/requests", alice, 200,
              {"text": f"small debian 12 box on gcp us-central called sec-{uuid.uuid4().hex[:6]}",
               "userId": "mallory"})
    rid = r["requestId"]
    for _ in range(60):
        s = requests.get(f"{base}/api/v2/requests/{rid}", headers={"Authorization": "Bearer " + alice}).json()
        if s["state"] == "AWAITING_CONFIRMATION":
            break
        time.sleep(1)
    owner = s.get("requestedBy")
    ok = owner == "alice@example.com"
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + f"request recorded as made by {owner} (not mallory)")
    check("bob can't confirm alice's request", "POST", f"/api/v2/requests/{rid}/confirm", bob, 403)
    check("bob can't cancel it either", "POST", f"/api/v2/requests/{rid}/cancel", bob, 403)
    check("alice can't start a batch", "POST", "/api/v2/batches", alice, 403, {"items": []})
    check("an admin can cancel anyone's", "POST", f"/api/v2/requests/{rid}/cancel", admin, 204)

    print("-- BATCH (a service calling as itself)")
    spec = {"provider": "aws", "region": "us-east", "vcpu": 2, "memoryGiB": 4, "os": "ubuntu", "osVersion": "24.04",
            "diskGiB": 80, "diskTier": "ssd", "env": "test", "ttlDays": 1, "publicIp": False,
            "name": f"sec-{uuid.uuid4().hex[:6]}"}
    b = check("service starts a batch", "POST", "/api/v2/batches", service, 202,
              {"items": [{"spec": spec}], "requestedBy": "someone-else"})
    check("service reads its batch (BATCH includes READER)", "GET", f"/api/v2/batches/{b['batchId']}", service, 200)
    check("service can't make one-off requests", "POST", "/api/v2/interpret", service, 403, {"text": "x"})
    audit = requests.get(f"{base}/api/v2/audit?requestId={b['batchId']}",
                         headers={"Authorization": "Bearer " + reader}).json()
    actor = next((e["actor"] for e in audit if e["event"] == "BATCH_STARTED"), None) if audit else None
    for _ in range(20):
        if actor:
            break
        time.sleep(1)
        audit = requests.get(f"{base}/api/v2/audit?requestId={b['batchId']}",
                             headers={"Authorization": "Bearer " + reader}).json()
        actor = next((e["actor"] for e in audit if e["event"] == "BATCH_STARTED"), None)
    ok = actor == "app:22222222-aaaa-bbbb-cccc-333333333333"
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + f"audit trail names the service: {actor}")

    print("-- the document describes sign-in")
    doc = requests.get(base + "/v3/api-docs").json()
    schemes = sorted(doc.get("components", {}).get("securitySchemes", {}).keys())
    noted = all("Required role" in (op.get("description") or "")
                for p in doc["paths"].values() for op in p.values())
    ok = schemes == ["bearerToken", "entraId"] and noted
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + f"security schemes {schemes}; every operation states its role: {noted}")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    if "--serve-keys" in sys.argv:
        serve_keys()
    else:
        main((sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/"))
