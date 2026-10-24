package com.example.vmintent.catalog;

import com.example.vmintent.catalog.CatalogModels.Classification;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The data classifications: each is a code with a text mapped to it, and the code decides how long
 * a run's history and its access decisions are kept (1 to 5 years).
 *
 * Read from vmintent.audit.classifications-file (VMINTENT_CLASSIFICATIONS_FILE), or the built-in
 * classifications.yaml, whose codes are placeholders until the real scheme is known:
 *
 *   default: C1
 *   classifications:
 *     - code: C1
 *       label: Placeholder - kept 1 year
 *       retentionYears: 1
 */
@Component
public class ClassificationCatalog {

    private static final Logger log = LoggerFactory.getLogger(ClassificationCatalog.class);
    static final Pattern CODE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,19}");

    private final Map<String, Classification> byCode;
    private final String defaultCode;

    @org.springframework.beans.factory.annotation.Autowired
    public ClassificationCatalog(@Value("${vmintent.audit.classifications-file:}") String file,
                                 @Value("${vmintent.audit.default-classification:}") String defaultOverride) {
        Map<String, Object> doc;
        try (InputStream in = file == null || file.isBlank()
                ? new ClassPathResource("classifications.yaml").getInputStream()
                : Files.newInputStream(Path.of(file))) {
            doc = new Yaml(new SafeConstructor(new LoaderOptions())).load(in);
        } catch (Exception e) {
            throw new IllegalStateException("Can't read the classifications from "
                    + (file == null || file.isBlank() ? "classifications.yaml" : file) + ": " + e.getMessage(), e);
        }
        ClassificationCatalog parsed = parse(doc, defaultOverride);
        this.byCode = parsed.byCode;
        this.defaultCode = parsed.defaultCode;
        log.info("Data classifications: {} (default {})", byCode.keySet(), defaultCode);
    }

    private ClassificationCatalog(Map<String, Classification> byCode, String defaultCode) {
        this.byCode = byCode;
        this.defaultCode = defaultCode;
    }

    /** For tests and tools: the same rules, from an already-read YAML map. */
    public static ClassificationCatalog of(Map<String, Object> doc, String defaultOverride) {
        return parse(doc, defaultOverride);
    }

    private static ClassificationCatalog parse(Map<String, Object> doc, String defaultOverride) {
        if (doc == null || !(doc.get("classifications") instanceof List<?> list) || list.isEmpty()) {
            throw new IllegalStateException("classifications: needs a list of {code, label, retentionYears}");
        }
        Map<String, Classification> out = new LinkedHashMap<>();
        List<String> problems = new ArrayList<>();
        for (Object o : list) {
            if (!(o instanceof Map<?, ?> m)) {
                problems.add("each classification needs code, label and retentionYears");
                continue;
            }
            String code = m.get("code") == null ? null : String.valueOf(m.get("code")).trim();
            String label = m.get("label") == null ? null : String.valueOf(m.get("label")).trim();
            Object years = m.get("retentionYears");
            if (code == null || !CODE.matcher(code).matches()) {
                problems.add("code '" + code + "': up to 20 letters, digits, '.', '_' or '-'");
                continue;
            }
            if (label == null || label.isEmpty()) problems.add(code + ": needs a label (the text for the code)");
            if (!(years instanceof Integer y) || y < 1 || y > 5) {
                problems.add(code + ": retentionYears must be 1 to 5");
                continue;
            }
            if (out.put(code, new Classification(code, label, y)) != null) problems.add(code + ": listed twice");
        }
        String dflt = defaultOverride != null && !defaultOverride.isBlank() ? defaultOverride.trim()
                : doc.get("default") == null ? null : String.valueOf(doc.get("default")).trim();
        if (dflt == null) problems.add("default: say which code applies when none is given");
        else if (!out.containsKey(dflt)) problems.add("default: '" + dflt + "' isn't one of the codes");
        if (!problems.isEmpty()) throw new IllegalStateException("Classifications: " + String.join("; ", problems));
        return new ClassificationCatalog(Collections.unmodifiableMap(out), dflt);
    }

    public List<Classification> all() {
        return List.copyOf(byCode.values());
    }

    public boolean exists(String code) {
        return code != null && byCode.containsKey(code);
    }

    public Classification get(String code) {
        Classification c = byCode.get(code);
        if (c == null) throw new IllegalArgumentException("'" + code + "' isn't a classification code (codes: " + byCode.keySet() + ")");
        return c;
    }

    public Classification defaultClassification() {
        return byCode.get(defaultCode);
    }

    /** The given code, else the default. */
    public Classification orDefault(String code) {
        return code == null || code.isBlank() ? defaultClassification() : get(code);
    }
}
