package com.example.vmintent.workflow;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityInterface;

/** Saves VM status and audit events to the database. */
@ActivityInterface
public interface RecordActivities {

    void save(String specHash, VmSpec spec, String state, String detail, VmResult result);

    /** Appends one row to the audit trail. */
    void audit(String requestId, String specHash, String event, String actor, String detail);

    /** Saves a VM's lifecycle (expiry, power, size, snapshots); state = new inventory state, or null to keep it. */
    void saveLifecycle(String specHash, String state, VmLifecycle lifecycle);
}
