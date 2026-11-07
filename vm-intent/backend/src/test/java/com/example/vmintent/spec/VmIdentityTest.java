package com.example.vmintent.spec;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Golden values: a VM's hash must never change for existing VMs. The literals were worked out
 * independently (sha256sum of the canonical string) before VmIdentity existed. If this test fails,
 * existing VMs would get new workflow IDs and stop being found as duplicates: change the code, not
 * the literals.
 */
class VmIdentityTest {

    static final VmSpec NAMED = new VmSpec("web-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 80, "ssd", "test", 7, false);
    static final String NAMED_CANONICAL = "{\"diskGiB\":80,\"diskTier\":\"ssd\",\"env\":\"test\",\"memoryGiB\":4,"
            + "\"name\":\"web-01\",\"os\":\"ubuntu\",\"osVersion\":\"24.04\",\"provider\":\"aws\",\"publicIp\":false,"
            + "\"region\":\"us-east\",\"ttlDays\":7,\"vcpu\":2}";
    static final String NAMED_HASH = "2a616b09f0ae398fdb96bb9ccb6b15a79d901fa4b8a4bb670c35d3a333148d4a";

    static final VmSpec UNNAMED = new VmSpec(null, "vsphere", "dc1", 4, 16, "rhel", "9", 100, "standard", "prod", 0, false);
    static final String UNNAMED_CANONICAL = "{\"diskGiB\":100,\"diskTier\":\"standard\",\"env\":\"prod\",\"memoryGiB\":16,"
            + "\"os\":\"rhel\",\"osVersion\":\"9\",\"provider\":\"vsphere\",\"publicIp\":false,\"region\":\"dc1\","
            + "\"ttlDays\":0,\"vcpu\":4}";
    static final String UNNAMED_HASH = "f2828963ebcdbc7aef820bcd659f596a71ba4162248b1f3a6c4a79dc89db6cc1";

    @Test
    void theCanonicalStringsAreUnchanged() {
        assertEquals(NAMED_CANONICAL, SpecCanonicalizer.canonicalString(NAMED));
        assertEquals(UNNAMED_CANONICAL, SpecCanonicalizer.canonicalString(UNNAMED), "no name = no name key");
    }

    @Test
    void anonymousOwnersGetTodaysHash() {
        for (Object[] c : new Object[][]{{NAMED, NAMED_HASH}, {UNNAMED, UNNAMED_HASH}}) {
            VmSpec spec = (VmSpec) c[0];
            String pinned = (String) c[1];
            assertEquals(pinned, SpecCanonicalizer.hash(spec));
            assertEquals(pinned, VmIdentity.hash(spec, null));
            assertEquals(pinned, VmIdentity.hash(spec, "anonymous"));
        }
    }

    @Test
    void forNowEveryOwnerGetsTheSameHash() {
        // Per-user identity isn't switched on yet: a signed-in owner changes nothing.
        assertEquals(NAMED_HASH, VmIdentity.hash(NAMED, "alice"));
        assertEquals(UNNAMED_HASH, VmIdentity.hash(UNNAMED, "bob"));
    }

    @Test
    void workflowIdsAreBuiltFromTheHash() {
        assertEquals("vm-" + NAMED_HASH, VmIdentity.buildWorkflowId(NAMED_HASH));
        assertEquals("life-" + NAMED_HASH, VmIdentity.lifecycleWorkflowId(NAMED_HASH));
        assertEquals("vm-2a616b09f0ae398fdb96bb9ccb6b15a79d901fa4b8a4bb670c35d3a333148d4a",
                VmIdentity.buildWorkflowId(NAMED_HASH));
        assertEquals("life-2a616b09f0ae398fdb96bb9ccb6b15a79d901fa4b8a4bb670c35d3a333148d4a",
                VmIdentity.lifecycleWorkflowId(NAMED_HASH));
    }
}
