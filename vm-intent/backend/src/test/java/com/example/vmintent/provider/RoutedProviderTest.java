package com.example.vmintent.provider;

import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.failure.ApplicationFailure;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** RoutedProvider's dispatch, with a recording fake CloudBackend and a mocked SimCloud (no database). */
class RoutedProviderTest {

    static final String FAKE_DC = "fake-dc";

    /** Records every call; its VM IDs start "fake:". */
    static class RecordingBackend implements CloudBackend {
        final List<String> calls = new ArrayList<>();
        final ProviderPlan plan = new ProviderPlan("fake region", "fake size", "fake image", "fake plan");

        @Override
        public boolean handles(String vmId) {
            return vmId != null && vmId.startsWith("fake:");
        }

        @Override
        public ProviderPlan plan(VmSpec spec) {
            calls.add("plan " + spec.name());
            return plan;
        }

        @Override
        public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
            calls.add("create " + spec.name() + " " + plan.summary() + " " + idempotencyKey);
            return "fake:" + spec.name();
        }

        @Override
        public VmStatus describeVm(String vmId) {
            calls.add("describe " + vmId);
            return new VmStatus("RUNNING", "10.0.0.9", "fake");
        }

        @Override
        public void deleteVm(String vmId) {
            calls.add("delete " + vmId);
        }

        @Override
        public void resizeVm(String vmId, int vcpu, int memoryGiB) {
            calls.add("resize " + vmId + " " + vcpu + " " + memoryGiB);
        }

        @Override
        public void setPower(String vmId, boolean on) {
            calls.add("power " + vmId + " " + on);
        }

        @Override
        public String snapshotVm(String vmId, String label) {
            calls.add("snapshot " + vmId + " " + label);
            return "fake snapshot " + label;
        }

