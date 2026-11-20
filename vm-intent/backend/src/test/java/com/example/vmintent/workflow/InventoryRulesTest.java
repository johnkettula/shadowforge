package com.example.vmintent.workflow;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Where the inventory check stops trusting a listing: more than 2, and more than half, missing. */
class InventoryRulesTest {

    @Test
    void marksUpToTwoOrUpToHalf() {
        assertFalse(InventoryRules.holdBackMissing(2, 2), "2 of 2 is marked");
        assertFalse(InventoryRules.holdBackMissing(3, 6), "3 of 6 is marked");
        assertFalse(InventoryRules.holdBackMissing(0, 0));
        assertFalse(InventoryRules.holdBackMissing(1, 1));
    }

    @Test
    void holdsBackMoreThanTwoAndMoreThanHalf() {
        assertTrue(InventoryRules.holdBackMissing(3, 5), "3 of 5 is held back");
        assertTrue(InventoryRules.holdBackMissing(3, 4), "3 of 4 is held back");
        assertTrue(InventoryRules.holdBackMissing(3, 3));
    }

    @Test
    void noteSaysHowManyWereLeftOut() {
        assertEquals("Not marked missing: the listing left out 3 of 4 running VMs; check the provider's route settings",
                InventoryRules.heldBackNote(3, 4));
    }
}
