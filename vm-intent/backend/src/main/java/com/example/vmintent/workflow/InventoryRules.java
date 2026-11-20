package com.example.vmintent.workflow;

/**
 * Rules the inventory check shares between InventoryActivitiesImpl and the test fakes, so the
 * tests check the real rule and not a copy of it.
 */
public final class InventoryRules {

    private InventoryRules() {}

    /**
     * True when a listing leaves out so many of a provider's RUNNING VMs (more than 2, and more than
     * half) that the listing is more likely wrong than the VMs gone, e.g. a vCenter route switched
     * back to simulated. Then none of them is marked MISSING, because MISSING can't be undone.
     */
    public static boolean holdBackMissing(int missing, int running) {
        return missing > 2 && missing * 2 > running;
    }

    /** The finding's note when holdBackMissing is true. */
    public static String heldBackNote(int missing, int running) {
        return "Not marked missing: the listing left out " + missing + " of " + running
                + " running VMs; check the provider's route settings";
    }
}
