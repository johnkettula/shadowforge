package com.example.vmintent.link;

import com.example.vmintent.db.AuditLog;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Watches the inbox, where the return link drops domain 3's answers, and hands each answer to the
 * workflow waiting for it (a Temporal signal to the workflow ID named in the answer).
 *
 * Each file moves on when handled: processing/ while it's being read (so two copies of this app
 * never handle the same file), then done/, unmatched/ (no such workflow, or it already ended:
 * for example it gave up waiting) or bad/ (not a readable answer). Every answer is also written
 * to the audit trail, so a late one is never lost.
 *
 * Only runs when vmintent.link.one-way-providers names at least one cloud.
 */
@Component
public class ReturnLinkListener implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(ReturnLinkListener.class);

    private final LinkProperties props;
    private final WorkflowClient client;
    private final AuditLog audit;
    private final ObjectMapper json;
    private ScheduledExecutorService timer;

    public ReturnLinkListener(LinkProperties props, WorkflowClient client, AuditLog audit, ObjectMapper json) {
        this.props = props;
        this.client = client;
        this.audit = audit;
        this.json = json.copy().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    @Override
    public void start() {
        if (!props.enabled()) return;
        log.info("One-way link on for {}: orders to {}, answers from {}",
                props.providers(), props.outboxDir(), props.inboxDir());
        timer = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "return-link"));
        timer.scheduleWithFixedDelay(this::pollSafely, 1, 2, TimeUnit.SECONDS);
    }

    @Override
    public void stop() {
        if (timer != null) timer.shutdownNow();
        timer = null;
    }

    @Override
    public boolean isRunning() {
        return timer != null;
    }

    private void pollSafely() {
        try {
            poll();
        } catch (Exception e) {
            log.warn("Return link: {}", e.toString());
        }
    }

    /** Handles every answer waiting in the inbox. Package-private for tests. */
    int poll() throws IOException {
        Path inbox = props.inboxDir();
        Files.createDirectories(inbox);
        List<Path> files = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(inbox, "*.json")) {
            ds.forEach(files::add);
        }
        files.sort(null);
        int handled = 0;
        for (Path f : files) {
            Path working = moveTo(f, "processing");
            if (working == null) continue;   // another copy of the app took it
            handle(working);
            handled++;
        }
        return handled;
    }

    private void handle(Path file) {
        ReplyFile r;
        try {
            r = json.readValue(file.toFile(), ReplyFile.class);
            if (r.orderId() == null || r.workflowId() == null) throw new IOException("no orderId or replyTo");
        } catch (IOException e) {
            log.warn("Return link: {} isn't a readable answer ({}); moved to bad/", file.getFileName(), e.getMessage());
            moveTo(file, "bad");
            return;
        }
        String summary = r.type() + " " + r.orderId() + ": " + (r.ok() ? "done" : "refused")
                + (r.vmId() != null ? ", VM " + r.vmId() : "") + (r.detail() != null ? " (" + r.detail() + ")" : "");
        audit.record(null, r.specHash(), "LINK_REPLY", "domain-3", summary);
        try {
            client.newUntypedWorkflowStub(r.workflowId()).signal("linkReply", r.toReply());
            moveTo(file, "done");
        } catch (WorkflowNotFoundException e) {
            // Nobody is waiting any more: e.g. the build gave up and was rolled back.
            audit.record(null, r.specHash(), "LINK_REPLY_UNMATCHED", "domain-3",
                    r.workflowId() + " isn't waiting; " + summary);
            log.warn("Return link: {} isn't running; answer {} moved to unmatched/", r.workflowId(), r.orderId());
            moveTo(file, "unmatched");
        }
    }

    /** Moves a file into a subfolder of the inbox. Returns null if it was already gone. */
    private Path moveTo(Path file, String folder) {
        try {
            Path dir = props.inboxDir().resolve(folder);
            Files.createDirectories(dir);
            Path target = dir.resolve(file.getFileName());
            return Files.move(file, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            return null;
        }
    }
}
