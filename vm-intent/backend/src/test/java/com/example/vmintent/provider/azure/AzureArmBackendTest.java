package com.example.vmintent.provider.azure;

import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.VmStatus;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.temporal.failure.ApplicationFailure;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.*;

/** AzureArmBackend against MockArm: each call moves one step, as Temporal's retries of an activity would call it. */
class AzureArmBackendTest {

    static final String PIP = "Microsoft.Network/publicIPAddresses", NIC = "Microsoft.Network/networkInterfaces",
            VM = "Microsoft.Compute/virtualMachines";
    static final String SUBNET = "/subscriptions/sub-1/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/default";

    MockArm arm;
    AzureArmBackend backend;

    @BeforeEach
    void start() throws Exception {
        arm = new MockArm();
        arm.pollsUntilDone = 2;
        backend = backend(new AzureVmProperties(SUBNET, null, "ssh-ed25519 AAAAtest test@example"));
    }

    @AfterEach
    void stop() {
        arm.close();
    }

    AzureArmBackend backend(AzureVmProperties vm) {
        return new AzureArmBackend(arm.properties(), vm, new ArmClient(arm.properties()));
    }

    static VmSpec spec(String name, String os, String region) {
        return new VmSpec(name, "azure", region, 2, 4, os, "24.04", 30, "ssd", "dev", 0, true);
    }

    /** Calls the way Temporal retries an activity: again after each retryable CloudBusy, each call well under 5 s. */
    static <T> T retried(Supplier<T> call) {
        for (int i = 0; i < 30; i++) {
            long t0 = System.nanoTime();
            try {
                return call.get();
            } catch (ApplicationFailure e) {
                assertEquals("CloudBusy", e.getType(), e.getMessage());
                assertFalse(e.isNonRetryable());
            } finally {
                assertTrue(System.nanoTime() - t0 < 5_000_000_000L, "one call took 5 s or more");
            }
        }
        throw new AssertionError("still busy after 30 calls");
    }

    String build(String name) {
        return retried(() -> backend.createVm(spec(name, "ubuntu", "eu-west"), null, "key-" + name));
    }

    long count(String method, String type, String name) {
        return arm.calls.stream().filter(c -> c.startsWith(method + " ") && c.contains("/" + type + "/" + name + "?")).count();
    }

    long changes() {
        return arm.calls.stream().filter(c -> c.startsWith("PUT ") || c.startsWith("DELETE ")).count();
    }

    void untagged(String type, String name) {
        ObjectNode r = MockArm.JSON.createObjectNode().put("id", MockArm.id(type, name)).put("name", name).put("type", type);
        r.putObject("properties").put("provisioningState", "Succeeded");
        arm.resources.put(MockArm.id(type, name).toLowerCase(), r);
    }

    @Test
    void createVmMovesOneStepPerCallAndReturnsOnceTheVmIsStarted() {
        assertEquals("arm:" + MockArm.RESOURCE_GROUP + ":web-01", build("web-01"));

        assertEquals(1, count("PUT", PIP, "web-01-pip"));
        assertEquals(1, count("PUT", NIC, "web-01-nic"));
        assertEquals(1, count("PUT", VM, "web-01"));
        String calls = String.join("\n", arm.calls);
        assertTrue(calls.indexOf("PUT " + MockArm.id(PIP, "web-01-pip")) < calls.indexOf("PUT " + MockArm.id(NIC, "web-01-nic")));
        assertTrue(calls.indexOf("PUT " + MockArm.id(NIC, "web-01-nic")) < calls.indexOf("PUT " + MockArm.id(VM, "web-01")));
        assertTrue(arm.operations.values().stream().anyMatch(o -> o.resourceId.contains("/virtualMachines/") && o.status.equals("InProgress")),
                "returned without waiting for the VM");
        for (String[] r : new String[][]{{PIP, "web-01-pip"}, {NIC, "web-01-nic"}, {VM, "web-01"}}) {
            ObjectNode res = arm.resource(r[0], r[1]);
            assertEquals("managed", res.path("tags").path("vm-intent").asText());
            assertEquals("key-web-01", res.path("tags").path("vm-intent-key").asText());
        }
        assertEquals(SUBNET, arm.resource(NIC, "web-01-nic").at("/properties/ipConfigurations/0/properties/subnet/id").asText());
        assertEquals("Canonical", arm.resource(VM, "web-01").at("/properties/storageProfile/imageReference/publisher").asText());
    }

