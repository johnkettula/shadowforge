package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.SignalMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * One natural-language request, from words to a running VM.
 * The UI talks to it with signals (clarify / confirm / cancel)
 * and reads it with a query (status).
 */
@WorkflowInterface
public interface IntentWorkflow {

    @WorkflowMethod
    RequestStatus run(IntentRequest request);

    @SignalMethod
    void clarify(String answer);

    @SignalMethod
    void confirm();

    @SignalMethod
    void cancel();

    @QueryMethod
    RequestStatus status();
}
