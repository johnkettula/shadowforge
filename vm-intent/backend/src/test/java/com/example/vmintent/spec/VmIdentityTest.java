package com.example.vmintent.spec;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

    /** sha256sum of "owner:5:alice" + NAMED_CANONICAL, worked out outside Java. */
    static final String NAMED_ALICE_HASH = "55214b87cfcbc9ec28a39d76e1f8a9ad8070c55e5eed423f7640bf04077ea9b1";

    @Test
    void twoSignedInUsersGetDifferentHashesForTheSameSpec() {
        for (Object[] c : new Object[][]{{NAMED, NAMED_HASH}, {UNNAMED, UNNAMED_HASH}}) {
            VmSpec spec = (VmSpec) c[0];
            String anonymous = (String) c[1];
            String alice = VmIdentity.hash(spec, "alice");
            String bob = VmIdentity.hash(spec, "bob");
            assertNotEquals(alice, bob, "two users, two VMs");
            assertNotEquals(anonymous, alice, "a signed-in user's hash isn't the anonymous one");
            assertNotEquals(anonymous, bob);
            for (String h : List.of(alice, bob)) {
                assertTrue(h.matches("[0-9a-f]{64}"), "64 lowercase hex characters: " + h);
            }
        }
    }

    @Test
    void aSignedInUsersHashIsStableAndFollowsTheSpec() {
        assertEquals(NAMED_ALICE_HASH, VmIdentity.hash(NAMED, "alice"), "the same every time, on every server");
        assertEquals(VmIdentity.hash(NAMED, "alice"), VmIdentity.hash(NAMED, "alice"));
        assertEquals(VmIdentity.hash(UNNAMED, "alice"), VmIdentity.hash(UNNAMED, "alice"));
        assertNotEquals(VmIdentity.hash(NAMED, "alice"), VmIdentity.hash(UNNAMED, "alice"), "another spec");
        assertNotEquals(VmIdentity.hash(NAMED, "alice"), VmIdentity.hash(NAMED.withName("web-02"), "alice"));
    }

    @Test
    void noAnonymousSpecHashesTheSameInputAsASignedInUser() {
        // Every canonical string starts with "{"; an owner's input never does, whatever the owner.
        for (String owner : List.of("alice", "", "{", "a{\"name\":\"x\"}", "anonymous ")) {
            String owned = VmIdentity.ownedString(NAMED, owner);
            assertFalse(owned.startsWith("{"), owned);
            assertTrue(owned.endsWith(NAMED_CANONICAL), owned);
        }
        assertTrue(SpecCanonicalizer.canonicalString(UNNAMED).startsWith("{"));
        // The owner's length keeps an owner that looks like the start of a spec apart from the spec.
        assertNotEquals(VmIdentity.ownedString(NAMED, "a{"), VmIdentity.ownedString(NAMED, "a"));
        assertNotEquals(VmIdentity.hash(NAMED, "Alice"), VmIdentity.hash(NAMED, "alice"), "owner IDs are exact");
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

    @Test
    void theBuildKeyIsTheHashOrTheHashAndTheRunIdPrefix() {
        // VmReconcileWorkflowImpl's build key: the recorded histories replay only while this stays the same.
        assertEquals(NAMED_HASH, VmIdentity.buildKey(NAMED_HASH, null));
        assertEquals(NAMED_HASH, VmIdentity.buildKey(NAMED_HASH, ""));
        assertEquals(NAMED_HASH + "-abcd1234", VmIdentity.buildKey(NAMED_HASH, "abcd1234"));
        assertEquals(NAMED_HASH, VmIdentity.hashOfBuildKey(VmIdentity.buildKey(NAMED_HASH, null)));
        assertEquals(NAMED_HASH, VmIdentity.hashOfBuildKey(VmIdentity.buildKey(NAMED_HASH, "")));
        assertEquals(NAMED_HASH, VmIdentity.hashOfBuildKey(VmIdentity.buildKey(NAMED_HASH, "abcd1234")));
        assertNull(VmIdentity.hashOfBuildKey(null));
    }

    @Test
    void twoBuildsAreTheSameOnlyWithTheSameHash() {
        assertTrue(VmIdentity.sameBuild(NAMED_HASH + "-abcd1234", NAMED_HASH + "-ffff0000"), "a new run of the same VM");
        assertTrue(VmIdentity.sameBuild(NAMED_HASH, NAMED_HASH + "-ffff0000"), "built before run IDs were added");
        assertFalse(VmIdentity.sameBuild(UNNAMED_HASH + "-abcd1234", NAMED_HASH + "-abcd1234"), "another spec");
        assertFalse(VmIdentity.sameBuild(null, NAMED_HASH));
        assertFalse(VmIdentity.sameBuild("", NAMED_HASH));
    }
}
