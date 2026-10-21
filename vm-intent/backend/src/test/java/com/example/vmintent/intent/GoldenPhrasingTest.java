package com.example.vmintent.intent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The "golden set": many ways of asking for the same VM must produce the
 * exact same spec hash. Add a line here whenever users phrase things in a
 * new way — if a change to the interpreter breaks one, the build fails.
 */
class GoldenPhrasingTest {

    private final IntentInterpreter interpreter = new IntentInterpreter(new RuleBasedIntentExtractor());

    private final String expectedHash =
            interpreter.interpret("aws ubuntu 24.04, 4 vcpu, 16 GiB RAM, 50 GiB ssd, us-east, dev").specHash();

    @ParameterizedTest
    @ValueSource(strings = {
            "Ubuntu box, 4 cores, 16 gigs, us-east on AWS",
            "I need a medium Linux server in Virginia on Amazon",
            "aws ec2 ubuntu 24.04 4 vcpu 16GB RAM us-east-1",
            "Can you spin up a medium-sized ubuntu VM in AWS N. Virginia?",
            "four cores and sixteen gigabytes of memory, ubuntu, amazon, east coast"
    })
    void samePhrasingsGiveSameSpec(String text) {
        Interpretation result = interpreter.interpret(text);
        assertNull(result.question(), "should not need a clarifying question");
        assertEquals(expectedHash, result.specHash(), "spec drifted for: " + text);
    }

    @Test
    void asksWhenPlatformIsMissing() {
        Interpretation result = interpreter.interpret("I need a big linux machine");
        assertNotNull(result.question());
        assertNull(result.spec());
    }

    @Test
    void answeringTheQuestionCompletesTheSpec() {
        Interpretation result = interpreter.interpret("I need a big linux machine. azure");
        assertNull(result.question());
        assertEquals("azure", result.spec().provider());
        assertEquals(8, result.spec().vcpu());
    }
}
