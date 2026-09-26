import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { resourceNotFound } from '../application/domain-error.js';
import { requireWorkspace } from '../application/guards.js';
import { createRepositories } from '../application/unit-of-work.js';
import { FIRST_PARTY_REGISTRY, frozenSkillIdentity,
  isCallableSkill } from '../skills/first-party-registry.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const workspace = Type.Object({ workspace_id: Type.String({ format: 'uuid' }) }, strict);
const item = Type.Object({ workspace_id: Type.String({ format: 'uuid' }),
  id: Type.String(), version: Type.String() }, strict);

export function registerFirstPartySkillRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/skill-definitions', { schema: { params: workspace } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      await requireWorkspace(createRepositories(dependencies.database.executor), p.workspace_id);
      return { items: FIRST_PARTY_REGISTRY.skills.map((skill) => ({
        ...frozenSkillIdentity(skill), title: skill.definition.title,
        availability: isCallableSkill(skill) ? skill.definition.availability
          : 'HISTORICAL_ONLY', call_supported: isCallableSkill(skill),
        accept_supported: isCallableSkill(skill) &&
          (skill.definition.target === 'TASK' ||
           skill.id === 'goal-to-project-blueprint') })) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/skill-definitions/:id/versions/:version', { schema: { params: item } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string; version: string };
      await requireWorkspace(createRepositories(dependencies.database.executor), p.workspace_id);
      const skill = FIRST_PARTY_REGISTRY.skill(p.id, p.version);
      if (skill === undefined) throw resourceNotFound('Skill definition');
      return { ...frozenSkillIdentity(skill), title: skill.definition.title,
        availability: isCallableSkill(skill) ? skill.definition.availability
          : 'HISTORICAL_ONLY', call_supported: isCallableSkill(skill),
        accept_supported: isCallableSkill(skill) &&
          (skill.definition.target === 'TASK' ||
           skill.id === 'goal-to-project-blueprint'),
        definition: skill.definition };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/packs', { schema: { params: workspace } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      await requireWorkspace(createRepositories(dependencies.database.executor), p.workspace_id);
      return { items: FIRST_PARTY_REGISTRY.packs };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/packs/:id/versions/:version', { schema: { params: item } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string; version: string };
      await requireWorkspace(createRepositories(dependencies.database.executor), p.workspace_id);
      const pack = FIRST_PARTY_REGISTRY.pack(p.id, p.version);
      if (pack === undefined) throw resourceNotFound('Pack');
      return pack;
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
