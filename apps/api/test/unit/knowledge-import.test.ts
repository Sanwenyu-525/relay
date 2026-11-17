import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { extractDocument, detectFormat, decodeTextFile, displayFileName, fileStem, IMPORT_LIMITS }
  from "../../src/application/knowledge-import.js";

function zip(entries: readonly { name: string; data: Buffer; method?: number;
  declaredUncompressed?: number; declaredCompressed?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const compressed = entry.declaredCompressed ?? payload.length;
    const uncompressed = entry.declaredUncompressed ?? entry.data.length;
    const local = Buffer.alloc(30 + name.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    payload.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(Buffer.concat(locals).length, 16);
  return Buffer.concat([...locals, directory, end]);
}

function docx(bodyXml: string, options: { method?: number; declaredUncompressed?: number } = {}): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: "word/document.xml", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`),
      ...options },
  ]);
}

function pdf(stream: string): Buffer {
  return pdfStreams([{ data: Buffer.from(stream, "latin1") }]);
}

function pdfStreams(streams: readonly { data: Buffer; flate?: boolean }[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj
`, "latin1")];
  for (const [index, stream] of streams.entries()) {
    const payload = stream.flate === true ? deflateRawSync(stream.data) : stream.data;
    const filter = stream.flate === true ? " /Filter /FlateDecode" : "";
    parts.push(Buffer.from(`${index + 3} 0 obj << /Length ${payload.length}${filter} >> stream
`, "latin1"), payload, Buffer.from(`
endstream endobj
`, "latin1"));
  }
  parts.push(Buffer.from(`trailer << /Root 1 0 R >>
%%EOF`, "latin1"));
  return Buffer.concat(parts);
}

test("格式由魔数与结构判定，不信任扩展名", () => {
  assert.equal(detectFormat(Buffer.from("%PDF-1.4\n"), "a.txt", "text/plain"), "PDF");
  assert.equal(detectFormat(Buffer.from("<!doctype html><p>x</p>"), "a.txt", "text/plain"), "HTML");
  assert.equal(detectFormat(Buffer.from("# 标题\n正文"), "a.md", "text/markdown"), "MARKDOWN");
  assert.equal(detectFormat(Buffer.from("纯文本"), "a.txt", "text/plain"), "TEXT");
  assert.equal(detectFormat(docx("<w:p><w:r><w:t>x</w:t></w:r></w:p>"), "a.docx", ""), "DOCX");
  assert.equal(detectFormat(Buffer.from("PK\u0003\u0004 not a docx"), "a.docx", ""), null);
  assert.equal(detectFormat(Buffer.from([0x00, 0x01, 0x02]), "a.txt", ""), null);
});

