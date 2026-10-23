package com.example.vmintent.intent;

import java.util.ArrayList;
import java.util.List;

/**
 * What the interpreter understood from the user's words. Every field is
 * nullable: null means "the user didn't say", and policy defaults fill it
 * in later (in code, not by the AI, so results stay consistent).
 */
public class IntentDraft {
    public String name;
    public String provider;
    public String region;
    public Integer vcpu;
    public Integer memoryGiB;
    public String sizeClass;   // xsmall | small | medium | large | xlarge
    public String os;
    public String osVersion;
    public Integer diskGiB;
    public String diskTier;
    public String env;
    public Integer ttlDays;
    public Boolean publicIp;
    /** How many identical VMs ("3 web servers"); null = one. */
    public Integer count;
    /** Set when the interpreter saw something it couldn't place and should ask about. */
    public String question;
    public List<String> notes = new ArrayList<>();
}
