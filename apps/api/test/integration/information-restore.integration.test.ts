import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { createDecision, createKnowledge, createMemory, createRule, retireInformation }
  from '../../src/application/information-commands.js';
import { registerDecisionPremise } from '../../src/application/decision-reviews.js';
import type { KnowledgeVersionRow } from '../../src/infrastructure/database-schema.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-information-restore');
let api: TestApi;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function fixture(kind: 'knowledge' | 'memory' | 'rule', global = false) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'restore-information' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'restore', projectType: 'GENERAL' });
  });
  const base = { workspaceId, commandId: randomUUID(), projectId: global ? null : projectId, title: 'restore item' };
  const created = kind === 'knowledge' ? await createKnowledge(app.db, { ...base,
    source: { sourceKind: 'NOTE', text: 'immutable knowledge' } })
    : kind === 'memory' ? await createMemory(app.db, { ...base, text: 'confirmed memory', confirmed: true })
      : await createRule(app.db, { ...base, scope: global ? 'WORKSPACE' : 'PROJECT',
        scopeId: global ? workspaceId : projectId, ruleKey: 'restore-rule', statement: 'retain facts',
        strength: 'PREFERENCE', applicability: 'AI_RUN', enforcement: 'HUMAN' });
  const id = created.result[`${kind}_id`];
  assert.ok(id);
  const retired = await retireInformation(app.db, { workspaceId, commandId: randomUUID(), kind, id, expectedRevision: '0' });
  const collection = kind === 'knowledge' ? 'knowledge' : kind === 'memory' ? 'memories' : 'rules';
  const suffix = kind === 'knowledge' ? 'unarchive' : 'reactivate';
  return { workspaceId, projectId, id, kind, revision: retired.result.revision,
    endpoint: workspacePath(workspaceId, `/${collection}/${id}/${suffix}`),
    eventType: kind === 'knowledge' ? 'KNOWLEDGE_UNARCHIVED'
      : kind === 'memory' ? 'MEMORY_REACTIVATED' : 'RULE_REACTIVATED' };
}

