package com.example.vmintent.link;

import com.example.vmintent.workflow.Models.LinkReply;

/**
 * One answer from domain 3, as a file in the inbox. Domain 3 copies orderId, type, replyTo,
 * idempotencyKey and specHash from the order it is answering. See docs/ONE-WAY-LINK.md.
 */
public record ReplyFile(String orderId, String type, String replyTo, String idempotencyKey, String specHash,
                        boolean ok, String vmId, String ipAddress, String detail) {

    public LinkReply toReply() {
        return new LinkReply(orderId, type, ok, vmId, ipAddress, detail);
    }

    /** The workflow waiting for this answer. Falls back to the usual IDs if replyTo was left out. */
    public String workflowId() {
        if (replyTo != null && !replyTo.isBlank()) return replyTo;
        if (specHash == null) return null;
        return ("CREATE".equals(type) ? "vm-" : "life-") + specHash;
    }
}
