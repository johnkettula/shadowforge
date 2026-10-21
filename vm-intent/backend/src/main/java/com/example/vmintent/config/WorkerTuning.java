package com.example.vmintent.config;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.WorkerOptionsCustomizer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * How much work each worker process takes on, per task queue. Settings come from
 * vmintent.workers.* in application.yml, so you can tune a running system
 * without changing code.
 *
 * Two kinds of limit:
 *  - Concurrency (max-workflow-tasks, max-activities): how many tasks ONE worker
 *    process runs at a time. Add worker processes to go higher.
 *  - Rate (create-per-second, read-per-second): how many calls per second ALL workers
 *    together may make to one cloud. Temporal enforces this on the server, so it
 *    holds however many workers you run. It's how you stay under a cloud's API limits.
 */
@Configuration
public class WorkerTuning {

    private static final Logger log = LoggerFactory.getLogger(WorkerTuning.class);

    @Bean
    public WorkerOptionsCustomizer workerOptionsCustomizer(Environment env) {
        return (builder, workerName, taskQueue) -> {
            boolean virtual = env.getProperty("vmintent.workers.virtual-threads", Boolean.class, true);
            if (TaskQueues.INTENT.equals(taskQueue)) {
                builder.setMaxConcurrentWorkflowTaskExecutionSize(intProp(env, "intent.max-workflow-tasks", 200))
                        .setMaxConcurrentWorkflowTaskPollers(intProp(env, "intent.workflow-pollers", 16))
                        .setMaxConcurrentActivityExecutionSize(intProp(env, "intent.max-activities", 200))
                        .setMaxConcurrentActivityTaskPollers(intProp(env, "intent.activity-pollers", 8));
            } else {
                String provider = taskQueue.substring(0, taskQueue.indexOf('-'));
                boolean read = taskQueue.endsWith("-read-q");
                double perSecond = env.getProperty(
                        "vmintent.workers.rate." + provider + (read ? ".read-per-second" : ".create-per-second"),
                        Double.class, read ? 100.0 : 25.0);
                builder.setMaxConcurrentActivityExecutionSize(intProp(env, "provider.max-activities", 100))
                        .setMaxConcurrentActivityTaskPollers(intProp(env, "provider.activity-pollers", 4))
                        .setMaxTaskQueueActivitiesPerSecond(perSecond);
                log.info("Task queue {}: at most {} calls/second across all workers", taskQueue, perSecond);
            }
            builder.setUsingVirtualThreadsOnActivityWorker(virtual);
            return builder;
        };
    }

    private static int intProp(Environment env, String key, int fallback) {
        return env.getProperty("vmintent.workers." + key, Integer.class, fallback);
    }
}