    @Test
    void createVmAgainReturnsTheSameIdWithoutAPut() {
        String id = build("web-01");
        arm.calls.clear();
        assertEquals(id, backend.createVm(spec("web-01", "ubuntu", "eu-west"), null, "key-web-01"));
        assertEquals(0, changes(), arm.calls.toString());
    }

    @Test
    void anUntaggedVmOfThatNameIsNeverTouched() {
        untagged(VM, "web-01");
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.createVm(spec("web-01", "ubuntu", "eu-west"), null, "k"));
        assertEquals("InvalidSpec", e.getType());
        assertTrue(e.isNonRetryable());
        assertEquals(0, changes(), arm.calls.toString());
    }

    static final String HASH = "9f86d081884c7d65", OTHER_HASH = "60303ae22b998861";

    String build(String name, String key) {
        return retried(() -> backend.createVm(spec(name, "ubuntu", "eu-west"), null, key));
    }

    long vms() {
        return arm.resources.keySet().stream().filter(k -> k.contains("/virtualmachines/")).count();
    }

    @Test
    void aNewRunOfTheSameSpecAdoptsTheVmItBuilt() {
        String id = build("web-10", VmIdentity.buildKey(HASH, "run00001"));
        arm.calls.clear();
        assertEquals(id, backend.createVm(spec("web-10", "ubuntu", "eu-west"), null, VmIdentity.buildKey(HASH, "run00002")));
        assertEquals(0, changes(), arm.calls.toString());
        assertEquals(1, vms());
    }

    @Test
    void aVmBuiltForAnotherSpecIsRefusedAndLeftAlone() {
        build("web-11", VmIdentity.buildKey(HASH, "run00001"));
        arm.calls.clear();
        ApplicationFailure e = assertThrows(ApplicationFailure.class,
                () -> backend.createVm(spec("web-11", "ubuntu", "eu-west"), null, VmIdentity.buildKey(OTHER_HASH, "run00002")));
        assertEquals("InvalidSpec", e.getType());
        assertTrue(e.isNonRetryable());
        assertTrue(e.getOriginalMessage().contains("another request"), e.getOriginalMessage());
        assertEquals(0, changes(), arm.calls.toString());
        assertEquals(1, vms());
        assertEquals(HASH + "-run00001", arm.resource(VM, "web-11").path("tags").path("vm-intent-key").asText(), "the VM is untouched");
    }

    @Test
    void aManagedVmWithNoKeyTagIsStillAdopted() {
        // Built before keys were read back: tagged vm-intent=managed but no vm-intent-key, so adopted as before.
        untagged(VM, "old-01");
        arm.resource(VM, "old-01").putObject("tags").put("vm-intent", "managed");
        assertEquals("arm:" + MockArm.RESOURCE_GROUP + ":old-01",
                backend.createVm(spec("old-01", "ubuntu", "eu-west"), null, VmIdentity.buildKey(HASH, "run00001")));
        assertEquals(0, changes(), arm.calls.toString());
        assertEquals(1, vms());
    }

    @Test
    void windowsAndAnotherRegionAreRefusedBeforeAnyPut() {
        for (VmSpec s : new VmSpec[]{spec("win-01", "windows", "eu-west"), spec("web-01", "ubuntu", "us-east")}) {
            ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.createVm(s, null, "k"));
            assertEquals("InvalidSpec", e.getType());
            assertTrue(e.isNonRetryable());
        }
        assertEquals(0, changes(), arm.calls.toString());
    }

    @Test
    void missingSettingsAreNamedAndNothingIsSent() {
        ApplicationFailure e = assertThrows(ApplicationFailure.class,
                () -> backend(new AzureVmProperties("", "azureuser", "")).createVm(spec("web-01", "ubuntu", "eu-west"), null, "k"));
        assertEquals("NotSetUp", e.getType());
        assertTrue(e.isNonRetryable());
        assertTrue(e.getMessage().contains("subnet-id") && e.getMessage().contains("admin-ssh-public-key"), e.getMessage());
        assertTrue(arm.calls.isEmpty(), arm.calls.toString());
    }

    /** describeVm, again while it is PENDING. */
    VmStatus settled(String id) {
        return retried(() -> {
            VmStatus v = backend.describeVm(id);
            if (v.state().equals("PENDING")) throw ApplicationFailure.newFailure("pending", "CloudBusy");
            return v;
        });
    }

    @Test
    void describeVmIsPendingThenRunningWithThePublicIp() {
        String id = build("web-01");
        long changes = changes();
        assertEquals("PENDING", backend.describeVm(id).state());
        VmStatus s = settled(id);
        assertEquals("RUNNING", s.state());
        assertTrue(s.ipAddress() != null && s.ipAddress().startsWith("20.50.0."), String.valueOf(s.ipAddress()));
        assertEquals(changes, changes(), "only reads");

        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.describeVm("arm:" + MockArm.RESOURCE_GROUP + ":nope"));
        assertEquals("VmNotFound", e.getType());
        assertTrue(e.isNonRetryable());
    }

    @Test
    void describeVmReportsArmsMessageWhenTheVmFailed() {
        settled(build("web-01"));
        arm.resources.remove(MockArm.id(VM, "web-01").toLowerCase());
        arm.failNextOperation("QuotaExceeded: no cores left");
        VmStatus s = settled(build("web-01"));
        assertEquals("FAILED", s.state());
        assertTrue(s.detail().contains("no cores left"), s.detail());
    }

    @Test
    void deleteVmRemovesVmNicAndIpOneStepAtATimeAndAgainSendsNothing() {
        String id = build("web-01");
        settled(id);
        retried(() -> {
            backend.deleteVm(id);
            return true;
        });
        assertTrue(arm.resources.isEmpty(), arm.resources.keySet().toString());
        assertEquals(1, count("DELETE", VM, "web-01"));
        assertEquals(1, count("DELETE", NIC, "web-01-nic"));
        assertEquals(1, count("DELETE", PIP, "web-01-pip"));
        String calls = String.join("\n", arm.calls);
        assertTrue(calls.indexOf("DELETE " + MockArm.id(VM, "web-01")) < calls.indexOf("DELETE " + MockArm.id(NIC, "web-01-nic")));
        assertTrue(calls.indexOf("DELETE " + MockArm.id(NIC, "web-01-nic")) < calls.indexOf("DELETE " + MockArm.id(PIP, "web-01-pip")));

        arm.calls.clear();
        backend.deleteVm(id);
        assertEquals(0, changes(), arm.calls.toString());
    }

    @Test
    void deleteVmLeavesAnUntaggedResourceAlone() {
        untagged(NIC, "web-01-nic");
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.deleteVm("arm:" + MockArm.RESOURCE_GROUP + ":web-01"));
        assertTrue(e.isNonRetryable());
        assertNotNull(arm.resource(NIC, "web-01-nic"));
        assertEquals(0, changes(), arm.calls.toString());
    }

    @Test
    void planNamesTheImageCreateVmUses() {
        var p = backend.plan(spec("web-01", "ubuntu", "eu-west"));
        assertEquals("westeurope", p.nativeRegion());
        assertEquals("Standard_B2s", p.nativeSize());
        assertTrue(p.nativeImage().contains("Canonical/ubuntu-24_04-lts/server"), p.nativeImage());
        assertTrue(AzureArmBackend.owns("arm:rg:web-01"));
        assertFalse(AzureArmBackend.owns("az-vm-123"));
    }
}
