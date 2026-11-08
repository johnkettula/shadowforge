package com.example.vmintent.link;

import com.example.vmintent.workflow.Models.LinkReply;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class ReplyFileTest {

    @Test
    void toReply_copiesAllFields() {
        ReplyFile replyFile = new ReplyFile("ORD-123", "CREATE", null, "key-456", "hash-789", true, "vm-001", "192.168.1.1", "Test detail");

        LinkReply linkReply = replyFile.toReply();

        assertEquals("ORD-123", linkReply.orderId());
        assertEquals("CREATE", linkReply.type());
        assertTrue(linkReply.ok());
        assertEquals("vm-001", linkReply.vmId());
        assertEquals("192.168.1.1", linkReply.ipAddress());
        assertEquals("Test detail", linkReply.detail());
    }

    @Test
    void workflowId_returnsReplyTo_whenSet() {
        ReplyFile replyFile = new ReplyFile("ORD-123", "CREATE", "custom-wf", null, null, true, null, null, null);

        String result = replyFile.workflowId();
        assertEquals("custom-wf", result);
    }

    @Test
    void workflowId_returnsVmHash_whenReplyToNullAndTypeCreate() {
        ReplyFile replyFile = new ReplyFile("ORD-123", "CREATE", null, null, "hash-abc", true, null, null, null);

        String result = replyFile.workflowId();
        assertEquals("vm-hash-abc", result);
    }

    @Test
    void workflowId_returnsLifeHash_whenReplyToBlankAndTypeResize() {
        ReplyFile replyFile = new ReplyFile("ORD-123", "RESIZE", "  ", null, "hash-def", true, null, null, null);

        String result = replyFile.workflowId();
        assertEquals("life-hash-def", result);
    }

    @Test
    void workflowId_returnsNull_whenReplyToNullAndSpecHashNull() {
        ReplyFile replyFile = new ReplyFile("ORD-123", "CREATE", null, null, null, true, null, null, null);

        String result = replyFile.workflowId();
        assertNull(result);
    }
}
