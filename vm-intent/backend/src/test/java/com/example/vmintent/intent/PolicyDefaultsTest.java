package com.example.vmintent.intent;

import com.example.vmintent.spec.VmSpec;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class PolicyDefaultsTest {

    @Test
    void testDefaultOsVersion() {
        assertEquals("24.04", PolicyDefaults.defaultOsVersion("ubuntu"));
        assertEquals("9", PolicyDefaults.defaultOsVersion("rhel"));
        assertEquals("2022", PolicyDefaults.defaultOsVersion("windows"));
        assertEquals("12", PolicyDefaults.defaultOsVersion("debian"));
        assertEquals("9", PolicyDefaults.defaultOsVersion("rocky"));
        assertEquals("", PolicyDefaults.defaultOsVersion("centos"));
        assertEquals("", PolicyDefaults.defaultOsVersion(null));
    }

    @Test
    void testDefaultTtlDays() {
        assertEquals(30, PolicyDefaults.defaultTtlDays("dev"));
        assertEquals(14, PolicyDefaults.defaultTtlDays("test"));
        assertEquals(30, PolicyDefaults.defaultTtlDays("staging"));
        assertEquals(0, PolicyDefaults.defaultTtlDays("prod"));
        assertEquals(30, PolicyDefaults.defaultTtlDays("qa"));
        assertEquals(30, PolicyDefaults.defaultTtlDays(null));
    }

    @Test
    void testSIZES() {
        List<String> sizeKeys = Arrays.asList("xsmall", "small", "medium", "large", "xlarge");
        int[][] expectedSizes = new int[][]{
                {1, 2},
                {2, 4},
                {4, 16},
                {8, 32},
                {16, 64}
        };

        assertEquals(5, PolicyDefaults.SIZES.size());
        for (int i = 0; i < PolicyDefaults.SIZES.size(); i++) {
            assertArrayEquals(expectedSizes[i], PolicyDefaults.SIZES.get(sizeKeys.get(i)));
        }
    }

    @Test
    void testMAX_COUNT() {
        assertEquals(20, PolicyDefaults.MAX_COUNT);
    }
}