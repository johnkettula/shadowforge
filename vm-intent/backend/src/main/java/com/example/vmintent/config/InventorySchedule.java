package com.example.vmintent.config;

import com.example.vmintent.workflow.InventoryCheckWorkflow;
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
 * The nightly inventory check as a Temporal Schedule: the Temporal server starts an
 * InventoryCheckWorkflow at the set time, even if no copy of this app is running then (a worker
 * picks it up when one is). Pause it, run it now or change it in the Temporal UI under Schedules.
 *
 * Set up when the API starts, from vmintent.inventory-check.* (enabled, cron, time-zone). Starting
 * again with different settings updates the schedule; enabled=false removes it.
 */
@Component
@ConditionalOnWebApplication
public class InventorySchedule {

    public static final String SCHEDULE_ID = "vm-inventory-check";
    private static final Logger log = LoggerFactory.getLogger(InventorySchedule.class);

    private final WorkflowClient client;
    private final boolean enabled;
    private final String cron;
    private final String timeZone;

    public InventorySchedule(WorkflowClient client,
                             @Value("${vmintent.inventory-check.enabled:true}") boolean enabled,
                             @Value("${vmintent.inventory-check.cron:0 2 * * *}") String cron,
                             @Value("${vmintent.inventory-check.time-zone:UTC}") String timeZone) {
        this.client = client;
        this.enabled = enabled;
        this.cron = cron;
        this.timeZone = timeZone;
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
                    log.info("Inventory check schedule removed (vmintent.inventory-check.enabled=false)");
                } catch (Exception notThere) {
                    // nothing to remove
                }
                return;
            }
            Schedule schedule = schedule();
            try {
                schedules.createSchedule(SCHEDULE_ID, schedule, ScheduleOptions.newBuilder().build());
                log.info("Inventory check scheduled: '{}' ({})", cron, timeZone);
            } catch (ScheduleAlreadyRunningException exists) {
                handle.update(input -> new ScheduleUpdate(schedule));
                log.info("Inventory check schedule up to date: '{}' ({})", cron, timeZone);
            }
        } catch (Exception e) {
            // e.g. the Java test server, which has no schedules. The check can still be run by hand.
            log.warn("Couldn't set up the inventory check schedule ({}). POST /api/v2/inventory-checks still runs it.",
                    e.getMessage());
        }
    }

    private Schedule schedule() {
        return Schedule.newBuilder()
                .setAction(ScheduleActionStartWorkflow.newBuilder()
                        .setWorkflowType(InventoryCheckWorkflow.class)
                        .setOptions(WorkflowOptions.newBuilder()
                                // The server adds the run time to this ID: inventory-check-2026-10-24T02:00:00Z
                                .setWorkflowId("inventory-check")
                                .setTaskQueue(TaskQueues.INTENT)
                                .build())
                        .build())
                .setSpec(ScheduleSpec.newBuilder()
                        .setCronExpressions(List.of(cron))
                        .setTimeZoneName(timeZone)
                        .build())
                // If last night's check is somehow still running, skip tonight's rather than run two.
                .setPolicy(SchedulePolicy.newBuilder()
                        .setOverlap(ScheduleOverlapPolicy.SCHEDULE_OVERLAP_POLICY_SKIP)
                        .build())
                .build();
    }
}
