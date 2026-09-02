import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { isReplyToSelfMessage, resolveReplyParent } from "../src/helpers";

/**
 * A reply that does not highlight a fragment carries no `quoteText`, and until
 * 2.20.1 that was the only reply context the channel forwarded. Core renders
 * `[Replying to: …]` from `ReplyToQuoteText ?? ReplyToBody`, so a plain reply
 * reached the agent as a bare parent id.
 *
 * The case that exposed this: the owner replied in a DM to the agent's own
 * notice about an unknown sender. The agent received "reply to #1011" with
 * nothing behind it, and — because the notice had been sent from another
 * session and DMs are outside `readChats` — could not recover the text by
 * any other route. Telegram already hands the parent over on request
 * (`getReplyMessage`), which the group path was calling for the
 * reply-to-self check and then throwing away.
 */

const SELF_ID = "7777";

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 1012,
    replyTo: { replyToMsgId: 1011 },
    message: "ты же видишь что он в чате управления",
    ...overrides,
  };
}

describe("resolveReplyParent", () => {
  test("a message that is not a reply resolves to nothing, without touching Telegram", async () => {
    let fetched = 0;
    const parent = await resolveReplyParent(
      message({ replyTo: undefined, getReplyMessage: async () => { fetched += 1; return {}; } }),
      { selfId: SELF_ID, selfLabel: "@tina" },
    );
    assert.deepEqual(parent, { isSelf: false });
    assert.equal(fetched, 0);
  });

  test("the agent's own outbound parent is labelled as the agent, with its text", async () => {
    const parent = await resolveReplyParent(
      message({
        getReplyMessage: async () => ({
          id: 1011,
          out: true,
          senderId: SELF_ID,
          message: "В личку написал @someone (890975818, не в реестре)",
        }),
      }),
      { selfId: SELF_ID, selfLabel: "@tina" },
    );
    assert.equal(parent.isSelf, true);
    assert.equal(parent.body, "В личку написал @someone (890975818, не в реестре)");
    assert.equal(parent.sender, "@tina");
  });

  test("someone else's parent is labelled by display name, then username, then id", async () => {
    const byName = await resolveReplyParent(
      message({
        getReplyMessage: async () => ({
          id: 5, out: false, senderId: 42, message: "привет",
          sender: { firstName: "Иван", lastName: "Петров", username: "ivan" },
        }),
      }),
      { selfId: SELF_ID, selfLabel: "@tina" },
    );
    assert.equal(byName.isSelf, false);
    assert.equal(byName.sender, "Иван Петров");
    assert.equal(byName.body, "привет");

    const byUsername = await resolveReplyParent(
      message({ getReplyMessage: async () => ({ id: 5, senderId: 42, message: "x", sender: { username: "ivan" } }) }),
      { selfId: SELF_ID },
    );
    assert.equal(byUsername.sender, "@ivan");

    const byId = await resolveReplyParent(
      message({ getReplyMessage: async () => ({ id: 5, senderId: 42, message: "x" }) }),
      { selfId: SELF_ID },
    );
    assert.equal(byId.sender, "42");
  });

  test("a parent sent by the self id counts as self even without the out flag", async () => {
    const parent = await resolveReplyParent(
      message({ getReplyMessage: async () => ({ id: 5, senderId: Number(SELF_ID), message: "x" }) }),
      { selfId: SELF_ID, selfLabel: "Тина" },
    );
    assert.equal(parent.isSelf, true);
    assert.equal(parent.sender, "Тина");
  });

  test("a media-only parent has no body but still resolves the sender", async () => {
    const parent = await resolveReplyParent(
      message({ getReplyMessage: async () => ({ id: 5, senderId: 42, message: "", sender: { firstName: "Аня" } }) }),
      { selfId: SELF_ID },
    );
    assert.equal(parent.body, undefined);
    assert.equal(parent.sender, "Аня");
  });

  test("a failed fetch degrades to no context, never to a rejected message", async () => {
    const parent = await resolveReplyParent(
      message({ getReplyMessage: async () => { throw new Error("FLOOD_WAIT"); } }),
      { selfId: SELF_ID },
    );
    assert.deepEqual(parent, { isSelf: false });

    const missing = await resolveReplyParent(
      message({ getReplyMessage: async () => undefined }),
      { selfId: SELF_ID },
    );
    assert.deepEqual(missing, { isSelf: false });
  });

  test("isReplyToSelfMessage keeps its answer", async () => {
    const self = await isReplyToSelfMessage(
      message({ getReplyMessage: async () => ({ id: 1011, out: true, message: "x" }) }),
      SELF_ID,
    );
    assert.equal(self, true);
    const other = await isReplyToSelfMessage(
      message({ getReplyMessage: async () => ({ id: 1011, senderId: 42, message: "x" }) }),
      SELF_ID,
    );
    assert.equal(other, false);
    assert.equal(await isReplyToSelfMessage(message(), undefined), false);
  });
});
