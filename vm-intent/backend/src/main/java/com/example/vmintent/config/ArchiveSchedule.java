package com.example.vmintent.config;

import com.example.vmintent.workflow.ArchiveSweepWorkflow;
import com.example.vmintent.workflow.TaskQueues;
import io.temporal.api.enums.v1.ScheduleOverlapPolicy;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.schedules.Schedule;
import io.temporal.client.schedules.ScheduleActionStartWorkflow;
import io.temporal.client.schedules.ScheduleAlreadyRunningException;
import io.temporal.client.schedules.ScheduleClient;
import io.temporal.client.schedules.ScheduleClientOptions;
import io.temporal.client.schedules.ScheduleHandle;
import io.temporal.client.schedules.ScheduleOptions;
import io.temporal.client.schedules.SchedulePolicy;
import io.temporal.client.schedules.ScheduleSpec;
import io.temporal.client.schedules.ScheduleUpdate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * The archive sweep as a Temporal Schedule (vm-archive-sweep), every hour by default: it copies
 * closed workflow histories to the write-once archive before Temporal's own retention removes them,
 * and removes histories and decision-log rows past their retention. See docs/AUDIT.md.
 *
 * Settings: vmintent.audit.sweep-enabled, .sweep-cron (VMINTENT_ARCHIVE_SWEEP_CRON).
 * Keep the sweep more frequent than the namespace's retention (1 day on the dev server).
 */
@Component
@ConditionalOnWebApplication
public class ArchiveSchedule {

    public static final String SCHEDULE_ID = "vm-archive-sweep";
    private static final Logger log = LoggerFactory.getLogger(ArchiveSchedule.class);

    private final WorkflowClient client;
    private final boolean enabled;
    private final String cron;

    public ArchiveSchedule(WorkflowClient client,
                           @Value("${vmintent.audit.sweep-enabled:true}") boolean enabled,
                           @Value("${vmintent.audit.sweep-cron:17 * * * *}") String cron) {
        this.client = client;
        this.enabled = enabled;
        this.cron = cron;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void setUp() {
        try {
            ScheduleClient schedules = ScheduleClient.newInstance(client.getWorkflowServiceStubs(),
                    ScheduleClientOptions.newBuilder().setNamespace(client.getOptions().getNamespace()).build());
            ScheduleHandle handle = schedules.getHandle(SCHEDULE_ID);
            if (!enabled) {
                try {
                    handle.delete();
                    log.info("Archive sweep schedule removed (vmintent.audit.sweep-enabled=false)");
                } catch (Exception notThere) {
                    // nothing to remove
                }
                return;
            }
            Schedule schedule = Schedule.newBuilder()
                    .setAction(ScheduleActionStartWorkflow.newBuilder()
                            .setWorkflowType(ArchiveSweepWorkflow.class)
                            .setOptions(WorkflowOptions.newBuilder()
                                    .setWorkflowId("archive-sweep")
                                    .setTaskQueue(TaskQueues.INTENT)
                                    .build())
                            .build())
                    .setSpec(ScheduleSpec.newBuilder().setCronExpressions(List.of(cron)).build())
                    .setPolicy(SchedulePolicy.newBuilder()
                            .setOverlap(ScheduleOverlapPolicy.SCHEDULE_OVERLAP_POLICY_SKIP)
                            .build())
                    .build();
            try {
                schedules.createSchedule(SCHEDULE_ID, schedule, ScheduleOptions.newBuilder().build());
                log.info("Archive sweep scheduled: '{}'", cron);
            } catch (ScheduleAlreadyRunningException exists) {
                handle.update(input -> new ScheduleUpdate(schedule));
            }
        } catch (Exception e) {
            log.warn("Couldn't set up the archive sweep schedule ({}). POST /api/v2/compliance/sweeps still runs it.",
                    e.getMessage());
        }
    }
}
