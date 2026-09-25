import tokenDocument from "../../../../docs/frontend/design-tokens.json";

type TokenValue = string | number | string[];

interface TokenEntry {
  $value: TokenValue;
}

interface TokenDocument {
  tokens: Record<string, TokenEntry>;
}

const referencePattern = /^\{([^}]+)\}$/;

function asCssValue(value: TokenValue): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function resolveToken(
  name: string,
  tokens: Record<string, TokenEntry>,
  resolving = new Set<string>()
): string {
  if (resolving.has(name)) {
    throw new Error(`循环 token 引用：${name}`);
  }

  const entry = tokens[name];
  if (!entry) {
    throw new Error(`缺少 token：${name}`);
  }

  const rawValue = asCssValue(entry.$value);
  const match = rawValue.match(referencePattern);
  if (!match) {
    return rawValue;
  }

  resolving.add(name);
  const resolved = resolveToken(match[1], tokens, resolving);
  resolving.delete(name);
  return resolved;
}

export function cssVariableName(tokenName: string): string {
  return `--relay-${tokenName.replaceAll(".", "-")}`;
}

export function installDesignTokens(target: HTMLElement = document.documentElement): void {
  const { tokens } = tokenDocument as TokenDocument;
  for (const name of Object.keys(tokens)) {
    target.style.setProperty(cssVariableName(name), resolveToken(name, tokens));
  }
}

export function resolvedTokenValue(tokenName: string): string {
  const { tokens } = tokenDocument as TokenDocument;
  return resolveToken(tokenName, tokens);
}
