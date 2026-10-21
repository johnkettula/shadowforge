package com.example.vmintent.config;

import io.temporal.worker.WorkerFactory;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.util.concurrent.TimeUnit;

/**
 * On shutdown (deploy, patching, "systemctl stop", "docker compose down"), stop taking new
 * tasks and let the ones already running finish, BEFORE the database pool closes.
 *
 * This bean depends on the DataSource, so Spring closes it first; the pool stays open
 * until the running activities are done. Anything not finished within the grace period
 * is simply retried by another worker.
 */
@Component
public class GracefulWorkerShutdown {

    private static final Logger log = LoggerFactory.getLogger(GracefulWorkerShutdown.class);
    private static final long GRACE_SECONDS = 30;

    private final ObjectProvider<WorkerFactory> workerFactory;

    public GracefulWorkerShutdown(ObjectProvider<WorkerFactory> workerFactory, DataSource dataSource) {
        this.workerFactory = workerFactory;
    }

    @PreDestroy
    public void drain() {
        WorkerFactory factory = workerFactory.getIfAvailable();
        if (factory == null || !factory.isStarted()) return;
        // The Temporal starter may already have called shutdown(); that only stops polling.
        // Waiting here is what lets the running tasks finish while the database is still open.
        log.info("Stopping workers: finishing running tasks (up to {} s)...", GRACE_SECONDS);
        if (!factory.isShutdown()) factory.shutdown();
        factory.awaitTermination(GRACE_SECONDS, TimeUnit.SECONDS);
        log.info("Workers stopped. Anything unfinished will be retried by another worker.");
    }
}
