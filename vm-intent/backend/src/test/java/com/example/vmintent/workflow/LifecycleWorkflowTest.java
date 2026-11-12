package com.example.vmintent.workflow;

import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.client.WorkflowUpdateException;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The life of a VM after its build. The test server skips time, so "wait 8 days" takes a moment:
 * env.sleep(Duration.ofDays(8)) moves Temporal's clock forward and fires any timers due.
 * It only skips ahead while a timer is pending, so to wait for the workflow to end use waitForEnd.
 */
class LifecycleWorkflowTest {

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
        TestFakes.startWorkers(env, cloud, records, new TestFakes.FakeLink());
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void warnsThenRemovesTheVmWhenItExpires() {
        String hash = build("expiring", 10);
        VmLifecycleWorkflow life = life(hash);
        VmLifecycle s = life.status();
        assertEquals("ACTIVE", s.state());
        assertFalse(s.warned());

        env.sleep(Duration.ofDays(6));
        assertFalse(life.status().warned(), "no warning yet: that's 3 days before expiry");

        env.sleep(Duration.ofDays(2));   // day 8
        assertTrue(life.status().warned());
        assertTrue(records.has("EXPIRY_WARNING"));
        assertEquals("ACTIVE", life.status().state());

        waitForEnd(hash);                // skips ahead to the expiry on day 10
        assertEquals("DELETED", records.state.get(hash));
        assertTrue(cloud.deleted.contains(records.results.get(hash).vmId()));
        assertTrue(records.has("DECOMMISSIONED system Expired"));
    }

    @Test
    void renewingPushesTheExpiryBack() {
        String hash = build("renewed", 10);
        VmLifecycleWorkflow life = life(hash);
        long firstExpiry = life.status().expiresAtMs();

        env.sleep(Duration.ofDays(8));
        assertTrue(life.status().warned());
        VmLifecycle after = life.renew("jdoe", 7);
        assertEquals(firstExpiry + Duration.ofDays(7).toMillis(), after.expiresAtMs());
        assertFalse(after.warned(), "a new expiry date gets a new warning");

        env.sleep(Duration.ofDays(5));   // day 13: past the first expiry, before the new one
        assertEquals("ACTIVE", life.status().state());
        waitForEnd(hash);                // the new expiry, day 17
        assertEquals("DELETED", records.state.get(hash));
        assertTrue(records.has("RENEWED jdoe 7 days"));
    }

    @Test
    void validatorsRefuseBadChangesWithoutTouchingTheVm() {
        String hash = build("checked", 10);
        VmLifecycleWorkflow life = life(hash);

        assertRefused(() -> life.renew("jdoe", 0), "1 to 90 days");
        assertRefused(() -> life.renew("jdoe", 400), "1 to 90 days");
        assertRefused(() -> life.resize("jdoe", 2, 4), "already has that size");
        assertRefused(() -> life.resize("jdoe", 100, 4), "vCPU must be 1 to 64");
        assertRefused(() -> life.power("jdoe", true), "already on");
        assertRefused(() -> life.snapshot("jdoe", "Bad Label!"), "lowercase letters");
        assertTrue(cloud.calls.isEmpty(), "nothing was sent to the cloud");

        VmLifecycleWorkflow forever = life(build("forever", 0));
        assertEquals(0, forever.status().expiresAtMs());
        assertRefused(() -> forever.renew("jdoe", 7), "never expires");
    }

    @Test
    void dayTwoChanges() {
        String hash = build("daytwo", 30);
        VmLifecycleWorkflow life = life(hash);
        String vmId = records.results.get(hash).vmId();

        VmLifecycle s = life.resize("jdoe", 4, 16);
        assertEquals(4, s.vcpu());
        assertEquals(16, s.memoryGiB());
        s = life.power("jdoe", false);
        assertEquals("OFF", s.power());
        s = life.snapshot("jdoe", "before-upgrade");
        assertEquals(1, s.snapshots().size());
        assertTrue(s.snapshots().get(0).startsWith("snap-before-upgrade"));
        assertEquals(java.util.List.of("resize " + vmId + " 4/16", "power " + vmId + " off",
                "snapshot " + vmId + " before-upgrade"), cloud.calls);
        assertEquals(4, records.lifecycles.get(hash).vcpu(), "the inventory shows the new size");

        s = life.decommission("admin", "Project finished");
        assertEquals("DECOMMISSIONED", s.state());
        assertTrue(cloud.deleted.contains(vmId));
        waitForEnd(hash);
        // The workflow has finished, so there is nothing left to change.
        assertThrows(io.temporal.client.WorkflowNotFoundException.class, () -> life.renew("jdoe", 7));
    }

    @Test
    void theSameSpecCanBeBuiltAgainAfterItWasRemoved() {
        String hash = build("again", 30);
        String first = records.results.get(hash).vmId();
        life(hash).decommission("jdoe", "gone");
        waitForEnd(hash);
        records.lifecycles.remove(hash);

        String again = build("again", 30);
        assertEquals(hash, again);
        String second = records.results.get(hash).vmId();
        assertFalse(first.equals(second), "a new VM, not the deleted one back: " + first + " / " + second);
        assertEquals(2, cloud.created.get());
        assertEquals("ACTIVE", life(hash).status().state());
    }

    @Test
    void aFailedResizeLeavesTheSizeAsItWas() {
        String hash = build("tight", 30);
        VmLifecycleWorkflow life = life(hash);
        cloud.refuseResize = true;
        assertRefused(() -> life.resize("jdoe", 8, 32), "No capacity");
        assertEquals(2, life.status().vcpu());
        assertTrue(records.has("RESIZE_FAILED"));
        assertEquals("ACTIVE", life.status().state(), "the VM is still looked after");
    }

    // ------------------------------------------------------------------ helpers

    /** Builds a VM through the real build workflow; its lifecycle starts when it's running. */
    private String build(String name, int ttlDays) {
        VmSpec spec = TestFakes.spec(name, "aws", ttlDays);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
        VmResult r = wf.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-" + name, null));
        records.state.put(hash, "RUNNING");
        assertTrue(r.vmId().startsWith("vm-"));
        eventually(() -> records.lifecycles.containsKey(hash), "the lifecycle workflow started");
        return hash;
    }

    private VmLifecycleWorkflow life(String hash) {
        return env.getWorkflowClient().newWorkflowStub(VmLifecycleWorkflow.class, VmLifecycleWorkflowImpl.workflowId(hash));
    }

    private void waitForEnd(String hash) {
        try {
            WorkflowStub.fromTyped(life(hash)).getResult(10, java.util.concurrent.TimeUnit.SECONDS, Void.class);
        } catch (java.util.concurrent.TimeoutException e) {
            throw new AssertionError("the lifecycle workflow didn't end; state " + life(hash).status().state());
        }
    }

    /** For things another workflow does a moment later. */
    static void eventually(java.util.function.BooleanSupplier check, String what) {
        for (int i = 0; i < 100; i++) {
            if (check.getAsBoolean()) return;
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
        }
        throw new AssertionError("timed out waiting until " + what);
    }

    static void assertRefused(Runnable update, String expected) {
        WorkflowUpdateException e = assertThrows(WorkflowUpdateException.class, update::run);
        String msg = String.valueOf(e.getCause() == null ? e.getMessage() : e.getCause().getMessage());
        assertTrue(msg.contains(expected), "expected '" + expected + "' in: " + msg);
    }
}
