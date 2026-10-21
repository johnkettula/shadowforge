"""
Client-certificate (PKI) sign-in test for vmintent.security.mode=pki, with no real PKI needed.

It makes a throwaway test PKI (a root CA, an issuing CA, a server certificate, client certificates
and a CRL), then checks who may do what against a running backend.

    pip install cryptography requests
    python tests/pki_test.py --make-certs tests/.pki          # 1. make the test PKI (git-ignored)
    # 2. start the API with (paths from step 1):
    #      SPRING_PROFILES_ACTIVE=tls            (add api / worker as usual)
    #      VMINTENT_SECURITY_MODE=pki            (or entra,pki)
    #      VMINTENT_TLS_CERT=tests/.pki/server.crt   VMINTENT_TLS_KEY=tests/.pki/server.key
    #      VMINTENT_PKI_CA_FILE=tests/.pki/ca-bundle.pem
    #      VMINTENT_PKI_CLIENTS_FILE=tests/.pki/pki-clients.yml
    #      VMINTENT_PKI_CRL_FILE=tests/.pki/crl.pem
    #    and, to test a TLS proxy forwarding the certificate in a header:
    #      VMINTENT_PKI_HEADER=X-Client-Cert   VMINTENT_PKI_TRUSTED_PROXIES=127.0.0.1
    python tests/pki_test.py https://localhost:8443 tests/.pki [--header X-Client-Cert]   # 3. run the checks

    # With VMINTENT_PKI_TRUSTED_PROXIES set to an address that isn't this machine, this checks that
    # the header (and a forged X-Forwarded-For) from anywhere else is ignored:
    python tests/pki_test.py https://localhost:8443 tests/.pki --header X-Client-Cert --untrusted-proxy

Never trust the test CA anywhere real: its private key sits in the test folder.
"""
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import uuid

