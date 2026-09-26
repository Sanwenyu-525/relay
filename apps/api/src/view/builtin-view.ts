import { createHash } from 'node:crypto';

import { canonicalizeJson } from '../receipt/payload-hash.js';

export const VIEW_KINDS = ['general', 'thesis', 'development'] as const;
export type ViewKind = typeof VIEW_KINDS[number];
export const VIEW_TEMPLATE_VERSION = '1';

const PAGES: Readonly<Record<ViewKind, readonly string[]>> = {
  general: ['state', 'tasks', 'artifacts', 'reviews'],
  thesis: ['state', 'knowledge', 'tasks', 'artifacts', 'reviews'],
  development: ['state', 'tasks', 'runs', 'connections', 'reviews'],
};

/** Fixed presentation composition; global navigation and Review access are never hidden. */
export function resolveViewTemplate(kind: ViewKind) {
  const pages = PAGES[kind].map((pageId, index) => ({
    page_id: pageId, visible: true, position: index,
  }));
  const template = { kind, template_version: VIEW_TEMPLATE_VERSION, pages };
  return { ...template,
    template_sha256: createHash('sha256').update(canonicalizeJson(template))
      .digest('hex') };
}

export function defaultViewKind(projectType: string): ViewKind {
  return projectType === 'THESIS' ? 'thesis' :
    projectType === 'DEVELOPMENT' ? 'development' : 'general';
}

export function isViewKind(value: unknown): value is ViewKind {
  return typeof value === 'string' && (VIEW_KINDS as readonly string[]).includes(value);
}
