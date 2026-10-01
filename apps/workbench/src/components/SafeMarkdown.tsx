import { useMemo } from "react";
import SafeInline, { type InlineSegment } from "./SafeInline";
import "./SafeMarkdown.css";

type TableAlignment = "left" | "center" | "right";
type TableRow = readonly (readonly InlineSegment[])[];

/** Minimal safe Markdown: no HTML injection; only HTTP(S) links become anchors. */
type Block =
  | { readonly kind: "heading"; readonly level: number; readonly segments: readonly InlineSegment[] }
  | { readonly kind: "paragraph"; readonly segments: readonly InlineSegment[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly InlineSegment[])[] }
  | { readonly kind: "table"; readonly header: TableRow; readonly alignment: readonly TableAlignment[]; readonly rows: readonly TableRow[] };

function parseToken(token: string): InlineSegment {
  if (token.startsWith("**")) return { kind: "strong", text: token.slice(2, -2) };
  if (token.startsWith("`")) return { kind: "code", text: token.slice(1, -1) };
  if (token.startsWith("[")) {
    const separator = token.indexOf("](");
    const label = token.slice(1, separator);
    const target = token.slice(separator + 2, -1);
    return /^https?:\/\//iu.test(target)
      ? { kind: "link", text: label, href: target }
      : { kind: "text", text: `${label}（链接协议不受支持，未渲染）` };
  }
  return { kind: "em", text: token.slice(1, -1) };
}

function parseInline(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push(parseToken(match[0]));
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** Pipes inside supported inline code and escaped pipes remain part of the cell. */
function tableCells(line: string): readonly string[] | null {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  let firstPipe = -1;
  let lastPipe = -1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\" && (text[index + 1] === "|" || text[index + 1] === "\\")) {
      cell += text[index + 1] === "|" ? "|" : "\\\\";
      index++;
    } else if (character === "`" && text.indexOf("`", index + 1) > index + 1) {
      const end = text.indexOf("`", index + 1);
      cell += text.slice(index, end + 1);
      index = end;
    } else if (character === "|") {
      if (firstPipe === -1) firstPipe = index;
      lastPipe = index;
      cells.push(cell.trim()); cell = "";
    } else cell += character;
  }
  if (firstPipe === -1) return null;
  cells.push(cell.trim());
  if (firstPipe === 0) cells.shift();
  if (lastPipe === text.length - 1) cells.pop();
  return cells;
}

function tableBlock(lines: readonly string[], start: number): { block: Block; next: number } | null {
  const header = tableCells(lines[start] ?? "");
  const separator = tableCells(lines[start + 1] ?? "");
  if (!header?.length || !separator || separator.length !== header.length || !header.some((cell) => cell !== "") ||
    !separator.every((cell) => /^:?-{3,}:?$/u.test(cell))) return null;
  const alignment: TableAlignment[] = separator.map((cell) => cell.startsWith(":") && cell.endsWith(":")
    ? "center" : cell.endsWith(":") ? "right" : "left");
  const rows: TableRow[] = [];
  let next = start + 2;
  while (next < lines.length) {
    const line = lines[next] ?? "";
    if (line.trim() === "" || /^(#{1,4})\s+/u.test(line) || line.trimStart().startsWith("```")) break;
    const cells = tableCells(line);
    if (!cells) break;
    // Keep malformed rows as source text instead of dropping or inventing cells.
    if (cells.length !== header.length) return null;
    rows.push(cells.map(parseInline));
    next++;
  }
  return { block: { kind: "table", header: header.map(parseInline), alignment, rows }, next };
}

function parseBlocks(source: string): readonly Block[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const result: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") { index++; continue; }
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) code.push(lines[index++] ?? "");
      index++;
      result.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (heading) { result.push({ kind: "heading", level: heading[1]?.length ?? 1, segments: parseInline(heading[2] ?? "") }); index++; continue; }
    const bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      const items: (readonly InlineSegment[])[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = ordered ? /^\s*\d+[.)]\s+(.*)$/u.exec(candidate) : /^\s*[-*]\s+(.*)$/u.exec(candidate);
        if (!match) break;
        items.push(parseInline(match[1] ?? ""));
        index++;
      }
      result.push({ kind: "list", ordered, items });
      continue;
    }
    const table = tableBlock(lines, index);
    if (table) { result.push(table.block); index = table.next; continue; }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim() === "" || /^(#{1,4})\s+/u.test(candidate) || candidate.trimStart().startsWith("```")) break;
      if (paragraph.length > 0 && tableBlock(lines, index)) break;
      paragraph.push(candidate);
      index++;
    }
    result.push({ kind: "paragraph", segments: parseInline(paragraph.join(" ")) });
  }
  return result;
}

export default function SafeMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return <div className="markdown-preview" data-testid="markdown-preview">{blocks.map((block, index) => {
    if (block.kind === "heading") return block.level <= 2
      ? <h3 key={index} className="markdown-preview__heading"><SafeInline segments={block.segments} /></h3>
      : <h4 key={index} className="markdown-preview__subheading"><SafeInline segments={block.segments} /></h4>;
    if (block.kind === "code") return <pre key={index} className="markdown-preview__code"><code>{block.text}</code></pre>;
    if (block.kind === "table") return <div key={index} className="markdown-preview__table-scroll"
      role="region" aria-label="Markdown 表格，较宽时可横向滚动" tabIndex={0}>
      <table className="markdown-preview__table"><thead><tr>{block.header.map((cell, column) =>
        <th key={column} scope="col" style={{ textAlign: block.alignment[column] }}><SafeInline segments={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) =>
          <td key={column} style={{ textAlign: block.alignment[column] }}><SafeInline segments={cell} /></td>)}</tr>)}</tbody>
      </table>
    </div>;
    if (block.kind === "list") {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}><SafeInline segments={item} /></li>);
      return block.ordered ? <ol key={index} className="markdown-preview__list">{items}</ol> : <ul key={index} className="markdown-preview__list">{items}</ul>;
    }
    return <p key={index} className="markdown-preview__paragraph"><SafeInline segments={block.segments} /></p>;
  })}</div>;
}
