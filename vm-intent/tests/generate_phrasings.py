"""
Generates N test phrasings for the VM intent interpreter, each with the spec it
should produce. Usage:

    python tests/generate_phrasings.py --seed 1 --count 1000 --out tests/phrasings-gen-s1.json

How it works: pick a random target VM, decide which fields the "user" mentions,
word each mentioned field in one of many ways, then join the pieces in one of
several styles (sentence, terse, pipes, question, chat). The expected spec is the
target plus the platform's documented defaults for anything left unsaid.

About 10% of cases are "must ask" cases: no platform named, or a request over
policy limits. Those expect a clarifying question instead of a spec.

The synonym banks below were written as "how people talk", not copied from the
interpreter's vocabulary, so some wordings are expected to fail.
"""
import argparse
import json
import random

DEFAULT_VERSION = {"ubuntu": "24.04", "rhel": "9", "windows": "2022", "debian": "12", "rocky": "9"}
TTL_BY_ENV = {"dev": 30, "test": 14, "staging": 30, "prod": 0}
SIZE_CLASS = {(1, 2): "xsmall", (2, 4): "small", (4, 16): "medium", (8, 32): "large", (16, 64): "xlarge"}
SIZES = [(1, 2), (2, 4), (2, 8), (4, 8), (4, 16), (8, 32), (8, 64), (16, 64), (32, 128)]

PROVIDER_WORDS = {
    "aws": ["AWS", "Amazon", "Amazon Web Services", "EC2", "aws", "amazon cloud", "AWS EC2"],
    "azure": ["Azure", "Microsoft Azure", "azure", "MS Azure", "Azure cloud"],
    "gcp": ["GCP", "Google Cloud", "Google Cloud Platform", "GCE", "gcp", "Google Compute Engine", "google cloud"],
    "vsphere": ["vSphere", "VMware", "on-prem", "on premises", "our VMware cluster", "vmware", "on-premises vSphere"],
}

REGION_WORDS = {
    ("aws", "us-east"): ["us-east-1", "N. Virginia", "Virginia", "US East", "east coast", "us-east"],
    ("aws", "us-west"): ["us-west-2", "Oregon", "US West", "west coast", "us-west"],
    ("aws", "us-central"): ["us-east-2", "Ohio"],
    ("aws", "eu-west"): ["eu-west-1", "Ireland", "Dublin", "Europe (Ireland)", "eu-west"],
    ("azure", "us-east"): ["eastus", "East US", "Virginia", "US East"],
    ("azure", "us-west"): ["westus2", "West US 2", "West US", "California", "west coast"],
    ("azure", "us-central"): ["centralus", "Central US", "Iowa"],
    ("azure", "eu-west"): ["westeurope", "West Europe", "Netherlands", "Amsterdam", "Europe"],
    ("gcp", "us-east"): ["us-east4", "Northern Virginia", "US East", "east coast"],
    ("gcp", "us-west"): ["us-west1", "Oregon", "US West", "west coast"],
    ("gcp", "us-central"): ["us-central1", "Iowa", "Central US", "the central US"],
    ("gcp", "eu-west"): ["europe-west1", "Belgium", "Europe", "eu-west"],
    ("vsphere", "dc1"): ["DC1", "dc1", "the primary datacenter", "datacenter 1", "the main data center"],
    ("vsphere", "dc2"): ["DC2", "dc2", "the secondary datacenter", "the second data center", "datacenter 2"],
}