import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ORG = [x509.NameAttribute(NameOID.COUNTRY_NAME, "US"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Example Test PKI")]

# name -> (role in the allowlist or None, how it's listed)
CLIENTS = {
    "batch-svc": ("BATCH", "subject+issuer"),
    "reader-svc": ("READER", "sha256"),
    "alice": ("REQUESTER", "subject"),
    "bob": ("REQUESTER", "subject"),
    "admin": ("ADMIN", "subject"),
    "unlisted": (None, None),
    "revoked": ("ADMIN", "subject"),
    "expired": ("ADMIN", "subject"),
}


def name(cn, ou=None):
    attrs = [*ORG] + ([x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, ou)] if ou else [])
    return x509.Name(attrs + [x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def key():
    return ec.generate_private_key(ec.SECP256R1())


def cert(subject, subject_key, issuer, issuer_key, ca=False, server=False, days=30, start=None):
    start = start or dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=5)
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
         .public_key(subject_key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(start).not_valid_after(start + dt.timedelta(days=days))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
         .add_extension(x509.SubjectKeyIdentifier.from_public_key(subject_key.public_key()), critical=False)
         .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False))
    if ca:
        b = b.add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
    else:
        b = b.add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
        b = b.add_extension(x509.ExtendedKeyUsage(
            [ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
    if server:
        import ipaddress
        b = b.add_extension(x509.SubjectAlternativeName(
            [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
    return b.sign(issuer_key, hashes.SHA256())


def pem(c):
    return c.public_bytes(serialization.Encoding.PEM)


def write(d, filename, data):
    with open(os.path.join(d, filename), "wb") as f:
        f.write(data)


def write_key(d, filename, k):
    write(d, filename, k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))


def make_certs(d):
    os.makedirs(d, exist_ok=True)
    root_k, issuing_k, rogue_k = key(), key(), key()
    root_n, issuing_n = name("Test Root CA"), name("Test Issuing CA 1")
    root = cert(root_n, root_k, root_n, root_k, ca=True, days=3650)
    issuing = cert(issuing_n, issuing_k, root_n, root_k, ca=True, days=1825)
    write(d, "ca-bundle.pem", pem(root) + pem(issuing))

    server_k = key()
    write(d, "server.crt", pem(cert(name("localhost"), server_k, issuing_n, issuing_k, server=True)) + pem(issuing))
    write_key(d, "server.key", server_k)

    lines = ["# Test allowlist made by tests/pki_test.py. Never use outside testing.", "clients:"]
    revoked_serial = None
    for cn, (role, how) in CLIENTS.items():
        k = key()
        start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=60) if cn == "expired" else None
        c = cert(name(cn, "Services"), k, issuing_n, issuing_k, start=start)
        write(d, f"{cn}.crt", pem(c))
        write_key(d, f"{cn}.key", k)
        if cn == "revoked":
            revoked_serial = c.serial_number
        if role is None:
            continue
        lines += [f"  - name: {cn}", f"    role: {role}"]
        if how == "sha256":
            lines.append(f"    sha256: \"{c.fingerprint(hashes.SHA256()).hex(':').upper()}\"")
        else:
            subject = c.subject.rfc4514_string()
            if cn == "bob":   # written the way openssl prints it: the other order, with spaces
                subject = ", ".join(reversed([p.strip() for p in subject.split(",")])).replace("=", " = ")
            lines.append(f"    subject: \"{subject}\"")
            if how == "subject+issuer":
                lines.append(f"    issuer: \"{issuing.subject.rfc4514_string()}\"")

    # Same name as batch-svc, but from a CA the API doesn't trust.
    rogue_ca_n = name("Test Issuing CA 1")
    rogue_ca = cert(rogue_ca_n, rogue_k, rogue_ca_n, rogue_k, ca=True)
    k = key()
    write(d, "rogue.crt", pem(cert(name("batch-svc", "Services"), k, rogue_ca_n, rogue_k)))
    write_key(d, "rogue.key", k)

    now = dt.datetime.now(dt.timezone.utc)
    crl = (x509.CertificateRevocationListBuilder().issuer_name(issuing_n)
           .last_update(now - dt.timedelta(minutes=5)).next_update(now + dt.timedelta(days=7))
           .add_revoked_certificate(x509.RevokedCertificateBuilder().serial_number(revoked_serial)
                                    .revocation_date(now - dt.timedelta(minutes=1)).build())
           .sign(issuing_k, hashes.SHA256()))
    write(d, "crl.pem", crl.public_bytes(serialization.Encoding.PEM))
    write(d, "pki-clients.yml", ("\n".join(lines) + "\n").encode())
    print(f"Test PKI written to {d}: ca-bundle.pem, server.crt/.key, crl.pem, pki-clients.yml, "
          f"and client certificates {', '.join(list(CLIENTS) + ['rogue'])}")


def main(base, d, header=None, untrusted_proxy=False):
    ca = os.path.join(d, "ca-bundle.pem")
    results = []

    def record(ok, text):
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + text)

    def call(method, path, who=None, body=None, headers=None):
        h = dict(headers or {})
        if body is not None:
            h["Content-Type"] = "application/json"
        c = (os.path.join(d, f"{who}.crt"), os.path.join(d, f"{who}.key")) if who else None
        return requests.request(method, base + path, cert=c, verify=ca, headers=h, timeout=30,
                                data=json.dumps(body) if body is not None else None)

    def check(label, method, path, who, expect, body=None, headers=None, contains=None):
        try:
            r = call(method, path, who, body, headers)
        except requests.exceptions.SSLError as e:
            # The TLS layer may refuse a bad certificate before the application sees it. That is a refusal too.
            ok = expect == 401
            record(ok, f"{label}: {method} {path} -> refused during the TLS handshake"
                   + ("" if ok else f" (expected {expect}) {e}"))
            return None
        ok = r.status_code == expect and (contains is None or contains in r.text)
        record(ok, f"{label}: {method} {path} -> {r.status_code}"
               + ("" if ok else f" (expected {expect}{', containing ' + repr(contains) if contains else ''}) {r.text[:300]}"))
        return r.json() if r.content and r.headers.get("Content-Type", "").startswith("application/json") else None

    if untrusted_proxy:
        print("-- a certificate header from an address that isn't the trusted proxy is ignored")
        fwd = {header: urllib.parse.quote(open(os.path.join(d, "admin.crt")).read())}
        check("header from an untrusted address", "GET", "/api/v2/vms", None, 401, headers=fwd,
              contains="only accepted from the API's TLS proxy")
        check("...even with a forged X-Forwarded-For", "GET", "/api/v2/vms", None, 401,
              headers={**fwd, "X-Forwarded-For": os.environ.get("TRUSTED_PROXY", "10.20.30.40")},
              contains="only accepted from the API's TLS proxy")
        print(f"\n{sum(results)}/{len(results)} checks passed")
        sys.exit(0 if all(results) else 1)

    print("-- the docs stay open, over HTTPS, without a certificate")
    check("API docs without a certificate", "GET", "/v3/api-docs", None, 200)
    check("Swagger UI without a certificate", "GET", "/swagger-ui/index.html", None, 200)

    print("-- refused certificates")
    check("no certificate", "GET", "/api/v2/vms", None, 401, contains="client certificate")
    check("trusted CA, not on the allowlist", "GET", "/api/v2/vms", "unlisted", 401, contains="not on this API's allowlist")
    check("on the allowlist but revoked", "GET", "/api/v2/vms", "revoked", 401, contains="revoked")
    check("on the allowlist but expired", "GET", "/api/v2/vms", "expired", 401)
    check("same name as batch-svc, from an untrusted CA", "POST", "/api/v2/batches", "rogue", 401, {"items": []})

    print("-- READER (listed by SHA-256 fingerprint)")
    check("reader lists VMs", "GET", "/api/v2/vms", "reader-svc", 200)
    check("reader reads stats", "GET", "/api/v2/stats", "reader-svc", 200)
    check("reader can't interpret", "POST", "/api/v2/interpret", "reader-svc", 403, {"text": "x"})
    check("reader can't start a batch", "POST", "/api/v2/batches", "reader-svc", 403, {"items": []})

    print("-- REQUESTER, and only the owner changes a request")
    r = check("alice starts a request (claims to be mallory)", "POST", "/api/v2/requests", "alice", 200,
              {"text": f"small debian 12 box on gcp us-central called pki-{uuid.uuid4().hex[:6]}", "userId": "mallory"})
    rid = r["requestId"] if r else None
    s = {}
    for _ in range(60):
        s = call("GET", f"/api/v2/requests/{rid}", "alice").json()
        if s.get("state") == "AWAITING_CONFIRMATION":
            break
        time.sleep(1)
    record(s.get("requestedBy") == "pki:alice", f"request recorded as made by {s.get('requestedBy')} (not mallory)")
    check("bob can't confirm alice's request", "POST", f"/api/v2/requests/{rid}/confirm", "bob", 403)
    check("alice can't start a batch", "POST", "/api/v2/batches", "alice", 403, {"items": []})
    check("an admin can cancel anyone's", "POST", f"/api/v2/requests/{rid}/cancel", "admin", 204)

    print("-- BATCH (listed by subject and issuer)")
    spec = {"provider": "aws", "region": "us-east", "vcpu": 2, "memoryGiB": 4, "os": "ubuntu", "osVersion": "24.04",
            "diskGiB": 80, "diskTier": "ssd", "env": "test", "ttlDays": 1, "publicIp": False,
            "name": f"pki-{uuid.uuid4().hex[:6]}"}
    b = check("service starts a batch", "POST", "/api/v2/batches", "batch-svc", 202,
              {"items": [{"spec": spec}], "requestedBy": "someone-else"})
    if b:
        check("service reads its batch (BATCH includes READER)", "GET", f"/api/v2/batches/{b['batchId']}", "batch-svc", 200)
        actor = None
        for _ in range(20):
            audit = call("GET", f"/api/v2/audit?requestId={b['batchId']}", "reader-svc").json()
            actor = next((e["actor"] for e in audit if e["event"] == "BATCH_STARTED"), None)
            if actor:
                break
            time.sleep(1)
        record(actor == "pki:batch-svc", f"audit trail names the service: {actor}")

    print("-- the allowlist is re-read when it changes (no restart)")
    clients = os.path.join(d, "pki-clients.yml")
    original = open(clients).read()
    unlisted = x509.load_pem_x509_certificate(open(os.path.join(d, "unlisted.crt"), "rb").read())
    try:
        with open(clients, "a") as f:
            f.write(f"  - name: unlisted\n    role: READER\n    subject: \"{unlisted.subject.rfc4514_string()}\"\n")
        time.sleep(3)
        check("newly listed certificate is accepted", "GET", "/api/v2/stats", "unlisted", 200)
    finally:
        with open(clients, "w") as f:
            f.write(original)
    time.sleep(3)
    check("and refused again once removed", "GET", "/api/v2/stats", "unlisted", 401)

    if header:
        print(f"-- a TLS proxy forwards the certificate in {header}")
        fwd = lambda who: {header: urllib.parse.quote(open(os.path.join(d, f"{who}.crt")).read())}
        check("forwarded batch-svc certificate", "GET", "/api/v2/stats", None, 200, headers=fwd("batch-svc"))
        check("forwarded unlisted certificate", "GET", "/api/v2/stats", None, 401, headers=fwd("unlisted"))
        check("forwarded revoked certificate", "GET", "/api/v2/stats", None, 401, headers=fwd("revoked"), contains="revoked")
        check("forwarded rogue certificate", "GET", "/api/v2/stats", None, 401, headers=fwd("rogue"),
              contains="not issued by a CA this API trusts")
        check("garbage in the header", "GET", "/api/v2/stats", None, 401, headers={header: "not-a-cert"})

    print("-- the document describes sign-in")
    doc = requests.get(base + "/v3/api-docs", verify=ca).json()
    described = "client certificate" in doc["info"]["description"] and "x-client-certificate" in doc
    documented = all("401" in op["responses"] for p in doc["paths"].values() for op in p.values())
    record(described and documented, f"overview and x-client-certificate describe it: {described}; "
                                     f"every operation documents 401: {documented}")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--make-certs":
        make_certs(args[1] if len(args) > 1 else "tests/.pki")
    else:
        hdr = args[args.index("--header") + 1] if "--header" in args else None
        pos = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--header")]
        main((pos[0] if pos else "https://localhost:8443").rstrip("/"), pos[1] if len(pos) > 1 else "tests/.pki",
             hdr, "--untrusted-proxy" in args)
