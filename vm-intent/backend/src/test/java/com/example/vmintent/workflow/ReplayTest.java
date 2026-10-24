package com.example.vmintent.workflow;

import com.google.protobuf.util.JsonFormat;
import io.temporal.api.history.v1.History;
import io.temporal.common.WorkflowExecutionHistory;
import io.temporal.testing.WorkflowReplayer;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Replays saved histories from an earlier version of the workflows against today's code.
 *
 * Temporal rebuilds a workflow's state by re-running its code against its history. If a code
 * change makes the workflow do something different from what its history says (a new activity
 * call, a timer moved), every workflow that was running during the upgrade would fail. This test
 * catches that before it ships. Changes to the workflows must be wrapped in Workflow.getVersion
 * so that old histories still replay.
 *
 * The histories in src/test/resources/histories were recorded from the code before the
 * lifecycle, update and link features were added. To add one from a real server:
 *   temporal workflow show --workflow-id intent-... --output json > src/test/resources/histories/my-case.json
 */
class ReplayTest {

    @Test
    void completedRequestFromVersion1() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("intent-v1-completed"), IntentWorkflowImpl.class);
    }

    @Test
    void cancelledRequestFromVersion1() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("intent-v1-cancelled"), IntentWorkflowImpl.class);
    }

    @Test
    void requestStillWaitingWhenTheUpgradeHappened() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("intent-v1-open"), IntentWorkflowImpl.class);
    }

    @Test
    void completedBuildFromVersion1() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("reconcile-v1-completed"), VmReconcileWorkflowImpl.class);
    }

    // Catalog runs recorded on a real Temporal server: a run resumed after a failed step, one torn
    // down after a failed step, and one that waited for an approval.

    @Test
    void catalogRunResumedAfterAFailedStep() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("catalog-v1-resumed"), CatalogRunWorkflowImpl.class);
    }

    @Test
    void catalogRunTornDown() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("catalog-v1-torn-down"), CatalogRunWorkflowImpl.class);
    }

    @Test
    void catalogRunWithAnApproval() throws Exception {
        WorkflowReplayer.replayWorkflowExecution(history("catalog-v1-approved"), CatalogRunWorkflowImpl.class);
    }

    static WorkflowExecutionHistory history(String name) throws Exception {
        try (InputStream in = ReplayTest.class.getResourceAsStream("/histories/" + name + ".json")) {
            if (in == null) throw new IllegalStateException("missing history " + name);
            // Standard protobuf JSON, as written by the Temporal CLI and the Temporal UI's download.
            History.Builder h = History.newBuilder();
            JsonFormat.parser().ignoringUnknownFields().merge(new String(in.readAllBytes(), StandardCharsets.UTF_8), h);
            return new WorkflowExecutionHistory(h.build(), name);
        }
    }
}
