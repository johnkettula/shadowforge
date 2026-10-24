package com.example.vmintent.config;

import com.example.vmintent.workflow.TaskQueues;
import com.sun.net.httpserver.HttpServer;
import io.temporal.api.workflowservice.v1.GetSystemInfoRequest;
import io.temporal.client.WorkflowClient;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * What a pod needs on Kubernetes (deploy/kubernetes), and harmless anywhere else.
 *
 * Which task queues this pod works on: vmintent.workers.queues (VMINTENT_WORKER_QUEUES), comma-
 * separated, e.g. "intent-q" for the workflow pods or "aws-q,aws-read-q" for the AWS pods. Empty =
 * all of them. Each kind of pod can then be scaled on its own. The others stop polling as soon as
 * the pod is ready.
 *
 * Health: with vmintent.health.port (VMINTENT_HEALTH_PORT) set, a small HTTP server answers
 *   /healthz/live    200 while the process is running (liveness probe)
 *   /healthz/ready   200 when the workers are polling and Temporal and Postgres answer (readiness probe)
 * It works in worker pods too, which have no web server (and so no Spring actuator).
 */
@Component
public class KubernetesRuntime {

    private static final Logger log = LoggerFactory.getLogger(KubernetesRuntime.class);
    private static final long CACHE_MS = 5_000;

    private final ObjectProvider<WorkerFactory> workers;
    private final WorkflowClient client;
    private final JdbcClient jdbc;
    private final Set<String> queues;
    private final int port;
    private final boolean startWorkers;
    private HttpServer server;
    private volatile boolean ready;
    private volatile long checkedAt;
    private volatile String lastProblem = "starting";

    public KubernetesRuntime(ObjectProvider<WorkerFactory> workers, WorkflowClient client, JdbcClient jdbc,
                             @Value("${vmintent.workers.queues:}") String queues,
                             @Value("${vmintent.health.port:0}") int port,
                             @Value("${spring.temporal.start-workers:true}") boolean startWorkers) {
        this.workers = workers;
        this.client = client;
        this.jdbc = jdbc;
        this.queues = parse(queues);
        this.port = port;
        this.startWorkers = startWorkers;
    }

    /** Every task queue this application has workers for. */
    public static List<String> allQueues() {
        List<String> all = new ArrayList<>();
        all.add(TaskQueues.INTENT);
        for (String p : TaskQueues.PROVIDERS) {
            all.add(TaskQueues.forProvider(p));
            all.add(TaskQueues.readQueue(p));
        }
        return all;
    }

    static Set<String> parse(String text) {
        Set<String> out = new LinkedHashSet<>();
        if (text == null || text.isBlank() || text.trim().equals("*")) return out;
        Arrays.stream(text.split(",")).map(String::trim).filter(s -> !s.isEmpty()).forEach(out::add);
        for (String q : out) {
            if (!allQueues().contains(q)) {
                throw new IllegalStateException("vmintent.workers.queues: '" + q + "' isn't a task queue (queues: " + allQueues() + ")");
            }
        }
        return out;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void ready() throws IOException {
        WorkerFactory factory = workers.getIfAvailable();
        if (factory != null && startWorkers && !queues.isEmpty()) {
            List<String> off = new ArrayList<>();
            for (String q : allQueues()) {
                Worker w = factory.tryGetWorker(q);
                if (w != null && !queues.contains(q)) {
                    w.suspendPolling();
                    off.add(q);
                }
            }
            log.info("This pod works on task queues {} (not polling {})", queues, off);
        }
        if (port > 0) {
            server = HttpServer.create(new InetSocketAddress(port), 0);
            server.setExecutor(Executors.newFixedThreadPool(2));
            server.createContext("/healthz/live", ex -> answer(ex, 200, "live"));
            server.createContext("/healthz/ready", ex -> {
                boolean ok = isReady();
                answer(ex, ok ? 200 : 503, ok ? "ready" : "not ready: " + lastProblem);
            });
            server.start();
            log.info("Health checks on port {}: /healthz/live, /healthz/ready", port);
        }
    }

    /** Workers polling (if this pod runs any), Temporal reachable, Postgres reachable. Cached for 5 s. */
    public boolean isReady() {
        long now = System.currentTimeMillis();
        if (now - checkedAt < CACHE_MS) return ready;
        String problem = null;
        try {
            WorkerFactory factory = workers.getIfAvailable();
            if (startWorkers && factory != null && (!factory.isStarted() || factory.isShutdown())) {
                problem = "workers aren't running";
            }
            if (problem == null) {
                client.getWorkflowServiceStubs().blockingStub()
                        .withDeadlineAfter(3, TimeUnit.SECONDS)
                        .getSystemInfo(GetSystemInfoRequest.getDefaultInstance());
            }
        } catch (Exception e) {
            problem = "Temporal doesn't answer (" + e.getMessage() + ")";
        }
        if (problem == null) {
            try {
                jdbc.sql("SELECT 1").query(Integer.class).single();
            } catch (Exception e) {
                problem = "Postgres doesn't answer (" + e.getMessage() + ")";
            }
        }
        lastProblem = problem;
        ready = problem == null;
        checkedAt = now;
        return ready;
    }

    private static void answer(com.sun.net.httpserver.HttpExchange ex, int status, String text) throws IOException {
        byte[] b = (text + "\n").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(status, b.length);
        ex.getResponseBody().write(b);
        ex.close();
    }

    @PreDestroy
    public void stop() {
        // Not ready any more: Kubernetes stops sending work while the workers drain.
        ready = false;
        checkedAt = Long.MAX_VALUE / 2;
        lastProblem = "shutting down";
        if (server != null) server.stop(0);
    }
}
