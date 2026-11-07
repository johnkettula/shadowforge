package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.BatchBody;
import com.example.vmintent.api.ApiModels.BatchItemBody;
import com.example.vmintent.api.ApiModels.TextBody;
import com.example.vmintent.config.SearchAttributesSetup;
import com.example.vmintent.db.AuditLog;
import com.example.vmintent.db.BatchStore;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.intent.RuleBasedIntentExtractor;
import com.example.vmintent.legacy.LegacySpecTranslator;
import com.example.vmintent.legacy.LegacyVmDefinition;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.spec.HashOwnerSpy;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.IntentActivities;
import com.example.vmintent.workflow.IntentWorkflow;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.TestFakes;
import com.example.vmintent.workflow.WorkflowActivitiesImpl;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The owner each hash site gets comes from sign-in on the server: "anonymous" with sign-in off,
 * whatever userId or requestedBy the body claims; the signed-in name otherwise. The audit names
 * (userId, requestedBy) keep their meaning. (The catalog path is in CatalogRunWorkflowTest.)
 */
class RequestOwnerFlowTest {

    /** The real interpret and expand activities, recording the owner they get and the owner VmIdentity.hash gets. */
    static class RecordingIntent implements IntentActivities {
        final WorkflowActivitiesImpl real =
                new WorkflowActivitiesImpl(new IntentInterpreter(new RuleBasedIntentExtractor()), null, null);
        final List<String> calls = new CopyOnWriteArrayList<>();
        final List<String> hashOwners = Collections.synchronizedList(new ArrayList<>());

        @Override
        public Interpretation interpret(String text, String owner) {
            calls.add("interpret " + owner);
            return HashOwnerSpy.recording(hashOwners, () -> real.interpret(text, owner));
        }

        @Override
        public String findExistingVm(String specHash) {
            return null;
        }

        @Override
        public List<BatchItem> expand(Interpretation interpretation, String owner) {
            calls.add("expand " + owner);
            return HashOwnerSpy.recording(hashOwners, () -> real.expand(interpretation, owner));
        }
    }

    private TestWorkflowEnvironment env;
    private RecordingIntent intent;
    private RequestController requests;
    private BatchController batches;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        intent = new RecordingIntent();
        TestFakes.startWorkers(env, new TestFakes.FakeCloud(), new TestFakes.FakeRecords(), new TestFakes.FakeLink(), intent);
        IntentInterpreter interpreter = new IntentInterpreter(new RuleBasedIntentExtractor());
        VmRegistry noVms = new VmRegistry(null, new ObjectMapper()) {
            @Override
            public VmRecord get(String specHash) {
                return null;
            }
        };
        AuditLog noAudit = new AuditLog(null) {
            @Override
            public void record(String requestId, String specHash, String event, String actor, String detail) {}
        };
        BatchStore noBatches = new BatchStore(null) {
            @Override
            public void create(String batchId, int total, int shardSize, String requestedBy) {}
        };
        requests = new RequestController(env.getWorkflowClient(), interpreter, new LegacySpecTranslator(interpreter),
                noVms, noAudit, new SearchAttributesSetup(env.getWorkflowClient(), "off"), null);
        batches = new BatchController(env.getWorkflowClient(), interpreter, noVms, noBatches);
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
        env.close();
    }

    @Test
    void submitPassesAnonymousWhateverUserIdSays() {
        IntentWorkflow wf = submit("small debian vm on azure", "mallory");
        RequestStatus s = waitFor(wf, "AWAITING_CONFIRMATION");
        assertEquals(List.of("interpret anonymous"), intent.calls);
        assertEquals(List.of("anonymous"), intent.hashOwners);
        assertEquals("mallory", s.requestedBy(), "userId is still the name in the audit trail");
    }

    @Test
    void submitPassesTheSignedInName() {
        RequestOwnerTest.signIn("alice");
        IntentWorkflow wf = submit("small debian vm on azure", "mallory");
        RequestStatus s = waitFor(wf, "AWAITING_CONFIRMATION");
        assertEquals(List.of("interpret alice"), intent.calls);
        assertEquals(List.of("alice"), intent.hashOwners);
        assertEquals("alice", s.requestedBy());
    }

    @Test
    void multiVmExpandPassesAnonymous() {
        IntentWorkflow wf = submit("3 small ubuntu servers on aws", "mallory");
        RequestStatus s = waitFor(wf, "AWAITING_CONFIRMATION");
        requests.confirm(s.requestId(), null);
        assertEquals("COMPLETED", WorkflowStub.fromTyped(wf).getResult(RequestStatus.class).state());
        assertEquals(List.of("interpret anonymous", "expand anonymous"), intent.calls);
        assertEquals(List.of("anonymous", "anonymous", "anonymous", "anonymous"), intent.hashOwners,
                "one hash for the interpretation, one for each of the three VMs");
    }

    @Test
    void batchPassesAnonymousWhateverRequestedBySays() {
        List<String> owners = new ArrayList<>();
        ResponseEntity<?> r = HashOwnerSpy.recording(owners, () -> batches.submit(batchOf("mallory")));
        assertEquals(HttpStatus.ACCEPTED, r.getStatusCode());
        assertEquals(List.of("anonymous", "anonymous"), owners, "the text item and the spec item");
    }

    @Test
    void batchPassesTheSignedInName() {
        RequestOwnerTest.signIn("alice");
        List<String> owners = new ArrayList<>();
        HashOwnerSpy.recording(owners, () -> batches.submit(batchOf("mallory")));
        assertEquals(List.of("alice", "alice"), owners);
    }

    @Test
    void previewAndLegacyCreatePassTheServerSideOwner() {
        List<String> owners = new ArrayList<>();
        HashOwnerSpy.recording(owners, () -> requests.preview(new TextBody("small debian vm on azure", "mallory")));
        LegacyVmDefinition legacy = new ObjectMapper().convertValue(Map.of("cloud", "aws", "location", "us-east",
                "cpu", 2, "ramGb", 4, "image", Map.of("os", "ubuntu", "version", "24.04"), "environment", "dev"),
                LegacyVmDefinition.class);
        ResponseEntity<?> r = HashOwnerSpy.recording(owners, () -> requests.legacyCreate(legacy));
        assertEquals(HttpStatus.ACCEPTED, r.getStatusCode(), String.valueOf(r.getBody()));
        assertEquals(List.of("anonymous", "anonymous"), owners);

        RequestOwnerTest.signIn("alice");
        owners.clear();
        HashOwnerSpy.recording(owners, () -> requests.preview(new TextBody("small debian vm on azure", "mallory")));
        assertEquals(List.of("alice"), owners);
    }

    private static BatchBody batchOf(String requestedBy) {
        VmSpec spec = new VmSpec(null, "vsphere", "dc1", 4, 16, "rhel", "9", 100, "standard", "prod", 7, false);
        return new BatchBody(List.of(new BatchItemBody("small debian vm on azure", null), new BatchItemBody(null, spec)),
                null, null, requestedBy);
    }

    private IntentWorkflow submit(String text, String userId) {
        String id = requests.submit(new TextBody(text, userId)).requestId();
        return env.getWorkflowClient().newWorkflowStub(IntentWorkflow.class, id);
    }

    private static RequestStatus waitFor(IntentWorkflow wf, String state) {
        for (int i = 0; i < 100; i++) {
            try {
                RequestStatus s = wf.status();
                if (state.equals(s.state())) return s;
            } catch (Exception notYet) {
                // The workflow hasn't run its first step yet.
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
        }
        throw new AssertionError("timed out waiting for state " + state);
    }
}
