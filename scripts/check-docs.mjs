/*
 * 轻量文档检查器：只解析当前仓库使用的内联链接和 ATX 标题，不是完整 Markdown 解析器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootReal = fs.realpathSync(root);
const errors = [];
const counts = { markdown: 0, links: 0, anchors: 0, tokens: 0, contrasts: 0 };
const rootMarkdown = [
  'README.md',
  'AGENTS.md',
  'CODEX_NEXT_STEP.md',
  'task_plan.md',
  'progress.md',
  'findings.md',
  'Personal_Workflow_OS_Master_Spec.md',
  'architecture-review.md',
];
const tokenTypes = new Set([
  'color',
  'dimension',
  'number',
  'fontFamily',
  'fontWeight',
  'duration',
  'cubicBezier',
  'shadow',
]);

const relativePath = (filePath) => (path.relative(root, filePath) || '.').split(path.sep).join('/');
function report(message, filePath, line) {
  errors.push(`${filePath ? `${relativePath(filePath)}${line ? `:${line}` : ''}：` : ''}${message}`);
}
function insideRoot(filePath) {
  const relative = path.relative(rootReal, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function decode(value, filePath, line) {
  try {
    return decodeURIComponent(value);
  } catch {
    report(`路径或锚点包含无效百分号编码：${value}`, filePath, line);
    return null;
  }
}

function maskInlineCode(line) {
  const masked = line.split('');
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '`') continue;
    let length = 1;
    while (line[index + length] === '`') length += 1;
    const marker = '`'.repeat(length);
    const endMarker = line.indexOf(marker, index + length);
    const end = endMarker === -1 ? line.length : endMarker + length;
    for (let cursor = index; cursor < end; cursor += 1) masked[cursor] = ' ';
    index = end - 1;
  }
  return masked.join('');
}

function destination(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return (value.match(/^\S+/u)?.[0] ?? value).replace(/\\([\\()])/gu, '$1');
}

function linksInLine(line) {
  const masked = maskInlineCode(line);
  const links = [];
  const pattern = /(!?)\[([^\]]*)\]\(([^)\n]*)\)/gu;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    const opening = match.index + match[0].indexOf('(') + 1;
    links.push({
      image: match[1] === '!',
      destination: destination(line.slice(opening, match.index + match[0].length - 1)),
    });
  }
  return links;
}

function fenceMarker(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})/u);
  return match ? { character: match[1][0], length: match[1].length } : null;
}
function isFenceEnd(line, fence) {
  return new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`, 'u').test(line);
}

function headingSlug(value) {
  const text = value
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/gu, '')
    .replace(/[*~]/gu, '')
    .toLowerCase();
  return [...text]
    .filter((character) => /[\p{Letter}\p{Number}\p{Mark}\s_-]/u.test(character))
    .join('')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function parseMarkdown(content) {
  const anchors = new Set();
  const used = new Set();
  const duplicateCounts = new Map();
  const links = [];
  let fence = null;
  for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
    if (fence) {
      if (isFenceEnd(line, fence)) fence = null;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      fence = marker;
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}(?:[ \t]+(.*?)\s*#*\s*|\s*)$/u);
    if (heading) {
      const base = headingSlug(heading[1] ?? '');
      if (base) {
        let number = duplicateCounts.get(base) ?? 0;
        let slug = number ? `${base}-${number}` : base;
        while (used.has(slug)) slug = `${base}-${++number}`;
        duplicateCounts.set(base, number + 1);
        used.add(slug);
        anchors.add(slug);
        counts.anchors += 1;
      }
    }
    for (const link of linksInLine(line)) links.push({ ...link, line: lineIndex + 1 });
  }
  return { anchors, links };
}

function walkMarkdown(directory, files) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkMarkdown(filePath, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.add(path.resolve(filePath));
  }
}
function markdownFiles() {
  const files = new Set();
  for (const name of rootMarkdown) {
    const filePath = path.join(root, name);
    if (fs.existsSync(filePath)) files.add(path.resolve(filePath));
  }
  for (const directory of ['docs', 'contracts', 'prompts']) walkMarkdown(path.join(root, directory), files);
  return [...files].sort();
}
function remote(destinationValue) {
  if (/^[A-Za-z]:[\\/]/u.test(destinationValue)) return false;
  return /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/u.test(destinationValue);
}

function checkMarkdown() {
  const files = markdownFiles();
  const records = new Map();
  for (const filePath of files) {
    try {
      records.set(filePath.toLowerCase(), parseMarkdown(fs.readFileSync(filePath, 'utf8')));
      counts.markdown += 1;
    } catch (error) {
      report(`Markdown 无法读取：${error.message}`, filePath);
    }
  }
  const load = (filePath) => {
    const key = filePath.toLowerCase();
    if (records.has(key)) return records.get(key);
    try {
      const record = parseMarkdown(fs.readFileSync(filePath, 'utf8'));
      records.set(key, record);
      return record;
    } catch {
      return null;
    }
  };

  for (const source of files) {
    const record = records.get(source.toLowerCase());
    if (!record) continue;
    for (const link of record.links) {
      counts.links += 1;
      const raw = link.destination;
      if (remote(raw)) continue;
      const hash = raw.indexOf('#');
      const pathPart = decode(hash === -1 ? raw : raw.slice(0, hash), source, link.line);
      const fragment = decode(hash === -1 ? '' : raw.slice(hash + 1), source, link.line);
      if (pathPart === null || fragment === null) continue;
      const target = pathPart ? path.resolve(path.dirname(source), pathPart) : source;
      if (!insideRoot(target)) {
        report(`相对链接越出项目目录：${raw}`, source, link.line);
        continue;
      }
      if (!fs.existsSync(target)) {
        report(`本地链接目标不存在：${raw}`, source, link.line);
        continue;
      }
      try {
        if (!insideRoot(fs.realpathSync(target))) {
          report(`链接经符号链接越出项目目录：${raw}`, source, link.line);
          continue;
        }
      } catch {
        report(`无法解析链接目标：${raw}`, source, link.line);
        continue;
      }
      if (link.image || !fragment || !target.toLowerCase().endsWith('.md')) continue;
      const targetRecord = load(target);
      if (!targetRecord || !targetRecord.anchors.has(fragment)) report(`Markdown 锚点不存在：${raw}`, source, link.line);
    }
  }
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function checkTokens() {
  const filePath = path.join(root, 'docs', 'frontend', 'design-tokens.json');
  if (!fs.existsSync(filePath)) {
    report('设计令牌文件不存在：docs/frontend/design-tokens.json');
    return;
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    report(`设计令牌 JSON 无法解析：${error.message}`, filePath);
    return;
  }
  if (!plainObject(document)) {
    report('设计令牌根对象必须是 JSON 对象', filePath);
    return;
  }
  for (const field of ['metadata', 'tokens', 'contrastChecks']) {
    if (!(field in document)) report(`设计令牌缺少根字段：${field}`, filePath);
  }
  if (!plainObject(document.metadata)) report('metadata 必须是对象', filePath);
  if (!plainObject(document.tokens)) {
    report('tokens 必须是扁平对象映射', filePath);
    return;
  }
  if (!Array.isArray(document.contrastChecks)) report('contrastChecks 必须是数组', filePath);

  const tokens = document.tokens;
  const aliasPattern = /^\{([^{}]+)\}$/u;
  for (const [name, token] of Object.entries(tokens)) {
    counts.tokens += 1;
    if (!plainObject(token)) {
      report(`token ${name} 必须是对象`, filePath);
      continue;
    }
    if (!tokenTypes.has(token.$type)) report(`token ${name} 的 $type 无效`, filePath);
    if (!['string', 'number'].includes(typeof token.$value) || (typeof token.$value === 'number' && !Number.isFinite(token.$value))) report(`token ${name} 的 $value 必须是字符串或有限数值`, filePath);
    if ('$description' in token && typeof token.$description !== 'string') report(`token ${name} 的 $description 必须是文本`, filePath);
    for (const key of Object.keys(token)) if (!['$type', '$value', '$description'].includes(key)) report(`token ${name} 含未知字段：${key}`, filePath);
  }

  const issueSet = new Set();
  const tokenIssue = (message) => {
    if (!issueSet.has(message)) {
      issueSet.add(message);
      report(message, filePath);
    }
  };
  const states = new Map();
  const resolved = new Map();
  function resolve(name, trail = []) {
    if (!Object.hasOwn(tokens, name)) {
      tokenIssue(`token 别名悬空：${trail.join(' -> ')} -> ${name}`);
      return null;
    }
    if (resolved.has(name)) return resolved.get(name);
    if (states.get(name) === 'visiting') {
      tokenIssue(`token 别名循环：${[...trail, name].join(' -> ')}`);
      return null;
    }
    const token = tokens[name];
    if (!plainObject(token)) {
      states.set(name, 'done');
      resolved.set(name, null);
      return null;
    }
    states.set(name, 'visiting');
    let result = { type: token.$type, value: token.$value };
    const alias = typeof token.$value === 'string' ? token.$value.match(aliasPattern) : null;
    if (alias) {
      const targetName = alias[1];
      if (!Object.hasOwn(tokens, targetName)) tokenIssue(`token ${name} 的别名悬空：${targetName}`);
      else {
        if (tokens[targetName] && tokens[targetName].$type !== token.$type) tokenIssue(`token ${name} 与别名 ${targetName} 的类型不一致`);
        const target = resolve(targetName, [...trail, name]);
        if (target) result = target;
      }
    }
    states.set(name, 'done');
    resolved.set(name, result);
    return result;
  }
  for (const name of Object.keys(tokens)) resolve(name);

  if (!Array.isArray(document.contrastChecks)) return;
  const colorValue = (name, index, role) => {
    if (!Object.hasOwn(tokens, name)) {
      report(`contrastChecks[${index}] 引用未知 token：${name}`, filePath);
      return null;
    }
    const token = resolve(name);
    if (!token || token.type !== 'color') {
      report(`contrastChecks[${index}] 的 ${role} 不是 color token：${name}`, filePath);
      return null;
    }
    if (typeof token.value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(token.value)) {
      report(`contrastChecks[${index}] 的 ${role} 不是 #RRGGBB：${token.value}`, filePath);
      return null;
    }
    return token.value;
  };
  const luminance = (hex) => {
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset + 1, offset + 3), 16) / 255);
    const linear = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  for (const [index, check] of document.contrastChecks.entries()) {
    counts.contrasts += 1;
    if (!plainObject(check) || typeof check.foreground !== 'string' || typeof check.background !== 'string' || typeof check.minimum !== 'number' || !Number.isFinite(check.minimum) || check.minimum <= 0) {
      report(`contrastChecks[${index}] 必须包含 foreground/background 文本和正数 minimum`, filePath);
      continue;
    }
    const foreground = colorValue(check.foreground, index, 'foreground');
    const background = colorValue(check.background, index, 'background');
    if (!foreground || !background) continue;
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    if (ratio + 1e-9 < check.minimum) report(`contrastChecks[${index}] 对比度不足：${ratio.toFixed(2)} < ${check.minimum}`, filePath);
  }
}

checkMarkdown();
checkTokens();
console.log(`文档检查：Markdown ${counts.markdown} 个，链接 ${counts.links} 个，标题锚点 ${counts.anchors} 个，设计令牌 ${counts.tokens} 个，对比度检查 ${counts.contrasts} 条。`);
if (errors.length) {
  console.error(`发现 ${errors.length} 个错误：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('检查通过。');
}
