package com.example.vmintent.spec;

import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class SpecValidatorTest {

    private static VmSpec valid() {
        return new VmSpec("web-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
    }

    @Test
    void testValidSpec() {
        List<String> problems = SpecValidator.problems(valid());
        assertTrue(problems.isEmpty(), "Valid spec should have no problems");
    }

    @Test
    void testUnknownProvider() {
        VmSpec s = new VmSpec("web-01", "unknown-provider", "us-east", 2, 4, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Unknown platform 'unknown-provider'.", problems.get(0));
    }

    @Test
    void testVsphereOutsideDatacenter() {
        VmSpec s = new VmSpec("web-01", "vsphere", "us-east", 2, 4, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("vSphere VMs must go in a datacenter (dc1 or dc2), not 'us-east'.", problems.get(0));
    }

    @Test
    void testCloudRegionNotAvailable() {
        VmSpec s = new VmSpec("web-01", "aws", "non-existent-region", 2, 4, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Region 'non-existent-region' isn't available in aws.", problems.get(0));
    }

    @Test
    void testVcpuZero() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 0, 4, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("vCPU must be between 1 and 64 (got 0).", problems.get(0));
    }

    @Test
    void testVcpuSixtyFive() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 65, 4, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("vCPU must be between 1 and 64 (got 65).", problems.get(0));
    }

    @Test
    void testMemoryZero() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 0, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Memory must be 1-512 GiB (got 0).", problems.get(0));
    }

    @Test
    void testMemoryFiveHundredAndThirteen() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 513, "ubuntu", "24.04", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Memory must be 1-512 GiB (got 513).", problems.get(0));
    }

    @Test
    void testDiskNine() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 9, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Disk must be 10-4096 GiB (got 9).", problems.get(0));
    }

    @Test
    void testDiskFourThousandAndNinetySeven() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 4097, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Disk must be 10-4096 GiB (got 4097).", problems.get(0));
    }

    @Test
    void testUnknownOs() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 4, "centos", "8", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Operating system 'centos' isn't on the approved list.", problems.get(0));
    }

    @Test
    void testWindowsWithFiftyGiBDisk() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 4, "windows", "11", 50, "ssd", "dev", 30, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Windows needs at least a 64 GiB disk.", problems.get(0));
    }

    @Test
    void testTtlDaysNegative() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 50, "ssd", "dev", -1, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Lifetime must be 0-365 days.", problems.get(0));
    }

    @Test
    void testTtlDaysThreeHundredSixtySix() {
        VmSpec s = new VmSpec("web-01", "aws", "us-east", 2, 4, "ubuntu", "24.04", 50, "ssd", "dev", 366, false);
        List<String> problems = SpecValidator.problems(s);
        assertEquals(1, problems.size());
        assertEquals("Lifetime must be 0-365 days.", problems.get(0));
    }
}