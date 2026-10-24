package com.example.vmintent.catalog;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The actions a definition's steps can use, with the settings each one takes. Checked when a
 * definition is published, so a misspelt action or setting is caught before anything runs.
 *
 * Every action that changes something:
 *  - has an undo, run in reverse order when a failed run is torn down;
 *  - copes with its own partial work when it runs again (after Resume or a retry): it looks at
 *    what's already there before doing anything, so running it twice gives the same result as once.
 */
public final class Actions {

    /** required/optional = names of "with" settings. undo = what Tear down does for a finished step. */
    public record Action(String name, String summary, Set<String> required, Set<String> optional, String undo,
                         String partialWork) {}

    public static final Map<String, Action> ALL = new LinkedHashMap<>();

    static {
        add(new Action("vm.create", "Build a VM (on its cloud, or over the one-way link) and hand it to its lifecycle workflow",
                Set.of("provider", "region", "os"),
                Set.of("name", "vcpu", "memoryGiB", "size", "osVersion", "diskGiB", "diskTier", "env", "ttlDays", "publicIp"),
                "Removes the VM",
                "The VM is identified by its spec hash: if it's already built (or being built), that VM is used"));
        add(new Action("vm.resize", "Change a VM's vCPU and memory", Set.of("vm", "vcpu", "memoryGiB"), Set.of(),
                "Resizes back", "Nothing to do if the VM already has that size"));
        add(new Action("vm.power", "Power a VM on or off", Set.of("vm", "on"), Set.of(),
                "Powers back", "Nothing to do if it's already in that state"));
        add(new Action("vm.snapshot", "Snapshot a VM", Set.of("vm", "label"), Set.of(),
                "None (snapshots are kept)", "A snapshot with the same label isn't taken twice"));
        add(new Action("tools.stage", "Install a tool bundle on a VM", Set.of("vm", "bundle", "version"), Set.of(),
                "Removes the bundle", "Skipped if that bundle and version is already installed; a half install is cleaned up first"));
        add(new Action("files.copy", "Copy files from the file store to a VM", Set.of("vm", "files", "to"), Set.of(),
                "Deletes the copied files",
                "Each file is copied to a .part name and renamed when its SHA-256 matches; files already there with the "
                        + "same SHA-256 are skipped and leftover .part files are removed"));
        add(new Action("config.apply", "Set configuration values on a VM", Set.of("vm", "settings"), Set.of(),
                "Puts the old values back", "Only values that differ are written"));
        add(new Action("check.until", "Look at a VM until a CEL condition on 'probe' is true",
                Set.of("vm", "until"), Set.of("everySeconds", "timeoutMinutes"), "None", "Only looks"));
        add(new Action("approval.wait", "Wait for someone to approve", Set.of("message"),
                Set.of("approvers", "timeoutHours"), "None",
                "Waits again; the requester can't approve their own run"));
    }

    private static void add(Action a) {
        ALL.put(a.name(), a);
    }

    /** What a probe returns, for check.until conditions. */
    public static final List<String> PROBE_FIELDS = List.of("reachable", "power", "vcpu", "memoryGiB", "tools", "files", "config");

    private Actions() {}
}
