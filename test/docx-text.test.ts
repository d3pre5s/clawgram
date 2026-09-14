import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { extractDocxText, extractPlainText } from "../src/docx-text";

function wordDocument(xml: string): Buffer {
  const name = Buffer.from("word/document.xml");
  const body = deflateRawSync(Buffer.from(xml));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(Buffer.byteLength(xml), 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(Buffer.byteLength(xml), 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([ local, name, body, central, name, end ]);
}

describe("extractDocxText", () => {
  it("extracts paragraphs, breaks and XML entities from word/document.xml", () => {
    const text = extractDocxText(wordDocument(
      '<w:document><w:body><w:p><w:r><w:t>Старший &amp; брат</w:t></w:r></w:p><w:p><w:r><w:t>Вторая</w:t><w:br/><w:t>строка</w:t></w:r></w:p></w:body></w:document>',
    ));

    assert.equal(text, "Старший & брат\nВторая\nстрока");
  });

  it("refuses a file that is not a DOCX zip", () => {
    assert.throws(() => extractDocxText(Buffer.from("not a zip")), /valid DOCX/);
  });

  it("keeps a UTF-8 text document legible and rejects binary input", () => {
    assert.equal(extractPlainText(Buffer.from("первая строка\r\nвторая")), "первая строка\nвторая");
    assert.throws(() => extractPlainText(Buffer.from([ 0x74, 0x00, 0x78 ])), /binary/);
  });
});
