package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.BatchBody;
import com.example.vmintent.api.ApiModels.BatchItemBody;
import com.example.vmintent.api.ApiModels.BatchSubmitResponse;
import com.example.vmintent.api.ApiModels.TextBody;
import com.example.vmintent.audit.DecisionLog;
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
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.BatchShardWorkflow;
import com.example.vmintent.workflow.IntentActivities;
import com.example.vmintent.workflow.IntentWorkflow;
import com.example.vmintent.workflow.Models.BatchInfo;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.ShardProgress;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.Models.VmResult;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The owner each hash site gets comes from sign-in on the server: "anonymous" with sign-in off,
 * whatever userId or requestedBy the body claims; the signed-in name otherwise. The audit names
 * (userId, requestedBy) keep their meaning. A signed-in owner's hash covers the owner, so two users'
 * same request builds two VMs and only the same user's repeat is a duplicate. (The catalog path is
 * in CatalogRunWorkflowTest.)
 */
class RequestOwnerFlowTest {

    /** The real interpret and expand activities, recording the owner they get and the owner VmIdentity.hash gets. */
    static class RecordingIntent implements IntentActivities {
        final WorkflowActivitiesImpl real =
                new WorkflowActivitiesImpl(new IntentInterpreter(new RuleBasedIntentExtractor()), null, null);
        final List<String> calls = new CopyOnWriteArrayList<>();
        final List<String> hashOwners = Collections.synchronizedList(new ArrayList<>());
        final TestFakes.FakeRecords records;

        RecordingIntent(TestFakes.FakeRecords records) {
            this.records = records;
        }

        @Override
        public Interpretation interpret(String text, String owner) {
            calls.add("interpret " + owner);
            return HashOwnerSpy.recording(hashOwners, () -> real.interpret(text, owner));
        }

        @Override
        public String findExistingVm(String specHash) {
            return records.existingVm(specHash);
        }

        @Override
        public List<BatchItem> expand(Interpretation interpretation, String owner) {
            calls.add("expand " + owner);
            return HashOwnerSpy.recording(hashOwners, () -> real.expand(interpretation, owner));
        }
    }

    private TestWorkflowEnvironment env;
    private RecordingIntent intent;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;
    private RequestController requests;
    private BatchController batches;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
        intent = new RecordingIntent(records);
        TestFakes.startWorkers(env, cloud, records, new TestFakes.FakeLink(), intent);
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
        DecisionLog noDecisions = new DecisionLog(null, null) {
            @Override
            public void record(String actor, String roles, String action, String resource, boolean allowed,
                               String policy, String reason, String classificationCode) {}
        };
        requests = new RequestController(env.getWorkflowClient(), interpreter, new LegacySpecTranslator(interpreter),
                noVms, noAudit, new SearchAttributesSetup(env.getWorkflowClient(), "off"), noDecisions);
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

    // ------------------------------------------------------------------ per-user identity

