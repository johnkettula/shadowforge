package com.example.vmintent.workflow;

import com.example.vmintent.catalog.CatalogModels.RunRequest;
import com.example.vmintent.catalog.CatalogModels.RunStatus;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.UpdateMethod;
import io.temporal.workflow.UpdateValidatorMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * One run of a provisioning definition (the catalog). Workflow ID = "run-<definition>-<hash of
 * the definition version and inputs>", so submitting the same thing twice finds the first run.
 *
 * It runs the definition's steps in order. When a step fails (after its retries) the run is
 * never started again from the beginning: it stops in AWAITING_RECOVERY and waits for a person to
 *  - resume: the failed step runs again, and copes with whatever it already did, then the run carries on;
 *  - teardown: every step that did something is undone, newest first.
 * If nobody decides within the definition's recovery wait (30 days at most), it tears itself down.
 */
@WorkflowInterface
public interface CatalogRunWorkflow {

    @WorkflowMethod
    RunStatus run(RunRequest request);

    @QueryMethod
    RunStatus status();

    /** Run the failed step again and carry on. */
    @UpdateMethod
    RunStatus resume(String actor, String note);

    @UpdateValidatorMethod(updateName = "resume")
    void validateResume(String actor, String note);

    /** Undo everything the run did, newest step first. */
    @UpdateMethod
    RunStatus teardown(String actor, String reason);

    @UpdateValidatorMethod(updateName = "teardown")
    void validateTeardown(String actor, String reason);

    /** Answer a waiting approval step. */
    @UpdateMethod
    RunStatus approve(String actor, boolean approved, String note);

    @UpdateValidatorMethod(updateName = "approve")
    void validateApprove(String actor, boolean approved, String note);
}
