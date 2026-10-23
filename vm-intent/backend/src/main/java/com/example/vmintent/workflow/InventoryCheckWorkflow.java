package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.InventoryReport;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * Compares every cloud with the inventory: VMs that have disappeared (drift) and VMs nobody
 * recorded (orphans). Started every night by a Temporal Schedule (see InventorySchedule), or on
 * demand with POST /api/v2/inventory-checks.
 */
@WorkflowInterface
public interface InventoryCheckWorkflow {

    @WorkflowMethod
    InventoryReport run();
}
