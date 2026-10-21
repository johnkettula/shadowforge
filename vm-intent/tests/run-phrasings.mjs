// Runs every phrasing in phrasings.json against the running backend and
// reports pass/fail. Start the backend first (2-start-backend.cmd), then:
//
//   node tests/run-phrasings.mjs                 (original 100)
//   node tests/run-phrasings.mjs phrasings-holdout.json   (fresh 100)
//
// Or double-click tests/run-phrasings.cmd. Exit code 1 if anything fails.

import { readFile } from "node:fs/promises";

const API = process.env.VMINTENT_API ?? "http://localhost:8080/api/v2/interpret";
const file = process.argv[2] ?? "phrasings.json";
const data = JSON.parse(await readFile(new URL(`./${file}`, import.meta.url), "utf8"));
console.log(`Running ${file} against ${API}\n`);

async function check(text, expect, expectQuestion) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const r = await res.json();
  const diffs = [];
  if (expectQuestion) {
    if (!r.question) diffs.push(`no question; built: ${r.summary}`);
  } else if (r.question) {
    diffs.push(`asked: ${r.question}`);
  } else {
    for (const [k, want] of Object.entries(expect)) {
      if (r.spec[k] !== want) diffs.push(`${k}=${JSON.stringify(r.spec[k])} (want ${JSON.stringify(want)})`);
    }
  }
  return diffs;
}

let passed = 0;
let total = 0;
const failures = [];

// Generated files list individual cases; wrap them as one group per file.
const groups = data.groups ?? [{
  id: "GEN", label: `${data.cases.length} generated cases`,
  cases: data.cases,
}];

for (const group of groups) {
  if (group.cases) {
    let groupPassed = 0;
    for (const c of group.cases) {
      total++;
      const diffs = await check(c.text, c.expect, c.expectQuestion);
      if (diffs.length === 0) { passed++; groupPassed++; } else failures.push({ id: c.id, text: c.text, diffs });
    }
    console.log(`${group.id.padEnd(4)} ${groupPassed}/${group.cases.length}  ${group.label}`);
    continue;
  }
  let groupPassed = 0;
  for (const [i, text] of group.phrasings.entries()) {
    total++;
    const id = `${group.id}.${i + 1}`;
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const r = await res.json();
    const diffs = [];

    if (group.expectQuestion) {
      if (!r.question) diffs.push(`no question; built: ${r.summary}`);
    } else if (r.question) {
      diffs.push(`asked: ${r.question}`);
    } else {
      for (const [k, want] of Object.entries(group.expect)) {
        if (r.spec[k] !== want) diffs.push(`${k}=${JSON.stringify(r.spec[k])} (want ${JSON.stringify(want)})`);
      }
    }

    if (diffs.length === 0) {
      passed++;
      groupPassed++;
    } else {
      failures.push({ id, text, diffs });
    }
  }
  console.log(`${group.id.padEnd(4)} ${String(groupPassed).padStart(2)}/${group.phrasings.length}  ${group.label}`);
}

console.log("");
for (const f of failures) {
  console.log(`FAIL ${f.id}  "${f.text}"`);
  console.log(`     ${f.diffs.join("; ")}`);
}
console.log("");
console.log(`${passed} of ${total} passed`);
process.exitCode = failures.length === 0 ? 0 : 1;
