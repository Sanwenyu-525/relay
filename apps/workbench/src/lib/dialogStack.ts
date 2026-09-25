let stack: symbol[] = [];
const listeners = new Set<() => void>();

export function subscribeDialogStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function dialogCount(): number {
  return stack.length;
}

export function pushDialog(token: symbol): void {
  stack = [...stack, token];
  notify();
}

export function popDialog(token: symbol): void {
  stack = stack.filter((candidate) => candidate !== token);
  notify();
}

export function isTopDialog(token: symbol): boolean {
  return stack[stack.length - 1] === token;
}

export function otherDialogAbove(token: symbol): boolean {
  const index = stack.indexOf(token);
  return index >= 0 && index < stack.length - 1;
}
