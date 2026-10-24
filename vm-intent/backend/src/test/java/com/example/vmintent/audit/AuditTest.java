package com.example.vmintent.audit;

import com.example.vmintent.audit.PolicyEngine.Verdict;
import com.example.vmintent.catalog.ClassificationCatalog;
import com.sun.net.httpserver.HttpServer;
import io.temporal.spring.boot.WorkflowImpl;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AuditTest {

    @TempDir
    Path tmp;

    @Test
    void archiveFilesAreWrittenOnceAndChecked() throws Exception {
        ArchiveStore store = new ArchiveStore(tmp.toString());
        String path = ArchiveStore.pathFor(3, "C3", Instant.parse("2026-10-23T10:00:00Z"),
                "inventory-check-2026-10-23T02:00:00Z", "run-1");
        assertEquals("3y/C3/2026/10/inventory-check-2026-10-23T02_00_00Z/run-1.json", path);

        ArchiveStore.Stored first = store.write(path, "{\"events\":[]}");
        assertFalse(first.alreadyThere());
        assertTrue(store.write(path, "{\"events\":[]}").alreadyThere(), "the same history again is a no-op");
        assertThrows(IOException.class, () -> store.write(path, "{\"events\":[1]}"), "a different one is refused");
        // (Files.isWritable is always true for root, so look at the permission bits.)
        if (tmp.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            assertFalse(Files.getPosixFilePermissions(tmp.resolve(path)).contains(java.nio.file.attribute.PosixFilePermission.OWNER_WRITE),
                    "archived files are read-only");
        } else {
            assertFalse(tmp.resolve(path).toFile().canWrite(), "archived files are read-only");
        }
        assertEquals("{\"events\":[]}", store.read(path, first.sha256()));

        // Someone changes the file behind our back: reading it says so.
        tmp.resolve(path).toFile().setWritable(true);
        Files.writeString(tmp.resolve(path), "{\"events\":[\"forged\"]}");
        IOException changed = assertThrows(IOException.class, () -> store.read(path, first.sha256()));
        assertTrue(changed.getMessage().contains("changed since it was archived"));

        assertTrue(store.delete(path));
        assertThrows(IllegalArgumentException.class, () -> store.read("../outside.json", null));
    }

    @Test
    void classificationsMapCodesToTextAndRetention() {
        ClassificationCatalog c = ClassificationCatalog.of(Map.of("default", "C1", "classifications", List.of(
                Map.of("code", "C1", "label", "Internal", "retentionYears", 1),
                Map.of("code", "C5", "label", "Restricted", "retentionYears", 5))), null);
        assertEquals("Internal", c.get("C1").label());
        assertEquals(5, c.get("C5").retentionYears());
        assertEquals("C1", c.orDefault(null).code());
        assertEquals("C5", ClassificationCatalog.of(Map.of("default", "C1", "classifications", List.of(
                Map.of("code", "C1", "label", "x", "retentionYears", 1),
                Map.of("code", "C5", "label", "y", "retentionYears", 5))), "C5").defaultClassification().code());

        IllegalStateException bad = assertThrows(IllegalStateException.class, () -> ClassificationCatalog.of(Map.of(
                "default", "C9", "classifications", List.of(Map.of("code", "C1", "label", "x", "retentionYears", 7))), null));
        assertTrue(bad.getMessage().contains("retentionYears must be 1 to 5"), bad.getMessage());
        assertTrue(bad.getMessage().contains("'C9' isn't one of the codes"), bad.getMessage());
    }

    @Test
    void builtInClassificationsLoad() {
        ClassificationCatalog c = new ClassificationCatalog("", "");
        assertEquals(List.of(1, 3, 5), c.all().stream().map(x -> x.retentionYears()).toList());
    }

    @Test
    void opaIsAskedAfterTheBuiltInRulesAndBothMustAllow() throws Exception {
        AtomicReference<String> answer = new AtomicReference<>("{\"result\": true}");
        AtomicReference<String> seen = new AtomicReference<>();
        HttpServer opa = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        opa.createContext("/v1/data/vmintent/allow", ex -> {
            seen.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] b = answer.get().getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        opa.start();
        try {
            PolicyEngine p = new PolicyEngine("http://127.0.0.1:" + opa.getAddress().getPort() + "/v1/data/vmintent/allow");
            Verdict yes = new Verdict(true, "run requester", "it's their run");
            assertTrue(p.decide("run.resume", "jdoe", List.of("REQUESTER"), "run-x", Map.of(), yes).allowed());
            assertTrue(seen.get().contains("\"action\":\"run.resume\"") && seen.get().contains("\"actor\":\"jdoe\""), seen.get());

            answer.set("{\"result\": {\"allow\": false, \"reason\": \"change freeze until Monday\"}}");
            Verdict no = p.decide("run.resume", "jdoe", List.of(), "run-x", Map.of(), yes);
            assertFalse(no.allowed());
            assertEquals("change freeze until Monday", no.reason());
            assertEquals("run requester + opa", no.policy());

            answer.set("{}");   // the policy has no rule for this: no
            assertFalse(p.decide("run.resume", "jdoe", List.of(), "run-x", Map.of(), yes).allowed());

            seen.set(null);
            assertFalse(p.decide("run.resume", "jdoe", List.of(), "run-x", Map.of(),
                    new Verdict(false, "run requester or OPERATOR", "not theirs")).allowed());
            assertEquals(null, seen.get(), "a built-in no doesn't need OPA");
        } finally {
            opa.stop(0);
        }
        PolicyEngine unreachable = new PolicyEngine("http://127.0.0.1:1/v1/data/vmintent/allow");
        Verdict v = unreachable.decide("run.start", "jdoe", List.of(), "run-x", Map.of(), new Verdict(true, "role", "ok"));
        assertFalse(v.allowed(), "OPA can't be asked: no");
        assertTrue(v.reason().contains("couldn't be asked"));
    }

    @Test
    void replayKnowsEveryWorkflow() throws IOException {
        Path src = Path.of("src/main/java/com/example/vmintent/workflow");
        if (!Files.isDirectory(src)) src = Path.of(System.getProperty("vmintent.src", "/home/claude/shadowforge/vm-intent/backend"))
                .resolve("src/main/java/com/example/vmintent/workflow");
        try (Stream<Path> files = Files.list(src)) {
            List<String> impls = files.map(f -> f.getFileName().toString())
                    .filter(n -> n.endsWith("WorkflowImpl.java")).map(n -> n.replace(".java", "")).sorted().toList();
            List<String> known = ReplayService.WORKFLOWS.stream().map(Class::getSimpleName).sorted().toList();
            assertEquals(impls, known, "add new workflows to ReplayService.WORKFLOWS so they can be replayed for audit");
        }
        for (Class<?> c : ReplayService.WORKFLOWS) assertTrue(c.isAnnotationPresent(WorkflowImpl.class), c.getName());
    }
}
