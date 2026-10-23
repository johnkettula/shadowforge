package com.example.vmintent.workflow;

import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.InventoryFinding;
import com.example.vmintent.workflow.Models.InventoryReport;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The nightly check: a VM that vanished from its cloud, and one nobody recorded. */
class InventoryCheckTest {

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;
    private TestFakes.FakeLink link;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
        link = new TestFakes.FakeLink();
        link.oneWay.add("vsphere");
        TestFakes.startWorkers(env, cloud, records, link);
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void findsMissingVmsAndOrphans() throws Exception {
        String kept = build("kept");
        String gone = build("gone");
        cloud.vanished.add(records.results.get(gone).vmId());   // someone deleted it in the AWS console
        cloud.extra.add("i-handmade");                          // and made one by hand

        InventoryCheckWorkflow check = env.getWorkflowClient().newWorkflowStub(InventoryCheckWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("inventory-check-test").build());
        InventoryReport report = check.run();

        assertEquals(1, report.missingCount());
        assertEquals(1, report.orphanCount());
        InventoryFinding aws = report.findings().stream().filter(f -> f.provider().equals("aws")).findFirst().orElseThrow();
        assertEquals(java.util.List.of(gone), aws.missing());
        assertEquals(java.util.List.of("i-handmade"), aws.orphans());
        assertEquals(2, aws.recordedRunning());
        InventoryFinding vsphere = report.findings().stream().filter(f -> f.provider().equals("vsphere")).findFirst().orElseThrow();
        assertTrue(vsphere.note().contains("one-way link"), "can't look into domain 3");

        assertEquals("MISSING", records.state.get(gone));
        assertEquals("RUNNING", records.state.get(kept));
        // The missing VM's lifecycle workflow was told, and has stopped.
        WorkflowStub life = env.getWorkflowClient().newUntypedWorkflowStub(VmLifecycleWorkflowImpl.workflowId(gone));
        life.getResult(10, java.util.concurrent.TimeUnit.SECONDS, Void.class);
        assertEquals("MISSING", records.lifecycles.get(gone).state());
        assertTrue(!cloud.deleted.contains(records.results.get(gone).vmId()), "nothing was deleted");
    }

    private String build(String name) {
        VmSpec spec = TestFakes.spec(name, "aws", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
        VmResult r = wf.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-" + name));
        LifecycleWorkflowTest.eventually(() -> records.lifecycles.containsKey(hash), "lifecycle started");
        return hash;
    }
}
