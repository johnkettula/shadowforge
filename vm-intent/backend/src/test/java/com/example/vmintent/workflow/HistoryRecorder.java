package com.example.vmintent.workflow;

import com.google.protobuf.util.JsonFormat;
import io.temporal.client.WorkflowClient;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Saves a workflow's history from a test as a file ReplayTest replays, so a history can be recorded
 * in the repository instead of from a real server.
 *
 * It only writes when the tests run with -Dhistories.record=true, and only a file that isn't there
 * yet: saved histories are what running workflows look like, so they are never overwritten or deleted.
 *   mvn test -Dhistories.record=true
 */
final class HistoryRecorder {

    static final String PROPERTY = "histories.record";
    /** Where the histories live, relative to backend/ (Maven runs the tests from there). */
    static final Path DIR = Path.of("src", "test", "resources", "histories");

    private HistoryRecorder() {
    }

    /** Writes histories/&lt;name&gt;.json if recording is on and the file is missing. True if it wrote one. */
    static boolean record(WorkflowClient client, String workflowId, String name) throws IOException {
        return record(client, workflowId, name, DIR);
    }

    static boolean record(WorkflowClient client, String workflowId, String name, Path dir) throws IOException {
        if (!name.matches("[a-z0-9][a-z0-9-]*")) throw new IllegalArgumentException("not a history name: " + name);
        if (!"true".equals(System.getProperty(PROPERTY))) return false;
        Path file = dir.resolve(name + ".json");
        if (Files.exists(file)) return false;
        // Standard protobuf JSON, the same format as the Temporal CLI's --output json.
        String json = JsonFormat.printer().print(client.fetchHistory(workflowId).getHistory());
        Files.createDirectories(dir);
        // CREATE_NEW: fails rather than overwrite a file that appeared in the meantime.
        Files.writeString(file, json + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        return true;
    }
}
