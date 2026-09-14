import { inflateRawSync } from "node:zlib";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const WORD_DOCUMENT_PATH = "word/document.xml";
const MAX_DOCUMENT_XML_BYTES = 2 * 1024 * 1024;
const TEXT_DOCUMENT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "xml", "html", "htm", "log", "rtf",
]);

type ZipEntry = {
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function findEndOfCentralDirectory(input: Buffer): number {
  // The optional ZIP comment is at most 65,535 bytes, so scanning this tail
  // avoids treating a matching four-byte sequence in compressed data as a
  // directory record.
  const start = Math.max(0, input.length - 65_557);
  for (let offset = input.length - 22; offset >= start; offset -= 1) {
    if (input.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("clawgram: attachment is not a valid DOCX zip");
}

function wordDocumentEntry(input: Buffer): ZipEntry {
  if (input.length < 22) {
    throw new Error("clawgram: attachment is not a valid DOCX zip");
  }
  const end = findEndOfCentralDirectory(input);
  const entryCount = input.readUInt16LE(end + 10);
  let offset = input.readUInt32LE(end + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > input.length || input.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("clawgram: attachment is not a valid DOCX zip");
    }
    const flags = input.readUInt16LE(offset + 8);
    const compressionMethod = input.readUInt16LE(offset + 10);
    const compressedSize = input.readUInt32LE(offset + 20);
    const uncompressedSize = input.readUInt32LE(offset + 24);
    const nameLength = input.readUInt16LE(offset + 28);
    const extraLength = input.readUInt16LE(offset + 30);
    const commentLength = input.readUInt16LE(offset + 32);
    const localHeaderOffset = input.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > input.length) {
      throw new Error("clawgram: attachment is not a valid DOCX zip");
    }
    const name = input.subarray(offset + 46, nameEnd).toString("utf8");
    if (name === WORD_DOCUMENT_PATH) {
      if ((flags & 0x1) !== 0) {
        throw new Error("clawgram: encrypted DOCX attachments are not supported");
      }
      return { compressionMethod, compressedSize, uncompressedSize, localHeaderOffset };
    }
    offset = nameEnd + extraLength + commentLength;
  }

  throw new Error("clawgram: DOCX has no word/document.xml");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_whole, source) => {
      const codePoint = String(source).toLowerCase().startsWith("x")
        ? Number.parseInt(String(source).slice(1), 16)
        : Number.parseInt(String(source), 10);
      const valid = Number.isInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && (codePoint < 0xd800 || codePoint > 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : "";
    });
}

function textFromWordXml(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:br\b[^>]*\/>/gi, "\n")
    .replace(/<w:cr\b[^>]*\/>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeXmlText(withBreaks)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Extracts plain text from the DOCX part the user explicitly asked to read. */
export function extractDocxText(input: Buffer): string {
  const entry = wordDocumentEntry(input);
  if (entry.uncompressedSize > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("clawgram: DOCX text is too large to read");
  }
  const local = entry.localHeaderOffset;
  if (local + 30 > input.length || input.readUInt32LE(local) !== LOCAL_FILE_SIGNATURE) {
    throw new Error("clawgram: attachment is not a valid DOCX zip");
  }
  const nameLength = input.readUInt16LE(local + 26);
  const extraLength = input.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > input.length || end > input.length) {
    throw new Error("clawgram: attachment is not a valid DOCX zip");
  }
  const compressed = input.subarray(start, end);
  const xml = entry.compressionMethod === 0
    ? compressed
    : entry.compressionMethod === 8
      ? inflateRawSync(compressed, { maxOutputLength: MAX_DOCUMENT_XML_BYTES })
      : undefined;
  if (!xml) {
    throw new Error(`clawgram: DOCX compression method ${entry.compressionMethod} is not supported`);
  }
  return textFromWordXml(xml.toString("utf8"));
}

export function isDocxDocument(mimeType: string | undefined, fileName: string | undefined): boolean {
  return mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || fileName?.toLowerCase().endsWith(".docx") === true;
}

export function isTextDocument(mimeType: string | undefined, fileName: string | undefined): boolean {
  if (mimeType?.startsWith("text/")) return true;
  const extension = fileName?.trim().split(".").pop()?.toLowerCase();
  return extension ? TEXT_DOCUMENT_EXTENSIONS.has(extension) : false;
}

/**
 * Plain-text attachments are kept as UTF-8. They are never silently decoded
 * as binary data, because replacement glyphs hide a wrong file type from the
 * agent and make its answer look trustworthy when it is not.
 */
export function extractPlainText(input: Buffer): string {
  if (input.length > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("clawgram: text document is too large to read");
  }
  if (input.includes(0)) {
    throw new Error("clawgram: attachment is binary, not a text document");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new Error("clawgram: text attachment is not valid UTF-8");
  }
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}