        @Override
        public List<String> listVmIds() {
            calls.add("list");
            return List.of("fake:a", "fake:b");
        }
    }

    /** Builds in FAKE_DC go to the fake; when it isn't set up, it fails the way VsphereRoutes does. */
    static class TestProvider extends RoutedProvider {
        private final CloudBackend fake;
        private final boolean setUp;

        TestProvider(SimCloud cloud, CloudBackend fake, boolean setUp) {
            super(cloud);
            this.fake = fake;
            this.setUp = setUp;
        }

        private CloudBackend fake() {
            if (!setUp) throw ApplicationFailure.newNonRetryableFailure("Fake isn't set up", VsphereRoutes.NOT_SET_UP);
            return fake;
        }

        @Override
        protected String providerName() {
            return "test";
        }

        @Override
        protected String idPrefix() {
            return "vm-";
        }

        @Override
        protected CloudBackend backendForBuild(VmSpec spec) {
            return FAKE_DC.equals(spec.region()) ? fake() : null;
        }

        @Override
        protected List<Backend> backends() {
            return List.of(new Backend(id -> id.startsWith("fake:"), () -> setUp, this::fake));
        }
    }

    private SimCloud cloud;
    private RecordingBackend fake;
    private TestProvider provider;

    @BeforeEach
    void setUp() {
        cloud = mock(SimCloud.class);
        fake = new RecordingBackend();
        provider = new TestProvider(cloud, fake, true);
    }

    static VmSpec spec(String name, String region) {
        return new VmSpec(name, "vsphere", region, 2, 4, "ubuntu", "24.04", 40, "standard", "dev", 7, false);
    }

    @Test
    void aBuildRoutedToTheBackendUsesItsPlanAndCreate() {
        VmSpec spec = spec("app-01", FAKE_DC);

        ProviderPlan plan = provider.plan(spec);
        String vmId = provider.createVm(spec, plan, "key-1");

        assertEquals(fake.plan, plan);
        assertEquals("fake:app-01", vmId);
        assertEquals(List.of("plan app-01", "create app-01 fake plan key-1"), fake.calls);
        verifyNoInteractions(cloud);
    }

    @Test
    void aBuildWithNoBackendGoesToTheSimulator() {
        VmSpec spec = spec("app-02", "dc1");
        when(cloud.create("test", "vm-", "app-02", "key-2")).thenReturn("vm-123");

        ProviderPlan plan = provider.plan(spec);
        String vmId = provider.createVm(spec, plan, "key-2");

        assertEquals(ProviderCatalog.plan(spec), plan);
        assertEquals("vm-123", vmId);
        verify(cloud).create("test", "vm-", "app-02", "key-2");
        assertTrue(fake.calls.isEmpty());
    }

    @Test
    void laterCallsOnAHandledIdReachTheBackendAndNeverSimCloud() {
        String id = "fake:app-03";

        assertEquals("RUNNING", provider.describeVm(id).state());
        provider.resizeVm(id, 4, 8);
        provider.setPower(id, false);
        assertEquals("fake snapshot nightly", provider.snapshotVm(id, "nightly"));
        provider.deleteVm(id);

        assertEquals(List.of("describe " + id, "resize " + id + " 4 8", "power " + id + " false",
                "snapshot " + id + " nightly", "delete " + id), fake.calls);
        verifyNoInteractions(cloud);
    }

    @Test
    void laterCallsOnAnotherIdGoToTheSimulator() {
        when(cloud.describe("vm-9")).thenReturn(new VmStatus("RUNNING", "10.1.1.1", "sim"));

        assertEquals("10.1.1.1", provider.describeVm("vm-9").ipAddress());
        provider.resizeVm("vm-9", 2, 4);

        verify(cloud).describe("vm-9");
        verify(cloud).resize("vm-9", 2, 4);
        assertTrue(fake.calls.isEmpty());
    }

    @Test
    void aHandledIdWhoseBackendIsNotSetUpFailsAndNeverReachesSimCloud() {
        TestProvider notSetUp = new TestProvider(cloud, fake, false);
        String id = "fake:app-04";

        List<Executable> calls = List.of(
                () -> notSetUp.describeVm(id),
                () -> notSetUp.deleteVm(id),
                () -> notSetUp.resizeVm(id, 4, 8),
                () -> notSetUp.setPower(id, true),
                () -> notSetUp.snapshotVm(id, "x"),
                () -> notSetUp.plan(spec("app-04", FAKE_DC)),
                () -> notSetUp.createVm(spec("app-04", FAKE_DC), null, "key-4"));
        for (Executable call : calls) {
            ApplicationFailure f = assertThrows(ApplicationFailure.class, call);
            assertEquals(VsphereRoutes.NOT_SET_UP, f.getType());
            assertTrue(f.isNonRetryable());
            assertEquals("Fake isn't set up", f.getOriginalMessage());
        }
        assertTrue(fake.calls.isEmpty());
        verifyNoInteractions(cloud);
    }

    @Test
    void aBackendThatReturnsNullFailsNotSetUp() {
        RoutedProvider provider = new TestProvider(cloud, fake, true) {
            @Override
            protected List<Backend> backends() {
                return List.of(new Backend(id -> id.startsWith("fake:"), () -> false, () -> null));
            }
        };

        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> provider.describeVm("fake:x"));
        assertEquals(VsphereRoutes.NOT_SET_UP, f.getType());
        assertTrue(f.isNonRetryable());
        verifyNoInteractions(cloud);
    }

    @Test
    void listVmIdsIsTheSimulatorsPlusEverySetUpBackends() {
        when(cloud.list("test")).thenReturn(List.of("vm-1", "vm-2"));

        assertEquals(List.of("vm-1", "vm-2", "fake:a", "fake:b"), provider.listVmIds());
    }

    @Test
    void listVmIdsLeavesOutABackendThatIsNotSetUp() {
        when(cloud.list(anyString())).thenReturn(List.of("vm-1"));

        assertEquals(List.of("vm-1"), new TestProvider(cloud, fake, false).listVmIds());
        assertTrue(fake.calls.isEmpty());
    }

    @Test
    void vsphereWithNoBackendsSetUpKeepsTodaysNotSetUpFailures() {
        VsphereProvider vsphere = new VsphereProvider(cloud, new VsphereRoutes(null, null, null));

        ApplicationFailure vc = assertThrows(ApplicationFailure.class, () -> vsphere.resizeVm("vcenter:dc1:app", 2, 4));
        assertEquals(VsphereRoutes.NOT_SET_UP, vc.getType());
        assertTrue(vc.isNonRetryable());
        assertTrue(vc.getOriginalMessage().startsWith("vCenter isn't set up"), vc.getOriginalMessage());
        ApplicationFailure vcfa = assertThrows(ApplicationFailure.class, () -> vsphere.describeVm("vcfa:dep-1"));
        assertEquals(VsphereRoutes.NOT_SET_UP, vcfa.getType());
        assertTrue(vcfa.getOriginalMessage().startsWith("VCF Automation isn't set up"), vcfa.getOriginalMessage());
        verifyNoInteractions(cloud);

        when(cloud.list("vsphere")).thenReturn(List.of("vm-7"));
        assertEquals(List.of("vm-7"), vsphere.listVmIds());
    }
}
