package com.example.vmintent.spec;

/**
 * The Canonical VM Spec: one provider-neutral description of a VM.
 *
 * Every input (plain English, Slack, the legacy JSON API) is turned into
 * this record before anything is provisioned. Values are always abstract
 * ("us-east", "ssd", "ubuntu"), never provider names like "t3.xlarge" —
 * the provider adapters translate those.
 */
public record VmSpec(
        String name,
        String provider,   // vsphere | aws | azure | gcp
        String region,     // us-east | us-west | us-central | eu-west | dc1 | dc2
        int vcpu,
        int memoryGiB,
        String os,         // ubuntu | rhel | windows | debian | rocky
        String osVersion,
        int diskGiB,
        String diskTier,   // ssd | standard
        String env,        // dev | test | staging | prod
        int ttlDays,       // 0 = never expires
        boolean publicIp
) {
    public VmSpec withName(String newName) {
        return new VmSpec(newName, provider, region, vcpu, memoryGiB, os, osVersion,
                diskGiB, diskTier, env, ttlDays, publicIp);
    }
}
