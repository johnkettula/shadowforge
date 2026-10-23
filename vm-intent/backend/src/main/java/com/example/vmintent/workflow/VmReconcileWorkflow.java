package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * Makes the chosen cloud match the spec. Workflow ID = "vm-" + spec hash.
 * When the cloud is behind the one-way link, the answer comes back through linkReply (LinkReceiver).
 */
@WorkflowInterface
public interface VmReconcileWorkflow extends LinkReceiver {

    @WorkflowMethod
    VmResult reconcile(ReconcileRequest request);
}
