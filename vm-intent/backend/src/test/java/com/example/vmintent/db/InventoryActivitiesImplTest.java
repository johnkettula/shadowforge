package com.example.vmintent.db;

import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.workflow.Models.InventoryFinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The real compare, against a mocked registry and audit log (no database). */
class InventoryActivitiesImplTest {

    private VmRegistry registry;
    private AuditLog audit;
    private InventoryActivitiesImpl inventory;

    @BeforeEach
    void setUp() {
        registry = mock(VmRegistry.class);
        audit = mock(AuditLog.class);
        inventory = new InventoryActivitiesImpl(registry, audit, null, new ObjectMapper());
        when(registry.missingOn(anyString())).thenReturn(Map.of());
    }

    @Test
    void holdsBackWhenTheListingLeavesOutMostVms() {
        when(registry.runningOn("aws")).thenReturn(new TreeMap<>(Map.of(
                "vm-1", "h1", "vm-2", "h2", "vm-3", "h3", "vm-4", "h4")));
        when(registry.knownVmIds("aws")).thenReturn(Set.of("vm-1", "vm-2", "vm-3", "vm-4"));

        InventoryFinding f = inventory.compare("aws", List.of("vm-1"));

        assertEquals(List.of(), f.missing());
        assertTrue(f.note().contains("Not marked missing"), f.note());
        assertTrue(f.note().contains("3 of 4"), f.note());
        verify(registry, never()).markMissing(anyString(), anyString());
        verify(audit, times(3)).record(isNull(), anyString(), eq("NOT_MARKED_MISSING"), eq("inventory-check"), anyString());
        for (String h : List.of("h2", "h3", "h4")) {
            verify(audit).record(isNull(), eq(h), eq("NOT_MARKED_MISSING"), eq("inventory-check"), anyString());
        }
        verify(audit, never()).record(any(), anyString(), eq("MISSING"), anyString(), anyString());
    }

    @Test
    void marksAFewMissingVms() {
        when(registry.runningOn("aws")).thenReturn(new TreeMap<>(Map.of("vm-1", "h1", "vm-2", "h2")));
        when(registry.knownVmIds("aws")).thenReturn(Set.of("vm-1", "vm-2"));

        InventoryFinding f = inventory.compare("aws", List.of("vm-1"));

        assertEquals(List.of("h2"), f.missing());
        verify(registry).markMissing(eq("h2"), anyString());
        verify(audit).record(isNull(), eq("h2"), eq("MISSING"), eq("inventory-check"), anyString());
    }

    @Test
    void reportsAMissingVmThatIsListedAgain() {
        when(registry.runningOn("aws")).thenReturn(new TreeMap<>(Map.of("vm-1", "h1")));
        when(registry.missingOn("aws")).thenReturn(new TreeMap<>(Map.of("vm-back", "hback", "vm-gone", "hgone")));
        when(registry.knownVmIds("aws")).thenReturn(Set.of("vm-1", "vm-back", "vm-gone"));

        InventoryFinding f = inventory.compare("aws", List.of("vm-1", "vm-back"));

        assertTrue(f.note().contains("listed again: hback"), f.note());
        assertTrue(!f.note().contains("hgone"), f.note());
        assertEquals(List.of(), f.missing());
        assertEquals(List.of(), f.orphans(), "a known VM is never an orphan");
        verify(audit).record(isNull(), eq("hback"), eq("LISTED_AGAIN"), eq("inventory-check"), anyString());
        verify(audit, never()).record(any(), eq("hgone"), eq("LISTED_AGAIN"), anyString(), anyString());
        verify(registry, never()).markMissing(anyString(), anyString());
    }
}
