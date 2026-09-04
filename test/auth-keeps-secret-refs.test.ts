import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { keepSecretRefs, secretRefFieldsFor } from "../src/update-config";

describe("re-auth keeps credentials that live in the secret store", () => {
  // An account whose apiHash/sessionString were migrated to a SecretRef had
  // them overwritten by the literal strings typed during `--auth`: the fresh
  // payload was spread on top of the reference. The operator got plaintext
  // credentials back into a file that is backed up and synced, with no warning.
  const ref = { source: "file", provider: "openclaw-secrets", id: "/clawgram/apiHash" };

  test("a SecretRef survives and is reported", () => {
    const { payload, kept } = keepSecretRefs(
      { apiHash: ref, sessionString: "literal-old" },
      { apiId: 1, apiHash: "typed-now", sessionString: "typed-session" },
    );
    assert.deepEqual(payload.apiHash, ref, "the reference must win");
    assert.equal(payload.sessionString, "typed-session", "a literal is replaced as before");
    assert.deepEqual(kept, [ "apiHash" ]);
  });

  test("both credentials can be references", () => {
    const { payload, kept } = keepSecretRefs(
      { apiHash: ref, sessionString: { ...ref, id: "/clawgram/session" } },
      { apiId: 1, apiHash: "typed-now", sessionString: "typed-session" },
    );
    assert.deepEqual(kept, [ "apiHash", "sessionString" ]);
    assert.notEqual(payload.sessionString, "typed-session");
  });

  test("an account without references is untouched", () => {
    const payloadIn = { apiId: 1, apiHash: "a", sessionString: "b" };
    const { payload, kept } = keepSecretRefs({}, payloadIn);
    assert.deepEqual(payload, payloadIn);
    assert.deepEqual(kept, []);
  });

  test("a half-written object is not a reference", () => {
    // asSecretRef requires source, provider and id — all non-empty strings.
    const { kept } = keepSecretRefs(
      { apiHash: { source: "file", provider: "openclaw-secrets" } },
      { apiHash: "typed-now" },
    );
    assert.deepEqual(kept, [], "an incomplete object must not shadow a real credential");
  });
});

describe("the operator is told what was not written", () => {
  const raw = JSON.stringify({
    channels: {
      clawgram: {
        accounts: {
          default: {
            apiId: 1,
            apiHash: { source: "file", provider: "openclaw-secrets", id: "/clawgram/apiHash" },
            sessionString: "literal",
          },
        },
      },
    },
  });

  test("names the fields kept as references", () => {
    assert.deepEqual(secretRefFieldsFor(raw, "default"), [ "apiHash" ]);
  });

  test("an unknown account or unreadable config reports nothing rather than throwing", () => {
    assert.deepEqual(secretRefFieldsFor(raw, "other"), []);
    assert.deepEqual(secretRefFieldsFor("{ not json", "default"), []);
  });
});
