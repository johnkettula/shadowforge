package com.example.vmintent.workflow;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.LinkOrder;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.Route;
import io.temporal.activity.ActivityInterface;

/**
 * The one-way link to domain 3. Orders go out as files in the outbox; the return link brings
 * answers back as files in the inbox, and ReturnLinkListener passes each one to its workflow.
 * See docs/ONE-WAY-LINK.md.
 */
@ActivityInterface
public interface LinkActivities {

    /** Is this cloud reached directly, or over the link? (From settings, so it lives in an activity.) */
    Route route(String provider);

    /** The provider's names for the spec, worked out here because domain 3's adapters can't be asked. */
    ProviderPlan planHere(VmSpec spec);

    /** Writes one order to the outbox. Safe to retry: the file is named after the order ID. */
    void send(LinkOrder order);
}
