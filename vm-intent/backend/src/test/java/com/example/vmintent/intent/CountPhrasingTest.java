package com.example.vmintent.intent;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** "3 web servers" means three VMs; "a RHEL 9 server" or "16 gb ram server" means one. */
class CountPhrasingTest {

    private final IntentInterpreter interpreter = new IntentInterpreter(new RuleBasedIntentExtractor());

    @Test
    void numbersOfMachinesAreCounts() {
        Map<String, Integer> cases = Map.of(
                "3 web servers on aws, ubuntu", 3,
                "five ubuntu vms in azure eu-west", 5,
                "I need 2x boxes on gcp", 2,
                "spin up 4 small linux machines on vsphere dc2", 4,
                "10 instances on aws, 2 cores each", 10,
                "3 servers on aws. actually make that 6 servers", 6,
                "3 small ubuntu web servers on gcp for 5 days, called web", 3);
        cases.forEach((text, n) -> {
            Interpretation it = interpreter.interpret(text);
            assertNull(it.question(), text);
            assertEquals(n, it.vmCount(), text);
            assertTrue(it.summary().startsWith(n + " × "), it.summary());
        });
    }

    @Test
    void otherNumbersNextToMachineWordsAreNotCounts() {
        List<String> single = List.of(
                "a rhel 9 server on aws",
                "debian 12 box in gcp",
                "ubuntu 24.04 server on azure",
                "4 cores 16 gb ram server on aws",
                "16 gigs server, aws",
                "windows 2022 server on azure",
                "aws vm for 3 days",
                "a 4 core ubuntu web server on aws",
                "ubuntu 22 small web server on gcp",
                "Ubuntu box, 4 cores, 16 gigs, us-east on AWS",
                "I need a medium Linux server in Virginia on Amazon",
                "aws ec2 ubuntu 24.04 4 vcpu 16GB RAM us-east-1",
                "Can you spin up a medium-sized ubuntu VM in AWS N. Virginia?",
                "four cores and sixteen gigabytes of memory, ubuntu, amazon, east coast");
        for (String text : single) {
            Interpretation it = interpreter.interpret(text);
            assertNull(it.count(), text);
            assertEquals(1, it.vmCount(), text);
        }
    }

    @Test
    void theCountDoesNotChangeTheSpecHash() {
        String one = interpreter.interpret("small ubuntu server on aws").specHash();
        String three = interpreter.interpret("3 small ubuntu servers on aws").specHash();
        assertEquals(one, three, "the hash is of one VM's spec; each of the three gets its own when built");
    }

    @Test
    void tooManyIsAQuestion() {
        Interpretation it = interpreter.interpret("50 servers on aws");
        assertNotNull(it.question());
        assertTrue(it.question().contains("up to 20"));
        Interpretation answered = interpreter.interpret("50 servers on aws. 12 servers");
        assertNull(answered.question());
        assertEquals(12, answered.vmCount());
    }
}
