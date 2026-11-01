package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.SignalMethod;
import io.temporal.workflow.UpdateMethod;
import io.temporal.workflow.UpdateValidatorMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * One natural-language request, from words to one or more running VMs.
 * The UI talks to it with updates (answerQuestion, confirmSpec, cancelRequest), which are
 * refused at once if the request can't take them, and reads it with a query (status).
 * The clarify / cancel / confirm signals are kept for older callers and running workflows.
 */
@WorkflowInterface
public interface IntentWorkflow {

    @WorkflowMethod
    RequestStatus run(IntentRequest request);

    @SignalMethod
    void clarify(String answer);

    /** Kept for older callers. confirmSpec is better: it says at once whether the confirmation counted. */
    @SignalMethod
    void confirm();

    /**
     * Confirm the spec and start the build. Unlike a signal, an update answers: it's refused at
     * once (by the validator) if the request isn't waiting for confirmation, or if specHash isn't
     * the spec the person was shown, so nobody confirms a spec they didn't see.
     */
    @UpdateMethod
    RequestStatus confirmSpec(String actor, String specHash);

    @UpdateValidatorMethod(updateName = "confirmSpec")
    void validateConfirmSpec(String actor, String specHash);

    @SignalMethod
    void cancel();

    /** Answer the request's question. Refused unless the request is waiting for an answer. */
    @UpdateMethod
    void answerQuestion(String answer);

    @UpdateValidatorMethod(updateName = "answerQuestion")
    void validateAnswerQuestion(String answer);

    /** Cancel the request. Refused once it's cancelled, its build has started, or it has finished. */
    @UpdateMethod
    void cancelRequest();

    @UpdateValidatorMethod(updateName = "cancelRequest")
    void validateCancelRequest();

    @QueryMethod
    RequestStatus status();
}
