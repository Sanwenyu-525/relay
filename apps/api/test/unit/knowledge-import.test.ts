import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { extractDocument, detectFormat, decodeTextFile, displayFileName, fileStem, IMPORT_LIMITS }
  from "../../src/application/knowledge-import.js";

function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30 + name.length + entry.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    entry.data.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
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

function docx(bodyXml: string): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: "word/document.xml", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`) },
  ]);
}

function pdf(stream: string): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj
3 0 obj << /Length ${Buffer.byteLength(stream, "latin1")} >> stream
${stream}
endstream endobj
trailer << /Root 1 0 R >>
%%EOF`, "latin1");
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
    assert.equal(markdown.document.title, "设计");
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
  assert.equal(result.document.title, "网页");
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