# Real provider size names (vCPU, GiB)
PROVIDER_SIZES = {
    "aws": {(2, 4): ["t3.medium"], (2, 8): ["m6i.large", "m5.large"], (4, 8): ["c6i.xlarge", "c5.xlarge"],
            (4, 16): ["m6i.xlarge", "t3.xlarge"], (8, 32): ["m6i.2xlarge"], (8, 64): ["r6i.2xlarge"],
            (16, 64): ["m6i.4xlarge"], (32, 128): ["m6i.8xlarge"]},
    "azure": {(1, 2): ["Standard_B1ms"], (2, 8): ["Standard_D2s_v5"], (4, 8): ["Standard_F4s_v2"],
              (4, 16): ["Standard_D4s_v5"], (8, 32): ["Standard_D8s_v5"], (8, 64): ["Standard_E8s_v5"],
              (16, 64): ["Standard_D16s_v5"], (32, 128): ["Standard_D32s_v5"]},
    "gcp": {(2, 4): ["e2-medium"], (2, 8): ["e2-standard-2", "n2-standard-2"], (4, 16): ["e2-standard-4"],
            (8, 32): ["e2-standard-8", "n2-standard-8"], (8, 64): ["e2-highmem-8"],
            (16, 64): ["e2-standard-16"], (32, 128): ["n2-standard-32"]},
}

SIZE_CLASS_WORDS = {
    "xsmall": ["tiny", "micro", "very small"],
    "small": ["small", "smallish"],
    "medium": ["medium", "mid-size", "medium-sized"],
    "large": ["large", "big"],
    "xlarge": ["extra large", "XL", "x-large"],
}

OS_FORMS = {
    ("ubuntu", "24.04"): ["Ubuntu 24.04", "ubuntu 24.04 LTS", "Ubuntu Noble", "ubuntu24.04", "Ubuntu 24"],
    ("ubuntu", "22.04"): ["Ubuntu 22.04", "ubuntu 22.04 LTS", "Ubuntu Jammy", "Ubuntu 22"],
    ("rhel", "9"): ["RHEL 9", "Red Hat 9", "rhel9", "Red Hat Enterprise Linux 9", "RHEL9"],
    ("rhel", "8"): ["RHEL 8", "Red Hat 8", "rhel8", "Red Hat Enterprise Linux 8"],
    ("windows", "2022"): ["Windows Server 2022", "Windows 2022", "win2022", "Win Server 2022", "WS2022"],
    ("windows", "2019"): ["Windows Server 2019", "Windows 2019", "win2019", "Win Server 2019"],
    ("debian", "12"): ["Debian 12", "debian 12", "Debian Bookworm", "debian12"],
    ("rocky", "9"): ["Rocky Linux 9", "Rocky 9", "rocky9", "Rocky Linux"],
}
OS_NAME_ONLY = {"ubuntu": ["Ubuntu", "ubuntu"], "rhel": ["RHEL", "Red Hat"], "windows": ["Windows", "Windows Server"],
                "debian": ["Debian"], "rocky": ["Rocky Linux", "Rocky"]}

ENV_FORMS = {
    "dev": ["dev", "development", "for development", "dev env", "sandbox"],
    "test": ["test", "testing", "for testing", "QA", "test env"],
    "staging": ["staging", "stage", "for staging", "staging env", "pre-prod"],
    "prod": ["prod", "production", "for production", "prod env", "production workload"],
}

TIER_FORMS = {"ssd": ["SSD", "premium SSD", "NVMe", "fast SSD"],
              "standard": ["HDD", "standard HDD", "spinning disk", "cheap storage", "standard disk", "magnetic"]}

PUBLIC_FORMS = ["with a public IP", "public-facing", "internet-facing", "needs an external IP",
                "reachable from the internet", "with a public address", "publicly accessible"]
PRIVATE_FORMS = ["no public IP", "private only", "internal only"]

NUMBER_WORDS = {1: "one", 2: "two", 4: "four", 8: "eight", 16: "sixteen", 32: "thirty-two"}


def size_phrase(rng, v, m):
    forms = [
        f"{v} vCPU, {m} GB RAM",
        f"{v} vCPUs and {m} GB of memory",
        f"{v} cores / {m} gigs",
        f"{v} CPU {m}GB",
        f"{m} GB RAM and {v} vCPUs",
        f"{v}c{m}g",
        f"{v}x{m}",
        f"{v} cores, {m} GiB memory",
        f"{v} vcpu {m * 1024} MB ram",
        f"{NUMBER_WORDS.get(v, v)} cores and {NUMBER_WORDS.get(m, m)} GB of RAM",
        f"CPU: {v}, RAM: {m} GB",
        f"{v} processors with {m}GB memory",
    ]
    return rng.choice(forms)


