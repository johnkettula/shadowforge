package com.example.vmintent.workflow;

import com.example.vmintent.workflow.ArchiveActivities.SweepReport;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * Copies the histories of closed workflows to the write-once archive, before Temporal's own
 * retention removes them, and removes what is past its retention. Started every hour by the
 * Temporal Schedule "vm-archive-sweep" (or by hand: POST /api/v2/compliance/sweeps).
 */
@WorkflowInterface
public interface ArchiveSweepWorkflow {

    @WorkflowMethod
    SweepReport sweep();
}
