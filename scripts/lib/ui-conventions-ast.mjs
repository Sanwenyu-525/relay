/**
 * UI 规范守卫的 AST 分析层（UI-UNIFY-03）。
 *
 * 只做三件事：解析 TSX、找出原生 button/input/select/textarea、判断是否带
 * 「ui-conventions: allow-native — 原因」例外注释。文本正则不再参与页面控件判定，
 * 因此 JSX 注释、字符串和组件名都不会误报。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromWorkbench = createRequire(path.join(repoRoot, "apps", "workbench", "package.json"));
const ts = requireFromWorkbench("typescript");

export const NATIVE_CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);

/** 例外注释必须带原因；只写标签会失败（防止把例外注释当成无限通行证）。 */
const ALLOW_COMMENT = /ui-conventions\s*:\s*allow-native\b([^\r\n]*)/;

/** 浏览器原生语义明确、无需额外理由的两类 input。 */
function isBrowserNativeInput(node) {
  if (node.tagName?.getText() !== "input") return false;
  const type = node.attributes?.properties?.find((property) => property.name?.getText() === "type");
  if (!type) return false;
  const initializer = type.initializer;
  if (!initializer) return false;
  if (ts.isStringLiteral(initializer)) return initializer.text === "file" || initializer.text === "hidden";
  if (ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression)) {
    return initializer.expression.text === "file" || initializer.expression.text === "hidden";
  }
  return false;
}

function commentWindow(sourceFile, node, sourceText) {
  const start = node.getStart(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(start).line;
  const lines = sourceText.split(/\r?\n/);
  const prefix = lines[line]?.slice(0, sourceFile.getLineAndCharacterOfPosition(start).character) ?? "";
  const window = [
    lines[line - 2] ?? "",
    lines[line - 1] ?? "",
    prefix
  ].join("\n");
  return window;
}

/**
 * @returns {{ tag: string, line: number, column: number, exempt: boolean, reason: string | null, text: string,
 *   problem: null | "exception-without-reason" | "native-control" }[]}
 */
export function analyzeViewSource(sourceText, fileName = "View.tsx") {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const controls = [];

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName?.getText(sourceFile) ?? "";
      if (NATIVE_CONTROL_TAGS.has(tag)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const window = commentWindow(sourceFile, node, sourceText);
        const comment = ALLOW_COMMENT.exec(window);
        const browserNative = isBrowserNativeInput(node);
        let exempt = browserNative;
        let reason = browserNative ? "浏览器文件选择 / 隐藏字段语义" : null;
        let problem = null;

        if (comment !== null) {
          const rawReason = comment[1].replace(/^[\s:：—\-–]+/u, "").replace(/\*\/\s*\}?\s*$/u, "").trim();
          if (rawReason.length >= 4) {
            exempt = true;
            reason = rawReason;
          } else if (!browserNative) {
            problem = "exception-without-reason";
          }
        } else if (!browserNative) {
          problem = "native-control";
        }

        controls.push({
          tag,
          line: position.line + 1,
          column: position.character + 1,
          exempt,
          reason,
          problem,
          text: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120)
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { controls, violations: controls.filter((control) => control.problem !== null) };
}

/** 只检查页面（views），组件库内部与业务组件不在本规则范围内。 */
export function shouldCheckView(relativeFile) {
  return /^apps\/workbench\/src\/views\/.+\.tsx$/u.test(relativeFile);
}

/**
 * 与基线比较：新页面零容忍；存量页面只允许下降，不允许新增原生控件。
 * 例外控件也计入数量（基线记录的是真实存量），但不会产生违规。
 */
export function compareViewControls({ relativeFile, controls, baselineCount, isKnownView }) {
  const violations = [];
  const count = controls.length;
  if (!isKnownView) {
    for (const control of controls) {
      if (control.problem === "exception-without-reason") {
        violations.push(`${relativeFile}:${control.line} 的 allow-native 例外没有写明原因（至少 4 个字）`);
      } else if (control.problem === "native-control") {
        violations.push(`${relativeFile}:${control.line} 新页面直接写原生 <${control.tag}>：${control.text}；请改用 src/ui 组件，或写 “ui-conventions: allow-native — 原因” 例外注释`);
      }
    }
    return { count, violations };
  }
  if (count > baselineCount) {
    violations.push(`${relativeFile} 原生控件 ${baselineCount} → ${count}：存量页面只允许减少，不允许新增 <button>/<input>/<select>/<textarea>`);
  }
  return { count, violations };
}

export function listViewFiles(srcRoot) {
  const viewsRoot = path.join(srcRoot, "views");
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(viewsRoot);
  return out.sort();
}
