package com.example.vmintent.workflow;

import com.google.protobuf.util.JsonFormat;
import io.temporal.api.history.v1.History;
import io.temporal.common.WorkflowExecutionHistory;
import io.temporal.testing.WorkflowReplayer;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Replays saved histories from earlier versions of the workflows against today's code.
 *
 * Temporal rebuilds a workflow's state by re-running its code against its history. If a code
 * change makes the workflow do something different from what its history says (a new activity
 * call, a timer moved, a child workflow ID that changed), every workflow that was running during
 * the upgrade would fail. This test catches that before it ships. Changes to the workflows must be
 * wrapped in Workflow.getVersion so that old histories still replay.
 *
 * Every file in src/test/resources/histories is replayed; the workflow class comes from the file
 * name's prefix (see WORKFLOWS). To add one from a real server:
 *   temporal workflow show --workflow-id intent-... --output json > src/test/resources/histories/my-case.json
 * or from a TestWorkflowEnvironment scenario with HistoryRecorder (see RecordedHistoriesTest):
 *   mvn test -Dhistories.record=true
 */
class ReplayTest {

    /** File-name prefix to the workflow that replays it. A file with no match fails the test. */
    static final Map<String, Class<?>> WORKFLOWS = Map.of(
            "intent-", IntentWorkflowImpl.class,
            "reconcile-", VmReconcileWorkflowImpl.class,
            "catalog-", CatalogRunWorkflowImpl.class,
            "lifecycle-", VmLifecycleWorkflowImpl.class);

    /**
     * Histories recorded before the lifecycle, update and link features (intent-, reconcile-), and
     * catalog runs recorded on a real Temporal server: resumed after a failed step, torn down after
     * a failed step, and one that waited for an approval. None of them may go missing.
     */
    static final List<String> VERSION_1 = List.of(
            "intent-v1-completed", "intent-v1-cancelled", "intent-v1-open", "reconcile-v1-completed",
            "catalog-v1-resumed", "catalog-v1-torn-down", "catalog-v1-approved");

    @TestFactory
    Stream<DynamicTest> everySavedHistoryReplays() throws Exception {
        List<Path> files;
        try (Stream<Path> s = Files.list(HistoryRecorder.DIR)) {
            files = s.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList();
        }
        assertTrue(!files.isEmpty(), "no histories in " + HistoryRecorder.DIR.toAbsolutePath());
        return files.stream().map(file -> DynamicTest.dynamicTest(file.getFileName().toString(), () -> {
            String name = file.getFileName().toString().replaceFirst("\\.json$", "");
            Class<?> workflow = WORKFLOWS.entrySet().stream()
                    .filter(e -> name.startsWith(e.getKey())).map(Map.Entry::getValue).findFirst()
                    .orElseThrow(() -> new AssertionError("no workflow for history " + file.getFileName()
                            + ": its name must start with one of " + WORKFLOWS.keySet()));
            WorkflowReplayer.replayWorkflowExecution(parse(Files.readString(file, StandardCharsets.UTF_8), name), workflow);
        }));
    }

    @Test
    void theVersion1HistoriesAreAllStillThere() throws Exception {
        for (String name : VERSION_1) {
            if (!Files.exists(HistoryRecorder.DIR.resolve(name + ".json"))) fail("history " + name + " is missing");
            assertTrue(history(name).getEvents().size() > 1, name);
        }
    }

    static WorkflowExecutionHistory history(String name) throws Exception {
        try (InputStream in = ReplayTest.class.getResourceAsStream("/histories/" + name + ".json")) {
            if (in == null) throw new IllegalStateException("missing history " + name);
            return parse(new String(in.readAllBytes(), StandardCharsets.UTF_8), name);
        }
    }

    /** Standard protobuf JSON, as written by the Temporal CLI, the Temporal UI's download and HistoryRecorder. */
    static WorkflowExecutionHistory parse(String json, String name) throws Exception {
        History.Builder h = History.newBuilder();
        JsonFormat.parser().ignoringUnknownFields().merge(json, h);
        return new WorkflowExecutionHistory(h.build(), name);
    }
}