test("Markdown / TXT 提取正文，BOM 与 GB18030 都能解码", () => {
  const markdown = extractDocument({ name: "设计.md", mediaType: "text/markdown",
    buffer: Buffer.from("# 架构\n\n正文内容", "utf8") });
  assert.equal(markdown.ok, true);
  if (markdown.ok) {
    assert.equal(markdown.document.format, "MARKDOWN");
    // 标题建议优先使用文档 H1，文件名只是没有标题时的兜底；这是 0167 的产品行为。
    assert.equal(markdown.document.title, "架构");
    assert.equal(markdown.document.text, "# 架构\n\n正文内容");
    assert.equal(markdown.document.textBytes, Buffer.byteLength("# 架构\n\n正文内容", "utf8"));
  }
  const bom = extractDocument({ name: "笔记.txt", mediaType: "text/plain",
    buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文正文", "utf8")]) });
  assert.equal(bom.ok, true);
  if (bom.ok) assert.equal(bom.document.text, "中文正文");
  const legacy = decodeTextFile(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.equal(typeof legacy, "string");
});

test("HTML 去脚本样式并解实体，不把标签当正文", () => {
  const result = extractDocument({ name: "网页.html", mediaType: "text/html",
    buffer: Buffer.from(`<!doctype html><html><head><title>知识页</title><style>.x{}</style></head>
      <body><script>alert(1)</script><h1>标题</h1><p>正文 &amp; 内容</p></body></html>`, "utf8") });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.document.format, "HTML");
  assert.equal(result.document.title, "知识页");
  assert.equal(result.document.detail.page_title, "知识页");
  assert.match(result.document.text, /标题/u);
  assert.match(result.document.text, /正文 & 内容/u);
  assert.ok(!result.document.text.includes("alert"));
  assert.ok(!result.document.text.includes("<h1>"));
});

test("DOCX 从 word/document.xml 提取段落，不保留标签", () => {
  const result = extractDocument({ name: "需求.docx", mediaType: "",
    buffer: docx("<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>") });
  if (!result.ok) { console.log("docx failure", result.failure, result.message);
    assert.fail(`DOCX 提取失败: ${result.failure}`); }
  assert.equal(result.ok, true);
  assert.equal(result.document.format, "DOCX");
  assert.equal(result.document.text, "第一段\n\n第二段");
  assert.equal(result.document.detail.paragraphs, "2");
});

test("PDF 只提取文本层；扫描件返回 NO_TEXT 而不是空成功", () => {
  const text = extractDocument({ name: "规范.pdf", mediaType: "application/pdf",
    buffer: pdf("BT /F1 12 Tf (Knowledge Base) Tj ET") });
  assert.equal(text.ok, true);
  if (text.ok) {
    assert.equal(text.document.format, "PDF");
    assert.equal(text.document.text, "Knowledge Base");
    assert.equal(text.document.detail.streams, "1");
  }
  const scanned = extractDocument({ name: "扫描.pdf", mediaType: "application/pdf",
    buffer: pdf("q 200 0 0 200 0 0 cm /Im1 Do") });
  assert.equal(scanned.ok, false);
  if (!scanned.ok) {
    assert.equal(scanned.failure, "NO_TEXT");
    assert.match(scanned.message, /没有 OCR/u);
  }
});

test("失败边界：空文件、超限、扩展名不符、无正文", () => {
  const empty = extractDocument({ name: "空.txt", mediaType: "text/plain", buffer: Buffer.alloc(0) });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.failure, "EMPTY_FILE");

  const mismatch = extractDocument({ name: "伪装.pdf", mediaType: "application/pdf",
    buffer: Buffer.from("这其实是纯文本") });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.failure, "MALFORMED");

  const blank = extractDocument({ name: "空白.txt", mediaType: "text/plain",
    buffer: Buffer.from(" \r\n\t ") });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.failure, "NO_TEXT");

  const binary = extractDocument({ name: "图片.png", mediaType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) });
  assert.equal(binary.ok, false);
  if (!binary.ok) assert.equal(binary.failure, "UNSUPPORTED_FORMAT");
});

test("正文上限 256 KB 以提取文本计，超限明确拒绝", () => {
  const text = "知识".repeat(IMPORT_LIMITS.maxTextBytes / 3 + 10);
  const result = extractDocument({ name: "长.txt", mediaType: "text/plain",
    buffer: Buffer.from(text, "utf8") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure, "TEXT_TOO_LARGE");
});

test("文件名只保留最后一段，不产生路径语义", () => {
  assert.equal(displayFileName("../../etc/passwd"), "passwd");
  assert.equal(displayFileName("C:\\secret\\计划.md"), "计划.md");
  assert.equal(displayFileName("   "), "未命名文件");
  assert.equal(fileStem("目录/需求.v2.docx"), "需求.v2");
  assert.equal(fileStem("无扩展名"), "无扩展名");
  assert.equal(fileStem(""), "未命名文件");
});

test("ZIP reader 对损坏的 docx 返回可读失败而不是崩溃", () => {
  const corrupt = Buffer.concat([Buffer.from("PK\u0003\u0004", "binary"), Buffer.alloc(20, 0)]);
  const result = extractDocument({ name: "坏.docx", mediaType: "", buffer: corrupt });
  assert.equal(result.ok, false);
});

test("DOCX 解压使用固定资源上限，不信任攻击者声明的未压缩大小", () => {
  const declared = docx("<w:p><w:r><w:t>正文</w:t></w:r></w:p>",
    { declaredUncompressed: IMPORT_LIMITS.maxZipEntryUncompressedBytes + 1 });
  const result = extractDocument({ name: "bomb.docx", mediaType: "", buffer: declared });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure, "MALFORMED");
    assert.match(result.message, /安全上限/u);
  }
});

test("DOCX 声明大小与实际解压不一致、CRC 损坏都拒绝", () => {
  const mismatch = docx("<w:p><w:r><w:t>正文</w:t></w:r></w:p>", { declaredUncompressed: 10 });
  const mismatchResult = extractDocument({ name: "mismatch.docx", mediaType: "", buffer: mismatch });
  assert.equal(mismatchResult.ok, false);
  if (!mismatchResult.ok) assert.equal(mismatchResult.failure, "MALFORMED");

  const valid = docx("<w:p><w:r><w:t>CRC 正文</w:t></w:r></w:p>");
  const crcBroken = Buffer.from(valid);
  // 改正文数据但保留中央目录 CRC，读取时必须失败。
  const markerAt = crcBroken.indexOf(Buffer.from("CRC 正文", "utf8"));
  assert.ok(markerAt >= 0);
  crcBroken.writeUInt8(0x44, markerAt);
  const crcResult = extractDocument({ name: "crc.docx", mediaType: "", buffer: crcBroken });
  assert.equal(crcResult.ok, false);
});