def disk_phrase(rng, gib, tier):
    if gib >= 1024 and gib % 1024 == 0:
        amt = rng.choice([f"{gib // 1024} TB", f"{gib // 1024}TB", f"{gib} GB"])
    else:
        amt = rng.choice([f"{gib} GB", f"{gib}GB", f"{gib} GiB", f"{gib} gig"])
    tier_word = rng.choice(TIER_FORMS[tier]) if tier else None
    if tier_word:
        return rng.choice([f"{amt} {tier_word}", f"a {amt} {tier_word} disk", f"{amt} {tier_word} storage"])
    return rng.choice([f"{amt} disk", f"a {amt} drive", f"{amt} of storage", f"disk {amt}", f"{amt} root volume"])


def ttl_phrase(rng, days):
    named = {7: ["for a week", "for 7 days", "temporary", "7-day lifetime"],
             14: ["for 2 weeks", "for 14 days", "expire after 14 days"],
             30: ["for 30 days", "for a month", "delete after 30 days"],
             3: ["for 3 days", "delete after 3 days", "3-day lifetime"],
             60: ["for 60 days", "for 2 months"],
             90: ["for 90 days", "for 3 months"]}
    return rng.choice(named[days])


def make_positive(rng):
    provider = rng.choice(["aws", "azure", "gcp", "vsphere"])
    regions = ["dc1", "dc2"] if provider == "vsphere" else ["us-east", "us-west", "us-central", "eu-west"]
    os_key = rng.choice(list(OS_FORMS.keys()))
    os, osv = os_key
    v, m = rng.choice(SIZES)

    parts = []
    exp = {}

    # platform (always present for positives)
    parts.append(("provider", rng.choice(PROVIDER_WORDS[provider])))
    exp["provider"] = provider

    # region: 80% stated
    if rng.random() < 0.8:
        region = rng.choice(regions)
        parts.append(("region", rng.choice(REGION_WORDS[(provider, region)])))
    else:
        region = "dc1" if provider == "vsphere" else "us-east"
    exp["region"] = region

    # size
    mode = rng.random()
    if mode < 0.55:
        parts.append(("size", size_phrase(rng, v, m)))
    elif mode < 0.70 and (v, m) in SIZE_CLASS:
        parts.append(("sizeword", rng.choice(SIZE_CLASS_WORDS[SIZE_CLASS[(v, m)]])))
    elif mode < 0.85 and provider in PROVIDER_SIZES and (v, m) in PROVIDER_SIZES[provider]:
        parts.append(("size", rng.choice(PROVIDER_SIZES[provider][(v, m)])))
    elif mode < 0.92:
        m = v * 4
        parts.append(("size", rng.choice([f"{v} vCPU", f"{v} cores", f"{v} CPUs"])))
    else:
        v, m = 2, 4  # unstated: default small
    exp["vcpu"], exp["memoryGiB"] = v, m

    # OS: 85% stated
    r = rng.random()
    if r < 0.65:
        parts.append(("os", rng.choice(OS_FORMS[os_key])))
    elif r < 0.85:
        osv = DEFAULT_VERSION[os]
        parts.append(("os", rng.choice(OS_NAME_ONLY[os])))
    else:
        os, osv = "ubuntu", "24.04"
        if rng.random() < 0.5:
            parts.append(("os", rng.choice(["Linux", "linux"])))
    exp["os"], exp["osVersion"] = os, osv

    # disk: 45% stated
    tier = None
    if rng.random() < 0.45:
        gib = rng.choice([80, 100, 200, 250, 500, 1024, 2048])
        if os == "windows" and gib < 64:
            gib = 128
        tier = rng.choice([None, None, "ssd", "standard"])
        parts.append(("disk", disk_phrase(rng, gib, tier)))
    else:
        gib = 128 if os == "windows" else 50
    exp["diskGiB"] = gib
    exp["diskTier"] = tier or "ssd"

    # env: 50% stated
    env = "dev"
    if rng.random() < 0.5:
        env = rng.choice(["dev", "test", "staging", "prod"])
        parts.append(("env", rng.choice(ENV_FORMS[env])))
    exp["env"] = env

    # ttl: 20% stated (not for prod)
    ttl = TTL_BY_ENV[env]
    if env != "prod" and rng.random() < 0.2:
        ttl = rng.choice([3, 7, 14, 30, 60, 90])
        parts.append(("ttl", ttl_phrase(rng, ttl)))
    exp["ttlDays"] = ttl

    # public ip: 20% public, 5% explicit private
    pub = False
    r = rng.random()
    if r < 0.2:
        pub = True
        parts.append(("public", rng.choice(PUBLIC_FORMS)))
    elif r < 0.25:
        parts.append(("public", rng.choice(PRIVATE_FORMS)))
    exp["publicIp"] = pub

    return render(rng, parts), exp


