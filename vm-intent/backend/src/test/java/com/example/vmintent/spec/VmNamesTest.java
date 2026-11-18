package com.example.vmintent.spec;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class VmNamesTest {

    @Test
    void acceptsLowerCaseDigitsAndHyphens() {
        assertTrue(VmNames.isValid("web-01"));
        assertTrue(VmNames.isValid("01"));
        assertTrue(VmNames.isValid("vm-1a2b3c4d"));
    }

    @Test
    void lengthIsTwoToFortyOne() {
        assertTrue(VmNames.isValid("a".repeat(41)));
        assertFalse(VmNames.isValid("a".repeat(42)));
        assertFalse(VmNames.isValid("a"));
    }

    @Test
    void rejectsOtherCharactersAndLeadingHyphen() {
        assertFalse(VmNames.isValid("Web-01"));
        assertFalse(VmNames.isValid("web 01"));
        assertFalse(VmNames.isValid("web_01"));
        assertFalse(VmNames.isValid("-web-01"));
        assertFalse(VmNames.isValid("web.01"));
        assertFalse(VmNames.isValid(null));
        assertFalse(VmNames.isValid(""));
    }
}