test("DOCX 支持 deflate 条目，非法中央目录与截断 ZIP 都失败", () => {
  const deflated = docx("<w:p><w:r><w:t>压缩正文</w:t></w:r></w:p>", { method: 8 });
  const deflatedResult = extractDocument({ name: "deflate.docx", mediaType: "", buffer: deflated });
  assert.equal(deflatedResult.ok, true);
  if (deflatedResult.ok) assert.equal(deflatedResult.document.text, "压缩正文");

  const badCentral = Buffer.from(deflated);
  const central = badCentral.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  badCentral[central] = 0;
  const badCentralResult = extractDocument({ name: "central.docx", mediaType: "", buffer: badCentral });
  assert.equal(badCentralResult.ok, false);

  const truncated = deflated.subarray(0, deflated.length - 12);
  const truncatedResult = extractDocument({ name: "truncated.docx", mediaType: "", buffer: truncated });
  assert.equal(truncatedResult.ok, false);
});

test("PDF 支持 Flate 流；单流超限、累计超限和流数量超限都明确拒绝", () => {
  const flate = extractDocument({ name: "flate.pdf", mediaType: "application/pdf",
    buffer: pdfStreams([{ data: Buffer.from("BT /F1 12 Tf (Flate Knowledge) Tj ET", "latin1"),
      flate: true }]) });
  assert.equal(flate.ok, true);
  if (flate.ok) assert.equal(flate.document.text, "Flate Knowledge");

  const oneBomb = pdfStreams([{ data: Buffer.alloc(9 * 1024 * 1024, 0x41), flate: true }]);
  const oneResult = extractDocument({ name: "one-bomb.pdf", mediaType: "application/pdf", buffer: oneBomb });
  assert.equal(oneResult.ok, false);
  if (!oneResult.ok) assert.equal(oneResult.failure, "RESOURCE_LIMIT");

  const cumulative = pdfStreams([
    { data: Buffer.alloc(6 * 1024 * 1024, 0x42), flate: true },
    { data: Buffer.alloc(6 * 1024 * 1024, 0x43), flate: true },
    { data: Buffer.alloc(6 * 1024 * 1024, 0x44), flate: true },
  ]);
  const cumulativeResult = extractDocument({ name: "cumulative.pdf", mediaType: "application/pdf",
    buffer: cumulative });
  assert.equal(cumulativeResult.ok, false);
  if (!cumulativeResult.ok) assert.equal(cumulativeResult.failure, "RESOURCE_LIMIT");

  const many = pdfStreams(Array.from({ length: IMPORT_LIMITS.maxPdfStreams + 1 },
    () => ({ data: Buffer.from("q 1 0 0 1 0 0 cm", "latin1") })));
  const manyResult = extractDocument({ name: "many.pdf", mediaType: "application/pdf", buffer: many });
  assert.equal(manyResult.ok, false);
  if (!manyResult.ok) assert.equal(manyResult.failure, "RESOURCE_LIMIT");
});

test("截断 PDF 与恶意数字实体不崩溃", () => {
  const complete = pdf("BT /F1 12 Tf (Text) Tj ET");
  const end = complete.indexOf(Buffer.from("endstream", "latin1"));
  const truncated = complete.subarray(0, end + 2);
  const truncatedResult = extractDocument({ name: "truncated.pdf", mediaType: "application/pdf",
    buffer: truncated });
  assert.equal(truncatedResult.ok, false);
  if (!truncatedResult.ok) assert.equal(truncatedResult.failure, "MALFORMED");

  const html = Buffer.from(`<html><head><title>x</title></head><body>&#999999999; &#xD800;</body></html>`, "utf8");
  const htmlResult = extractDocument({ name: "entity.html", mediaType: "text/html", buffer: html });
  // 恶意数字实体不能触发 RangeError；非法码点被丢弃，只保留合法标题文本。
  assert.equal(htmlResult.ok, true);
  if (htmlResult.ok) {
    assert.ok(!htmlResult.document.text.includes("999999999"));
    assert.ok(!/\uD800/u.test(htmlResult.document.text));
  }
});
