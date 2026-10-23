package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.InventoryFinding;
import com.example.vmintent.workflow.Models.InventoryReport;
import io.temporal.activity.ActivityInterface;

import java.util.List;

/** Database side of the inventory check. */
@ActivityInterface
public interface InventoryActivities {

    /**
     * Compares what a cloud has with what we recorded. RUNNING VMs the cloud no longer has are marked
     * MISSING; cloud VMs we never recorded are reported as orphans (never deleted automatically).
     */
    InventoryFinding compare(String provider, List<String> cloudVmIds);

    void saveReport(InventoryReport report);
}
