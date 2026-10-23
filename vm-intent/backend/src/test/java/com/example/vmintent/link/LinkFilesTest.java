package com.example.vmintent.link;

import com.example.vmintent.db.AuditLog;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.TestFakes;
import com.example.vmintent.workflow.VmReconcileWorkflow;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.client.WorkflowOptions;
import io.temporal.testing.TestEnvironmentOptions;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The real file-based link: LinkActivitiesImpl writes the order to the outbox, Domain3Simulator
 * answers into the inbox, and ReturnLinkListener signals the waiting workflow. Real time here
 * (no time skipping), because files and threads are involved; it takes a few seconds.
 */
class LinkFilesTest {

    @TempDir
    Path dir;

    private TestWorkflowEnvironment env;
    private ReturnLinkListener listener;
    private Domain3Simulator domain3;
    private final List<String> audit = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() {
        LinkProperties props = new LinkProperties("gcp", dir.resolve("outbox"), dir.resolve("inbox"), 5, true, 1);
        ObjectMapper json = new ObjectMapper();
        env = TestWorkflowEnvironment.newInstance(TestEnvironmentOptions.newBuilder().setUseTimeskipping(false).build());
        TestFakes.startWorkers(env, new TestFakes.FakeCloud(), new TestFakes.FakeRecords(), new LinkActivitiesImpl(props, json));
        AuditLog log = new AuditLog(null) {
            @Override
            public void record(String requestId, String specHash, String event, String actor, String detail) {
                audit.add(event + " " + detail);
            }
        };
        listener = new ReturnLinkListener(props, env.getWorkflowClient(), log, json);
        domain3 = new Domain3Simulator(props, json);
        listener.start();
        domain3.start();
    }

    @AfterEach
    void tearDown() {
        domain3.stop();
        listener.stop();
        env.close();
    }

    @Test
    void anOrderGoesOutAndItsAnswerComesBack() throws Exception {
        VmSpec spec = TestFakes.spec("over-the-link", "gcp", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
        VmResult vm = wf.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req"));

        assertEquals("d3-" + hash.substring(0, 10), vm.vmId());
        assertTrue(vm.ipAddress().startsWith("172.20."));
        assertEquals(1, count(dir.resolve("outbox/carried")), "the order file was carried to domain 3");
        assertEquals(1, count(dir.resolve("inbox/done")), "the answer file was handled");
        assertTrue(audit.stream().anyMatch(a -> a.startsWith("LINK_REPLY CREATE")), audit.toString());
    }

    @Test
    void aStrayAnswerIsSetAsideAndAudited() throws Exception {
        Files.createDirectories(dir.resolve("inbox"));
        Files.writeString(dir.resolve("inbox/late.json"), """
                {"orderId":"create-123","type":"CREATE","replyTo":"vm-nobody","idempotencyKey":"abc-1","specHash":"abc",
                 "ok":true,"vmId":"d3-late","ipAddress":"172.20.1.1","detail":"built in domain 3"}""");
        Files.writeString(dir.resolve("inbox/junk.json"), "not json");
        assertEquals(2, listener.poll());
        assertEquals(1, count(dir.resolve("inbox/unmatched")));
        assertEquals(1, count(dir.resolve("inbox/bad")));
        assertTrue(audit.stream().anyMatch(a -> a.startsWith("LINK_REPLY_UNMATCHED vm-nobody")), audit.toString());
    }

    private static long count(Path folder) throws Exception {
        if (!Files.isDirectory(folder)) return 0;
        try (Stream<Path> s = Files.list(folder)) {
            return s.count();
        }
    }
}
