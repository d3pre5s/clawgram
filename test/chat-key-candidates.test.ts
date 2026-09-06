import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { chatKeyCandidates, isChatReadable, parseTargetWithThread } from "../src/history";
import { isChatManageable } from "../src/manage";
import { isChatSendable } from "../src/send-scope";

/**
 * The gates compared the raw spelling of a target, but a target arrives in
 * several: `-1001234`, `clawgram:-1001234` (core's channel prefix),
 * `-1001234:topic:5` (a forum topic). Those forms are parsed in
 * `gramjs-client`, which runs *after* the gate — so a chat honestly listed in
 * `readChats` was refused as soon as core addressed it with a prefix
 * (finding A5-17).
 */
describe("chat key candidates", () => {
  test("every spelling of one chat collapses to the same set", () => {
    for (const spelling of [
      "-1001234",
      "clawgram:-1001234",
      "tg:-1001234",
      "telegram:-1001234",
      "group:-1001234",
      " -1001234 ",
      "-1001234:topic:5",
      "-1001234:5",
      "clawgram:-1001234:5",
    ]) {
      assert.ok(chatKeyCandidates(spelling).includes("-1001234"), spelling);
    }
  });

  // The resolver accepts `-1001234:5` as topic 5 of chat -1001234; the gates
  // used to see an unknown chat named "-1001234:5" and refuse a listed one
  // (finding B5-08). Twin of the resolver's own reading, through the gates.
  test("the short topic spelling is the same chat to the gates as to the resolver", () => {
    const scope = [ "-1001234" ];
    assert.deepEqual(parseTargetWithThread("-1001234:5"), { raw: "-1001234:5", chatId: "-1001234", messageThreadId: 5 });
    assert.equal(isChatReadable("-1001234:5", scope), true);
    assert.equal(isChatManageable("-1001234:5", scope), true);
    assert.equal(isChatSendable("-1001234:5", scope), true);
    // A non-numeric chat keeps its colon: `@name:5` is not a topic spelling.
    assert.deepEqual(chatKeyCandidates("@name:5"), [ "name:5" ]);
    assert.equal(isChatReadable("-1005678:5", scope), false);
  });

  test("all three gates admit a listed chat under any spelling", () => {
    const scope = [ "-1001234" ];
    for (const spelling of [ "-1001234:topic:5", "clawgram:-1001234", "group:-1001234" ]) {
      assert.equal(isChatReadable(spelling, scope), true, `read ${spelling}`);
      assert.equal(isChatManageable(spelling, scope), true, `manage ${spelling}`);
      assert.equal(isChatSendable(spelling, scope), true, `send ${spelling}`);
    }
  });

  test("a chat outside the list is still refused under every spelling", () => {
    const scope = [ "-1001234" ];
    for (const spelling of [ "-1009999", "clawgram:-1009999", "-1009999:topic:5" ]) {
      assert.equal(isChatReadable(spelling, scope), false, `read ${spelling}`);
      assert.equal(isChatSendable(spelling, scope), false, `send ${spelling}`);
    }
  });

  test("Telegram's service chat stays refused under a prefixed spelling", () => {
    // Раньше отказ сравнивал сырое написание: под `readChats: ["*"]`
    // `clawgram:777000` проходил, и агент мог прочитать коды входа в
    // собственный аккаунт. Отказ этого чата безусловен по построению.
    for (const spelling of [ "777000", "clawgram:777000", "tg:777000", "telegram:777000" ]) {
      assert.equal(isChatReadable(spelling, [ "*" ]), false, spelling);
    }
  });

  test("a scope entry naming one topic still means that topic only", () => {
    assert.equal(isChatReadable("-1001234:topic:5", [ "-1001234:topic:5" ]), true);
    assert.equal(isChatReadable("-1001234", [ "-1001234:topic:5" ]), false,
      "collapsing everything to the chat would silently widen the scope");
  });
});
