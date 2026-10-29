package com.example.vmintent.provider.vsphere;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import com.fasterxml.jackson.databind.JsonNode;
import io.temporal.failure.ApplicationFailure;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VcenterBackendTest {

    private MockVcenter vc;
    private DeployJournal.InMemory journal;
    private VcenterBackend backend;

    static VmSpec spec(String name, String os, String version, String tier) {
        return new VmSpec(name, "vsphere", "dc1", 4, 16, os, version, 50, tier, "dev", 30, false);
    }

    static VsphereProperties props(String url) {
        VsphereProperties.Datacenter dc1 = new VsphereProperties.Datacenter("vcenter", "Datacenter-1", "Cluster-A", null, null, "vm-intent",
                Map.of("ssd", "vsanDatastore", "standard", "nfs-01"),
                Map.of("ubuntu-24.04", "tpl-ubuntu-2404", "rhel-9", "tpl-rhel-9"),
                Map.of("ubuntu", "linux-dhcp"), null, null, null, null);
        return new VsphereProperties("simulated",
                new VsphereProperties.Vcenter(url, "svc@vsphere.local", "secret", null, null, null, null, 5),
                null, Map.of("dc1", dc1));
    }

    @BeforeEach
    void setUp() throws Exception {
        vc = new MockVcenter();
        journal = new DeployJournal.InMemory();
        VsphereProperties p = props(vc.url());
        backend = new VcenterBackend(p, new VcenterClient(p.vcenter()), journal);
    }

    @AfterEach
    void tearDown() {
        vc.close();
    }

    @Test
    void deploysFromTheTemplateWithPlacementSizeAndCustomization() {
        String id = backend.createVm(spec("app-01", "ubuntu", "24.04", "ssd"), "key-1");
        assertEquals("vcenter:dc1:app-01", id);
        JsonNode body = vc.deployBodies.get("app-01");
        assertNotNull(body, "deployed: " + vc.calls);
        assertEquals("group-v3", body.path("placement").path("folder").asText());
        assertEquals("domain-c8", body.path("placement").path("cluster").asText());
        assertEquals("datastore-11", body.path("disk_storage").path("datastore").asText(), "ssd tier -> vsanDatastore");
        assertEquals(4, body.path("hardware_customization").path("cpu_update").path("num_cpus").asInt());
        assertEquals(16384, body.path("hardware_customization").path("memory_update").path("memory").asLong());
        assertEquals("linux-dhcp", body.path("guest_customization").path("name").asText());
        assertTrue(body.path("powered_on").asBoolean());
        assertTrue(vc.calls.stream().anyMatch(c -> c.startsWith("POST /api/vcenter/vm-template/library-items/item-1?action=deploy&vmw-task=true")));
        assertTrue(vc.calls.stream().anyMatch(c -> c.contains("/api/vcenter/folder?names=vm-intent&type=VIRTUAL_MACHINE&datacenters=datacenter-2")),
                "folder looked up inside the datacenter: " + vc.calls);
    }

    @Test
    void aRetriedCreateDoesNotDeployTwice() {
        backend.createVm(spec("app-02", "ubuntu", "24.04", "ssd"), "key-2");
        backend.createVm(spec("app-02", "ubuntu", "24.04", "ssd"), "key-2");
        assertEquals(1, vc.tasks.size());
        // After the clone finished, a create with the same name finds our (tagged) VM instead of cloning again.
        vc.finishDeploys();
        backend.describeVm("vcenter:dc1:app-02");
        journal.forget("dc1:app-02");
        assertEquals("vcenter:dc1:app-02", backend.createVm(spec("app-02", "ubuntu", "24.04", "ssd"), "key-3"));
        assertEquals(1, vc.tasks.size());
    }

    @Test
    void statusGoesFromDeployingToWaitingForToolsToRunning() {
        String id = backend.createVm(spec("app-03", "rhel", "9.4", "standard"), "k");
        assertTrue(vc.calls.stream().anyMatch(c -> c.startsWith("POST /api/vcenter/vm-template/library-items/item-2?")),
                "rhel 9.4 used the rhel-9 template (item-2): " + vc.calls);
        VmStatus s = backend.describeVm(id);
        assertEquals("PENDING", s.state());
        assertTrue(s.detail().contains("Deploying"), s.detail());
        vc.finishDeploys();
        s = backend.describeVm(id);
        assertEquals("PENDING", s.state());
        assertTrue(s.detail().contains("VMware Tools"), s.detail());
        assertTrue(vc.tagged.contains(vc.idByName("app-03")), "tagged as vm-intent's once it appeared");
        assertEquals(List.of("vm-intent"), List.copyOf(vc.categories.values()), "tag category created on first use");
        assertEquals("managed", vc.tags.values().iterator().next()[0]);
        vc.giveIp("app-03", "10.10.0.21");
        s = backend.describeVm(id);
        assertEquals("RUNNING", s.state());
        assertEquals("10.10.0.21", s.ipAddress());
    }

    @Test
    void aFailedCloneIsReportedWithVcentersReason() {
        vc.failNextDeploy = "Insufficient disk space on datastore 'vsanDatastore'";
        String id = backend.createVm(spec("app-04", "ubuntu", "24.04", "ssd"), "k");
        VmStatus s = backend.describeVm(id);
        assertEquals("FAILED", s.state());
        assertTrue(s.detail().contains("Insufficient disk space"), s.detail());
    }

    @Test
    void aVmThatVmIntentDidNotBuildIsNeverTouched() {
        vc.addForeignVm("legacy-db");
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.createVm(spec("legacy-db", "ubuntu", "24.04", "ssd"), "k"));
        assertEquals("InvalidSpec", e.getType());
        assertThrows(ApplicationFailure.class, () -> backend.deleteVm("vcenter:dc1:legacy-db"));
        assertNotNull(vc.byName("legacy-db"));
    }

    @Test
    void missingTemplateOrDatastoreFailsClearlyWithoutRetrying() {
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.createVm(spec("w", "windows", "2022", "ssd"), "k"));
        assertEquals("InvalidSpec", e.getType());
        assertTrue(e.getOriginalMessage().contains("windows-2022"), e.getOriginalMessage());
        assertTrue(e.isNonRetryable());
    }

    @Test
    void resizePowersOffChangesAndPowersBackOn() {
        String id = running("app-05");
        backend.resizeVm(id, 8, 32);
        MockVcenter.Vm v = vc.byName("app-05");
        assertEquals(8, v.cpu);
        assertEquals(32768, v.memMiB);
        assertEquals("POWERED_ON", v.power);
        int before = vc.calls.size();
        backend.resizeVm(id, 8, 32);
        assertTrue(vc.calls.subList(before, vc.calls.size()).stream().noneMatch(c -> c.contains("/hardware/")), "same size: nothing changed");
    }

    @Test
    void powerSnapshotAndDelete() {
        String id = running("app-06");
        backend.setPower(id, false);
        assertEquals("POWERED_OFF", vc.byName("app-06").power);
        backend.setPower(id, false); // already off: no error
        backend.setPower(id, true);
        assertEquals("POWERED_ON", vc.byName("app-06").power);
        String snap = backend.snapshotVm(id, "before-upgrade");
        assertTrue(snap.contains("before-upgrade") && snap.contains("task-snap"), snap);
        assertEquals(List.of(vc.idByName("app-06") + ":before-upgrade"), vc.snapshots);
        backend.deleteVm(id);
        assertNull(vc.byName("app-06"), "powered off first, then removed");
        backend.deleteVm(id); // already gone: fine
        assertEquals("FAILED", backend.describeVm(id).state());
    }

    @Test
    void removingABuildThatIsStillCloningCancelsItsTask() {
        String id = backend.createVm(spec("app-07", "ubuntu", "24.04", "ssd"), "k");
        backend.deleteVm(id);
        assertEquals("FAILED", vc.tasks.values().iterator().next().status());
        assertTrue(journal.get("dc1:app-07").isEmpty());
    }

    @Test
    void inventoryListsOnlyVmIntentsTaggedVms() {
        running("app-08");
        vc.addForeignVm("someone-elses");
        assertEquals(List.of("vcenter:dc1:app-08"), backend.listVmIds());
    }

    @Test
    void anExpiredSessionIsRenewedAndBusyAnswersAreRetryable() {
        String id = running("app-09");
        vc.expireSessions();
        assertEquals("RUNNING", backend.describeVm(id).state(), "signed in again by itself");
        vc.busyResponses = 1;
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.describeVm(id));
        assertEquals("CloudBusy", e.getType());
        assertFalse(e.isNonRetryable(), "Temporal retries it with backoff");
    }

    @Test
    void planNamesTheRealTemplateClusterAndDatastore() {
        ProviderPlan p = backend.plan(spec("x", "ubuntu", "24.04", "standard"));
        assertTrue(p.summary().contains("tpl-ubuntu-2404"), p.summary());
        assertTrue(p.summary().contains("Cluster-A"), p.summary());
        assertTrue(p.nativeSize().contains("nfs-01"), p.nativeSize());
    }

    private String running(String name) {
        String id = backend.createVm(spec(name, "ubuntu", "24.04", "ssd"), "key-" + name);
        vc.finishDeploys();
        vc.giveIp(name, "10.10.0.50");
        assertEquals("RUNNING", backend.describeVm(id).state());
        return id;
    }
}
