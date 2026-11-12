package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.DecommissionBody;
import com.example.vmintent.api.ApiModels.PowerBody;
import com.example.vmintent.api.ApiModels.RenewBody;
import com.example.vmintent.api.ApiModels.ResizeBody;
import com.example.vmintent.api.ApiModels.SnapshotBody;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.RequestSearch;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.TestFakes;
import com.example.vmintent.workflow.VmLifecycleWorkflow;
import com.example.vmintent.workflow.VmReconcileWorkflow;
import io.temporal.api.enums.v1.IndexedValueType;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Day-2 changes: 404 for a spec hash that matches no VM, 409 for a VM that exists but can't be changed. */
class VmControllerTest {

    /** VmRegistry backed by a map instead of Postgres. */
    static class FakeRegistry extends VmRegistry {
        final Map<String, VmRecord> records = new ConcurrentHashMap<>();

        FakeRegistry() {
            super(null, null);
        }

        @Override
        public VmRecord get(String specHash) {
            return records.get(specHash);
        }
    }

    private static final String UNKNOWN = "0".repeat(64);

    private TestWorkflowEnvironment env;
    private FakeRegistry registry;
    private VmController controller;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        for (var key : RequestSearch.ALL) env.registerSearchAttribute(key.getName(), IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD);
        TestFakes.startWorkers(env, new TestFakes.FakeCloud(), new TestFakes.FakeRecords(), new TestFakes.FakeLink());
        registry = new FakeRegistry();
        // Only the workflow client and the registry are used by the changes (sign-in is off here).
        controller = new VmController(env.getWorkflowClient(), registry, null, null);
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void everyChangeOnAnUnknownSpecHashIs404() {
        for (Runnable call : changes(UNKNOWN)) {
            ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
            assertEquals(HttpStatus.NOT_FOUND, e.getStatusCode());
            assertEquals("No VM with that spec hash", e.getReason());
        }
    }

    @Test
    void aVmBuiltBeforeLifecyclesExistedIs409() {
        // A registry record, but no lifecycle workflow.
        String hash = "a".repeat(64);
        registry.records.put(hash, record(hash, TestFakes.spec("old", "aws", 30), "RUNNING"));
        for (Runnable call : changes(hash)) {
            ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
            assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
            assertEquals("This VM is running, so it can't be changed (it was built before lifecycles existed)", e.getReason());
        }
    }

    @Test
    void changesWorkOnARunningVmAndAre409OnceItIsDecommissioned() throws Exception {
        String hash = build("daytwo");
        assertEquals("OFF", controller.power(hash, new PowerBody(false)).power());
        assertEquals("DECOMMISSIONED", controller.decommission(hash, new DecommissionBody("done")).state());
        WorkflowStub.fromTyped(life(hash)).getResult(10, TimeUnit.SECONDS, Void.class);
        registry.records.put(hash, record(hash, registry.get(hash).spec(), "DELETED"));

        for (Runnable call : changes(hash)) {
            ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
            assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
            assertEquals("This VM is deleted, so it can't be changed", e.getReason());
        }
    }

    @Test
    void aMalformedSpecHashIs400() {
        for (Runnable call : changes("abc")) {
            ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
            assertEquals(HttpStatus.BAD_REQUEST, e.getStatusCode());
        }
    }

    private List<Runnable> changes(String hash) {
        return List.of(
                () -> controller.renew(hash, new RenewBody(7)),
                () -> controller.resize(hash, new ResizeBody(2, 4)),
                () -> controller.power(hash, new PowerBody(false)),
                () -> controller.snapshot(hash, new SnapshotBody("x")),
                () -> controller.decommission(hash, new DecommissionBody(null)));
    }

    /** Builds a VM through the real build workflow and records it, then waits for its lifecycle to start. */
    private String build(String name) {
        VmSpec spec = TestFakes.spec(name, "aws", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
        wf.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-" + name, null));
        registry.records.put(hash, record(hash, spec, "RUNNING"));
        for (int i = 0; i < 100; i++) {
            try {
                VmLifecycle s = life(hash).status();
                if ("ACTIVE".equals(s.state())) return hash;
            } catch (Exception notYet) {
                // The lifecycle workflow hasn't started yet.
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
        }
        throw new AssertionError("the lifecycle workflow didn't start");
    }

    private VmLifecycleWorkflow life(String hash) {
        return env.getWorkflowClient().newWorkflowStub(VmLifecycleWorkflow.class, "life-" + hash);
    }

    private static VmRecord record(String hash, VmSpec spec, String state) {
        return new VmRecord(hash, spec, state, null, null, null, null);
    }
}