    static final String WEB_01 = "a small ubuntu server on aws called web-01";
    static final VmSpec SHARED = new VmSpec("shared-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 80, "ssd", "test", 7, false);

    @Test
    void aSecondUsersSameRequestBuildsItsOwnVmAndTheFirstUsersRepeatIsADuplicate() {
        RequestOwnerTest.signIn("alice");
        RequestStatus a = requestAndConfirm(WEB_01);
        assertEquals("COMPLETED", a.state(), a.message());
        String aliceHash = a.interpretation().specHash();
        assertEquals(VmIdentity.hash(a.interpretation().spec(), "alice"), aliceHash);
        assertEquals(1, cloud.createdCount());

        RequestOwnerTest.signIn("bob");
        RequestStatus b = requestAndConfirm(WEB_01);
        assertEquals("COMPLETED", b.state(), "not DUPLICATE: alice's VM isn't bob's. " + b.message());
        String bobHash = b.interpretation().specHash();
        assertNotEquals(aliceHash, bobHash);
        assertEquals(2, cloud.createdCount(), "bob got a VM of his own");
        assertNotEquals(a.vm().vmId(), b.vm().vmId());
        assertEquals(a.vm().vmId(), builtBy(aliceHash).vmId(), "alice's VM came from vm-<alice's hash>");
        assertEquals(b.vm().vmId(), builtBy(bobHash).vmId(), "bob's VM came from vm-<bob's hash>");

        RequestOwnerTest.signIn("alice");
        RequestStatus again = requestAndConfirm(WEB_01);
        assertEquals("DUPLICATE", again.state(), again.message());
        assertEquals(aliceHash, again.interpretation().specHash());
        assertEquals(2, cloud.createdCount(), "nothing new was built");
    }

    @Test
    void aSecondUsersSameBatchItemBuildsItsOwnVmAndTheFirstUsersRepeatIsADuplicate() {
        RequestOwnerTest.signIn("alice");
        ShardProgress a = runBatch(SHARED);
        assertEquals(1, a.running());
        assertEquals(1, cloud.createdCount());

        RequestOwnerTest.signIn("bob");
        ShardProgress b = runBatch(SHARED);
        assertEquals(1, b.running(), "not a duplicate of alice's VM");
        assertEquals(0, b.duplicate());
        assertEquals(2, cloud.createdCount());
        String aliceHash = VmIdentity.hash(SHARED, "alice");
        String bobHash = VmIdentity.hash(SHARED, "bob");
        assertNotEquals(aliceHash, bobHash);
        assertNotEquals(builtBy(aliceHash).vmId(), builtBy(bobHash).vmId(), "each user's own vm-<hash> build");
        assertNotNull(records.existingVm(aliceHash));
        assertNotNull(records.existingVm(bobHash));
        assertNull(records.existingVm(SpecCanonicalizer.hash(SHARED)), "no anonymous VM was built");

        RequestOwnerTest.signIn("alice");
        ShardProgress again = runBatch(SHARED);
        assertEquals(0, again.running());
        assertEquals(1, again.duplicate(), "alice's repeat is a duplicate");
        assertEquals(2, cloud.createdCount(), "nothing new was built");
    }

    @Test
    void aUserIdOrRequestedByInTheBodyDoesNotChangeTheHash() {
        // Sign-in off: whatever the body claims, the hash is the anonymous one (the spec's own hash).
        RequestStatus r = requestAndConfirm(WEB_01, "mallory");
        assertEquals("COMPLETED", r.state(), r.message());
        assertEquals("mallory", r.requestedBy());
        assertEquals(SpecCanonicalizer.hash(r.interpretation().spec()), r.interpretation().specHash());
        RequestStatus same = requestAndConfirm(WEB_01, "someone-else");
        assertEquals("DUPLICATE", same.state(), "another userId is the same anonymous VM");
        assertEquals(r.interpretation().specHash(), same.interpretation().specHash());

        assertEquals(1, runBatch(SHARED, "mallory").running());
        assertNotNull(records.existingVm(SpecCanonicalizer.hash(SHARED)), "built under the anonymous hash");
        assertEquals(1, runBatch(SHARED, "someone-else").duplicate());

        // Signed in: the signed-in name counts, not the one in the body.
        RequestOwnerTest.signIn("alice");
        IntentWorkflow wf = submit(WEB_01, "mallory");
        RequestStatus s = waitFor(wf, "AWAITING_CONFIRMATION");
        assertEquals(VmIdentity.hash(s.interpretation().spec(), "alice"), s.interpretation().specHash());
        assertNotEquals(VmIdentity.hash(s.interpretation().spec(), "mallory"), s.interpretation().specHash());
    }

    private RequestStatus requestAndConfirm(String text) {
        return requestAndConfirm(text, "body-user");
    }

    private RequestStatus requestAndConfirm(String text, String userId) {
        IntentWorkflow wf = submit(text, userId);
        RequestStatus s = waitFor(wf, "AWAITING_CONFIRMATION");
        requests.confirm(s.requestId(), null);
        return WorkflowStub.fromTyped(wf).getResult(RequestStatus.class);
    }

    private ShardProgress runBatch(VmSpec spec) {
        return runBatch(spec, "body-user");
    }

    /** Submits a one-item batch, waits for it, and returns its only shard's counts. */
    private ShardProgress runBatch(VmSpec spec, String requestedBy) {
        ResponseEntity<?> r = batches.submit(new BatchBody(List.of(new BatchItemBody(null, spec)), null, null, requestedBy));
        assertEquals(HttpStatus.ACCEPTED, r.getStatusCode(), String.valueOf(r.getBody()));
        String id = ((BatchSubmitResponse) r.getBody()).batchId();
        BatchInfo info = env.getWorkflowClient().newUntypedWorkflowStub(id).getResult(BatchInfo.class);
        assertEquals(1, info.shardIds().size());
        return env.getWorkflowClient().newWorkflowStub(BatchShardWorkflow.class, info.shardIds().get(0)).progress();
    }

    /** The result of the vm-<hash> workflow that built this hash's VM. */
    private VmResult builtBy(String hash) {
        return env.getWorkflowClient().newUntypedWorkflowStub(VmIdentity.buildWorkflowId(hash)).getResult(VmResult.class);
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