def render(rng, parts):
    rng.shuffle(parts)
    # keep provider and region next to each other half the time
    words = [p for _, p in parts]
    style = rng.choice(["sentence", "sentence", "terse", "pipes", "slashes", "question", "chat", "request"])
    if style == "terse":
        return ", ".join(w.lower() if rng.random() < 0.5 else w for w in words)
    if style == "pipes":
        return " | ".join(words)
    if style == "slashes":
        return " / ".join(words)
    body = ", ".join(words)
    if style == "question":
        return rng.choice(["Can I get a VM: ", "Could you spin up a server with ", "Can you provision "]) + body + "?"
    if style == "chat":
        return rng.choice(["need a box asap - ", "hey, pls make a vm: ", "quick one: "]) + body
    if style == "request":
        return rng.choice(["Requesting a new VM. Details: ", "New server request -> ", "Ticket: VM needed. "]) + body + "."
    return rng.choice(["Please create a VM with ", "I need a server: ", "Set up a virtual machine, ",
                       "We need a new machine with "]) + body + "."


IMPLIES_PROVIDER = ["us-east-1", "us-west-2", "eu-west-1", "us-east-2", "eastus", "westus2", "centralus",
                    "westeurope", "us-east4", "us-west1", "us-central1", "europe-west1", "dc1", "dc2", "DC1", "DC2",
                    "datacenter", "data center", ".", "Standard_", "e2-", "n2-"]


def make_must_ask(rng):
    kind = rng.random()
    if kind < 0.6:
        # no platform: strip provider and anything that implies one
        while True:
            text, _ = make_positive(rng)
            for words in PROVIDER_WORDS.values():
                for w in sorted(words, key=len, reverse=True):
                    text = text.replace(w, "").replace(w.lower(), "")
            if not any(k in text for k in IMPLIES_PROVIDER if k != ".") and not any(
                    s in text for s in ["t3.", "m6i.", "m5.", "c6i.", "c5.", "r6i."]):
                return " ".join(text.split()), "no platform"
    provider = rng.choice(["AWS", "Azure", "GCP", "vSphere"])
    bad = rng.choice([
        f"{provider} VM with 128 vCPUs",
        f"{provider} server with 96 cores and 64 GB RAM",
        f"{provider} VM with 2 vCPU and 1024 GB of RAM",
        f"{provider} Ubuntu box with an 8 TB disk",
        f"{provider} VM with a 5 GB disk",
        f"{provider} Windows 2022 server with a 20 GB disk",
        f"{provider} VM that lasts 400 days",
    ])
    return bad, "over policy limits"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--count", type=int, default=1000)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    cases = []
    n_ask = a.count // 10
    for i in range(a.count - n_ask):
        text, exp = make_positive(rng)
        cases.append({"id": f"S{a.seed}-{i + 1:04d}", "text": text, "expect": exp})
    for j in range(n_ask):
        text, why = make_must_ask(rng)
        cases.append({"id": f"S{a.seed}-A{j + 1:03d}", "text": text, "expectQuestion": True, "why": why})
    json.dump({"generator": "generate_phrasings.py", "seed": a.seed, "cases": cases}, open(a.out, "w"), indent=1)
    print(f"wrote {len(cases)} cases to {a.out}")


if __name__ == "__main__":
    main()
