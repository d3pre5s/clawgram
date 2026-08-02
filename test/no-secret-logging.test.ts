import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

// Static guards, not behavioural tests. Message bodies and credentials leaking
// into logs or stdout is the kind of regression that a unit test never catches
// (the code still "works") and that a reviewer reads straight past — so the
// shape of the source is asserted instead.
//
// Both were real: 2.0.0 logged the full outbound text on every send, and the
// --auth flow printed the session string unconditionally. ClawHub's scanner
// flagged them; the fix landed in 2.1.0.

const SRC = path.resolve(__dirname, "..", "..", "src");
const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");

// Keys whose value is message content or a credential. `textLength` is fine,
// `text` is not — hence the exact-match check on the key name.
const FORBIDDEN_LOG_KEYS = new Set([
  "text",
  "body",
  "caption",
  "content",
  "messageText",
  "apiHash",
  "sessionString",
  "password",
]);

type LogCall = { name: string; line: number; keys: string[] };

/** Extracts every `log(...)`-shaped call whose second argument is an object literal. */
function collectLogCalls(source: string): LogCall[] {
  const calls: LogCall[] = [];
  const callStart = /(?:actionLog\.(?:info|warn|error|debug)|log\??\.\w+\??)\(\s*"([^"]+)"\s*,\s*\{/g;

  for (let match = callStart.exec(source); match; match = callStart.exec(source)) {
    const objectStart = source.indexOf("{", match.index);
    let depth = 0;
    let end = objectStart;

    for (; end < source.length; end += 1) {
      if (source[ end ] === "{") depth += 1;
      else if (source[ end ] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = source.slice(objectStart, end + 1);
    // Top-level-ish key names; nested objects are included on purpose — a body
    // hidden one level deeper is still a body in the journal.
    const keys = [ ...body.matchAll(/(\w+)\s*:/g) ].map((m) => m[ 1 ]);

    calls.push({
      name: match[ 1 ],
      line: source.slice(0, match.index).split("\n").length,
      keys,
    });
  }

  return calls;
}

describe("no message bodies or credentials in logs", () => {
  for (const file of [ "channel.ts", "gramjs-client.ts", "history.ts", "joins.ts", "normalize.ts" ]) {
    test(`${file} log calls carry no content or credential keys`, () => {
      const offenders = collectLogCalls(read(file))
        .map((call) => ({ ...call, bad: call.keys.filter((key) => FORBIDDEN_LOG_KEYS.has(key)) }))
        .filter((call) => call.bad.length > 0)
        .map((call) => `${file}:${call.line} "${call.name}" logs ${call.bad.join(", ")}`);

      assert.deepEqual(offenders, [], offenders.join("\n"));
    });
  }

  test("outbound send logs the text length, not the text", () => {
    const source = read("channel.ts");
    assert.match(source, /textLength: ctx\.text\.length/);
    assert.doesNotMatch(source, /actionLog\.info\("clawgram outbound sendText",[\s\S]{0,300}?\btext: ctx\.text\b/);
  });
});

describe("the auth flow does not print the session string unprompted", () => {
  const source = read("cli-core.ts");

  test("no bare console.log of the session string", () => {
    assert.doesNotMatch(source, /console\.log\(\s*auth\.sessionString\s*\)/);
    assert.doesNotMatch(source, /console\.log\(\s*`?\$?\{?\s*auth\.sessionString\s*\}?`?\s*\)/);
  });

  test("every manual fragment print is preceded by the credential warning", () => {
    const fragmentPrints = [ ...source.matchAll(/console\.log\("JSON fragment for manual insertion:"\);/g) ];
    assert.ok(fragmentPrints.length > 0, "expected the manual-fragment path to still exist");

    for (const print of fragmentPrints) {
      const preceding = source.slice(Math.max(0, print.index - 200), print.index);
      assert.match(
        preceding,
        /printSecretWarning\(\);\s*$/,
        `fragment print at offset ${print.index} is not preceded by printSecretWarning()`,
      );
    }
  });
});
