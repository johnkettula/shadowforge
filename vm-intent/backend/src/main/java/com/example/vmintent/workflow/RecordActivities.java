package com.example.vmintent.workflow;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityInterface;

/** Saves VM status and audit events to the database. */
@ActivityInterface
public interface RecordActivities {

    void save(String specHash, VmSpec spec, String state, String detail, VmResult result);

    /** Appends one row to the audit trail. */
    void audit(String requestId, String specHash, String event, String actor, String detail);
}