for (const kind of ['knowledge', 'memory', 'rule'] as const) {
  test(`${kind}: HTTP restore changes status only, replays receipt, and preserves authority/version history`, async () => {
    const f = await fixture(kind);
    const r = createRepositories(app.db);
    const versions = await r.information.listVersions(kind, f.id);
    const authority = (await r.workspaces.readAuthority(f.workspaceId))!;
    const body = { command_id: randomUUID(), expected_revision: f.revision };
    const restored = await api.post(f.endpoint, body);
    assert.equal(restored.status, 200, restored.text);
    assert.deepEqual((restored.body as { result: unknown }).result,
      { [`${kind}_id`]: f.id, revision: '2', status: 'ACTIVE' });
    assert.deepEqual((await api.post(f.endpoint, body)).body, restored.body);
    const current = (await r.information.readRoot(kind, f.id))!;
    assert.equal(current.status, 'ACTIVE');
    assert.equal(current.current_version, 1n);
    assert.deepEqual(await r.information.listVersions(kind, f.id), versions);
    const next = (await r.workspaces.readAuthority(f.workspaceId))!;
    assert.equal(next.context_revision, authority.context_revision + 1n);
    assert.equal(next.rule_revision, authority.rule_revision + (kind === 'rule' ? 1n : 0n));
    const audit = await r.activities.listActivityRecordsByCommand(body.command_id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.event_type, f.eventType);
    assert.equal((await api.post(f.endpoint, { ...body, expected_revision: '2' })).status, 409);
    assert.equal((await api.post(f.endpoint, { ...body, command_id: randomUUID() })).status, 409);
    const noop = await api.post(f.endpoint, { command_id: randomUUID(), expected_revision: '2' });
    assert.equal(noop.status, 200, noop.text);
    assert.equal((await r.information.readRoot(kind, f.id))?.revision, 2n);
    assert.deepEqual(await r.workspaces.readAuthority(f.workspaceId), next, 'already active does not invalidate context again');
  });

  test(`${kind}: concurrent replay has one audit; stale, cross-workspace and archived-project requests write nothing`, async () => {
    const f = await fixture(kind);
    const r = createRepositories(app.db);
    const body = { command_id: randomUUID(), expected_revision: f.revision };
    const [a, b] = await Promise.all([api.post(f.endpoint, body), api.post(f.endpoint, body)]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.deepEqual(a.body, b.body);
    assert.equal((await r.activities.listActivityRecordsByCommand(body.command_id)).length, 1);
    const retired = await retireInformation(app.db, { workspaceId: f.workspaceId,
      kind, id: f.id, commandId: randomUUID(), expectedRevision: '2' });
    assert.deepEqual((await api.post(f.endpoint, body)).body, a.body, 'replay returns historical ACTIVE receipt');
    const before = await r.information.readRoot(kind, f.id);
    const authority = await r.workspaces.readAuthority(f.workspaceId);
    const failedId = randomUUID();
    const stale = await api.post(f.endpoint, { command_id: failedId, expected_revision: '2' });
    assert.equal(stale.status, 409, stale.text);
    assert.equal((stale.body as { code: string }).code, 'REVISION_CONFLICT');
    const foreign = await fixture(kind);
    assert.equal((await api.post(f.endpoint.replace(f.workspaceId, foreign.workspaceId), {
      command_id: randomUUID(), expected_revision: retired.result.revision })).status, 404);
    await withTransaction(app.db, async (repos) => {
      const project = await repos.projects.readProject(f.projectId);
      await repos.projects.archiveProject(f.projectId, project!.revision);
    });
    const blocked = await api.post(f.endpoint, { command_id: randomUUID(), expected_revision: retired.result.revision });
    assert.equal(blocked.status, 409, blocked.text);
    assert.deepEqual(await r.information.readRoot(kind, f.id), before);
    assert.deepEqual(await r.workspaces.readAuthority(f.workspaceId), authority);
    assert.equal((await r.activities.listActivityRecordsByCommand(failedId)).length, 0);
  });
}

test('global Knowledge/Memory/Rule can be restored without a Project', async () => {
  for (const kind of ['knowledge', 'memory', 'rule'] as const) {
    const f = await fixture(kind, true);
    const restored = await api.post(f.endpoint, { command_id: randomUUID(), expected_revision: f.revision });
    assert.equal(restored.status, 200, restored.text);
    assert.equal((await createRepositories(app.db).information.readRoot(kind, f.id))?.project_id, null);
  }
});

test('unarchive preserves pending Decision review candidates and does not rewrite the Decision', async () => {
  const f = await fixture('knowledge');
  const base = { workspaceId: f.workspaceId, projectId: f.projectId };
  const created = await createKnowledge(app.db, { ...base, commandId: randomUUID(), title: 'decision source',
    source: { sourceKind: 'NOTE', text: 'original source' } });
  const knowledgeId = created.result.knowledge_id!;
  const decision = await createDecision(app.db, { ...base, commandId: randomUUID(), title: 'keep choice',
    choice: 'A', rationale: 'source premise', alternatives: [], costs: [] });
  const r = createRepositories(app.db);
  const source = await r.information.readCurrentVersion<KnowledgeVersionRow>('knowledge', knowledgeId);
  await registerDecisionPremise(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    decisionId: decision.result.decision_id!, expectedDecisionRevision: '0',
    statement: 'source supports A', confirmed: true, knowledgeVersionId: source!.id });
  const retired = await retireInformation(app.db, { workspaceId: f.workspaceId,
    kind: 'knowledge', id: knowledgeId, commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(retired.result.decision_review_count, '1');
  const before = await r.decisionReviews.list(f.workspaceId, f.projectId);
  const decisionBefore = await r.information.readRoot('decision', decision.result.decision_id!);
  const restored = await api.post(workspacePath(f.workspaceId, `/knowledge/${knowledgeId}/unarchive`), {
    command_id: randomUUID(), expected_revision: retired.result.revision });
  assert.equal(restored.status, 200, restored.text);
  assert.deepEqual(await r.decisionReviews.list(f.workspaceId, f.projectId), before);
  assert.deepEqual(await r.information.readRoot('decision', decision.result.decision_id!), decisionBefore);
});
