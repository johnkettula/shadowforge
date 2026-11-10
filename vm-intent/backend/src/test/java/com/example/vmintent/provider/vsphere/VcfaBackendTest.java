package com.example.vmintent.provider.vsphere;

import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.VmStatus;
import com.fasterxml.jackson.databind.JsonNode;
import io.temporal.failure.ApplicationFailure;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VcfaBackendTest {

    private MockVcfa vcfa;
    private final AtomicLong now = new AtomicLong(1_000_000);
    private VcfaBackend backend;

    static VsphereProperties props(String url, String auth) {
        VsphereProperties.Datacenter dc2 = new VsphereProperties.Datacenter("vcf-automation", null, null, null, null, null, null, null, null,
                "vm-intent-standard", Map.of("windows", "win-server"), null,
                Map.of("cpuCount", "{vcpu}", "totalMemoryMB", "{memoryMiB}", "image", "{os}-{osVersion}", "env", "{env}", "label", "vm {name}"));
        return new VsphereProperties("simulated", null,
                new VsphereProperties.Automation(url, "vm-apps", MockVcfa.API_TOKEN, auth, null, "vm-intent", null, 5),
                Map.of("dc2", dc2));
    }

    static VmSpec spec(String name) {
        return new VmSpec(name, "vsphere", "dc2", 4, 16, "ubuntu", "24.04", 50, "ssd", "test", 14, false);
    }

    @BeforeEach
    void setUp() throws Exception {
        vcfa = new MockVcfa();
        VsphereProperties p = props(vcfa.url(), null);
        backend = new VcfaBackend(p, new VcfAutomationClient(p.automation(), now::get));
    }

    @AfterEach
    void tearDown() {
        vcfa.close();
    }

    static final String HASH = "9f86d081884c7d65", OTHER_HASH = "60303ae22b998861";

    private long requests() {
        return vcfa.calls.stream().filter(c -> c.startsWith("POST /blueprint/api/blueprint-requests")).count();
    }

    private boolean anyDelete() {
        return vcfa.calls.stream().anyMatch(c -> c.startsWith("DELETE "));
    }

    @Test
    void theBuildKeyIsReadBackFromTheDeploymentsDescription() {
        assertEquals(HASH + "-run00001", VcfaBackend.recordedKey("vm-intent build (test), key " + HASH + "-run00001"));
        assertNull(VcfaBackend.recordedKey("Made by hand for the monkey key team"));
        assertNull(VcfaBackend.recordedKey(null));
    }

    @Test
    void aNewRunOfTheSameSpecAdoptsTheDeploymentItAskedFor() {
        String id = backend.createVm(spec("api-10"), VmIdentity.buildKey(HASH, "run00001"));
        assertEquals(id, backend.createVm(spec("api-10"), VmIdentity.buildKey(HASH, "run00002")));
        assertEquals(1, vcfa.deployments.size());
        assertEquals(1, requests(), "no second blueprint request");
    }

    @Test
    void aDeploymentBuiltForAnotherSpecIsRefusedAndLeftAlone() {
        backend.createVm(spec("api-11"), VmIdentity.buildKey(HASH, "run00001"));
        MockVcfa.Dep d = vcfa.byName("api-11");
        ApplicationFailure e = assertThrows(ApplicationFailure.class,
                () -> backend.createVm(spec("api-11"), VmIdentity.buildKey(OTHER_HASH, "run00002")));
        assertEquals("InvalidSpec", e.getType());
        assertTrue(e.isNonRetryable());
        assertTrue(e.getOriginalMessage().contains("another request"), e.getOriginalMessage());
        assertEquals(1, vcfa.deployments.size());
        assertEquals(1, requests(), "nothing requested");
        assertEquals("CREATE_INPROGRESS", d.status, "not removed");
        assertFalse(anyDelete(), vcfa.calls.toString());
    }

    @Test
    void aDeploymentWithoutAVmIntentKeyIsRefused() {
        // VCF Automation has no ownership tag: a same-named deployment without our key isn't ours.
        MockVcfa.Dep d = vcfa.addDeployment("legacy-01", "Made by hand");
        ApplicationFailure e = assertThrows(ApplicationFailure.class,
                () -> backend.createVm(spec("legacy-01"), VmIdentity.buildKey(HASH, "run00001")));
        assertEquals("InvalidSpec", e.getType());
        assertTrue(e.isNonRetryable());
        assertTrue(e.getOriginalMessage().contains("didn't build"), e.getOriginalMessage());
        assertEquals(1, vcfa.deployments.size());
        assertEquals(0, requests(), "nothing requested");
        assertEquals("CREATE_SUCCESSFUL", d.status, "not removed");
        assertFalse(anyDelete(), vcfa.calls.toString());
    }

    @Test
    void signsInWithTheApiTokenForTheOrgAndRenewsTheAccessToken() {
        backend.client().projectId();
        assertEquals(1, vcfa.tokenGrants.size());
        String grant = vcfa.tokenGrants.get(0);
        assertTrue(grant.startsWith("vm-apps ") && grant.contains("grant_type=refresh_token") && grant.contains("refresh_token=" + MockVcfa.API_TOKEN), grant);
        backend.client().blueprints();
        assertEquals(1, vcfa.tokenGrants.size(), "the access token is reused");
        now.addAndGet(3600_000);
        backend.client().blueprints();
        assertEquals(2, vcfa.tokenGrants.size(), "renewed after an hour");
        vcfa.tokens.clear();
        backend.client().blueprints();
        assertEquals(3, vcfa.tokenGrants.size(), "and again when the server says 401");
    }

    @Test
    void ariaAutomation8StyleSignInWorksToo() throws Exception {
        VsphereProperties p = props(vcfa.url(), "iaas-login");
        VcfaBackend b = new VcfaBackend(p, new VcfAutomationClient(p.automation(), now::get));
        assertEquals("proj-7", b.client().projectId());
        assertTrue(vcfa.calls.contains("POST /iaas/api/login"));
    }

    @Test
    void aVmRequestBecomesABlueprintRequestWithFilledInInputs() {
        String id = backend.createVm(spec("api-01"), "key-1");
        MockVcfa.Dep d = vcfa.byName("api-01");
        assertEquals("vcfa:" + d.id, id);
        JsonNode r = d.request;
        assertEquals("bp-1", r.path("blueprintId").asText());
        assertEquals("3", r.path("blueprintVersion").asText(), "the newest RELEASED version (4 is only VERSIONED)");
        assertEquals("proj-7", r.path("projectId").asText(), "project found by name");
        assertEquals(4, r.path("inputs").path("cpuCount").asInt());
        assertTrue(r.path("inputs").path("cpuCount").isNumber(), "numbers are sent as numbers");
        assertEquals(16384, r.path("inputs").path("totalMemoryMB").asLong());
        assertEquals("ubuntu-24.04", r.path("inputs").path("image").asText());
        assertEquals("vm api-01", r.path("inputs").path("label").asText());
        assertTrue(r.path("reason").asText().contains("key-1"));
        assertFalse(vcfa.missingApiVersion, "apiVersion sent on every blueprint and deployment call");
    }

    @Test
    void aRetriedCreateFindsTheDeploymentItAlreadyAskedFor() {
        String a = backend.createVm(spec("api-02"), "key-2");
        String b = backend.createVm(spec("api-02"), "key-2");
        assertEquals(a, b);
        assertEquals(1, vcfa.deployments.size());
    }

    @Test
    void statusFollowsTheDeploymentToTheMachinesAddress() {
        String id = backend.createVm(spec("api-03"), "k");
        VmStatus s = backend.describeVm(id);
        assertEquals("PENDING", s.state());
        s = backend.describeVm(id);
        assertEquals("RUNNING", s.state());
        assertEquals("10.20.0.10", s.ipAddress());
    }

    @Test
    void aFailedDeploymentIsReportedWithItsReason() {
        vcfa.failNames.add("api-04");
        String id = backend.createVm(spec("api-04"), "k");
        backend.describeVm(id);
        VmStatus s = backend.describeVm(id);
        assertEquals("FAILED", s.state());
        assertTrue(s.detail().contains("no placement"), s.detail());
    }

    @Test
    void dayTwoUsesTheMachinesActions() {
        String id = running("api-05");
        backend.setPower(id, false);
        backend.setPower(id, false); // already off: no second request
        backend.resizeVm(id, 8, 32);
        backend.snapshotVm(id, "pre-patch");
        List<String> actionIds = vcfa.actions.stream().map(a -> a.path("actionId").asText()).toList();
        assertEquals(List.of("Cloud.vSphere.Machine.PowerOff", "Cloud.vSphere.Machine.Resize", "Cloud.vSphere.Machine.Snapshot.Create"), actionIds);
        assertEquals(32768, vcfa.actions.get(1).path("inputs").path("totalMemoryMB").asLong());
        assertEquals("pre-patch", vcfa.actions.get(2).path("inputs").path("name").asText());
    }

    @Test
    void removeAndList() {
        String id = running("api-06");
        assertEquals(List.of(id), backend.listVmIds());
        backend.deleteVm(id);
        assertTrue(vcfa.calls.stream().anyMatch(c -> c.startsWith("DELETE /deployment/api/deployments/" + id.substring(5))));
        backend.deleteVm(id); // a second remove is harmless
    }

    @Test
    void perOsBlueprintAndMissingBlueprintAreClear() {
        VmSpec win = new VmSpec("win-01", "vsphere", "dc2", 4, 16, "windows", "2022", 80, "ssd", "test", 14, false);
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.createVm(win, "k"));
        assertTrue(e.getOriginalMessage().contains("win-server"), "the windows blueprint was looked for: " + e.getOriginalMessage());
        assertTrue(e.isNonRetryable());
    }

    @Test
    void blueprintStepStartsTracksAndReportsEveryMachine() {
        Map<String, Object> started = backend.startBlueprint("three-tier", null, "shop-prod", Map.of("size", "medium"), "test");
        assertEquals(false, started.get("reused"));
        assertEquals("3", started.get("version"));
        String dep = (String) started.get("deploymentId");
        assertEquals("IN_PROGRESS", backend.blueprintStatus(dep).get("state"));
        Map<String, Object> done = backend.blueprintStatus(dep);
        assertEquals("SUCCESSFUL", done.get("state"));
        assertEquals(List.of("10.20.0.10", "10.20.0.11", "10.20.0.12"), done.get("addresses"));
        assertEquals(4, ((List<?>) done.get("resources")).size(), "3 machines and a network");
        assertEquals(true, backend.startBlueprint("three-tier", null, "shop-prod", Map.of(), "again").get("reused"), "partial work: found, not asked for twice");
    }

    @Test
    void aFailedBlueprintDeploymentIsRemovedBeforeAskingAgain() {
        vcfa.failNames.add("bad-app");
        String dep = (String) backend.startBlueprint("vm-intent-standard", "1", "bad-app", Map.of(), "test").get("deploymentId");
        backend.blueprintStatus(dep);
        assertEquals("FAILED", backend.blueprintStatus(dep).get("state"));
        vcfa.failNames.clear();
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> backend.startBlueprint("vm-intent-standard", "1", "bad-app", Map.of(), "retry"));
        assertEquals("CloudBusy", e.getType(), "retried by Temporal once the old one is gone");
        backend.blueprintStatus(dep); // the mock finishes removing it
        Map<String, Object> again = backend.startBlueprint("vm-intent-standard", "1", "bad-app", Map.of(), "retry");
        assertEquals(false, again.get("reused"));
        assertEquals("1", again.get("version"), "the version the step asked for");
    }

    private String running(String name) {
        String id = backend.createVm(spec(name), "key-" + name);
        backend.describeVm(id);
        assertEquals("RUNNING", backend.describeVm(id).state());
        return id;
    }
}
