package com.example.vmintent.workflow;

import io.temporal.activity.ActivityInterface;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;

/** The archive sweep's work: find closed workflows, copy their histories to the archive, expire old ones. */
@ActivityInterface
public interface ArchiveActivities {

    /** A closed workflow that isn't archived yet. closedAt is ISO-8601. */
    record ClosedRun(String workflowId, String runId, String workflowType, String closedAt, String classification) {}

    @Schema(description = "What one archive sweep did.")
    record SweepReport(String sweptAt, int archived, int alreadyArchived, int failed, List<String> failures,
                       int expiredHistories, int expiredDecisions) {}

    /** Closed workflows (newest first, at most max) whose histories aren't in the archive yet. */
    List<ClosedRun> findUnarchived(int max);

    /** Copies one history to the archive. true = written now, false = it was already there. */
    boolean archive(ClosedRun run);

    /** Removes histories and decision-log rows past their retention. Returns {histories, decisions}. */
    int[] expire();
}
