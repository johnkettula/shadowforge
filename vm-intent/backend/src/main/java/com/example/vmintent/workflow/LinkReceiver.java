package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.LinkReply;
import io.temporal.workflow.SignalMethod;

/**
 * Workflows that send orders over the one-way link get the answers through this signal.
 * ReturnLinkListener sends it to the workflow named in the order's replyTo.
 */
public interface LinkReceiver {

    @SignalMethod
    void linkReply(LinkReply reply);
}
