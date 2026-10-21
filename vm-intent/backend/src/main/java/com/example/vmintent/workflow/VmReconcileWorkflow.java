package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/** Makes the chosen cloud match the spec. Workflow ID = "vm-" + spec hash. */
@WorkflowInterface
public interface VmReconcileWorkflow {

    @WorkflowMethod
    VmResult reconcile(ReconcileRequest request);
}
