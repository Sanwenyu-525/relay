import assert from "node:assert/strict";
import test from "node:test";
import {
  KNOWLEDGE_SCORE_WEIGHTS,
  effectiveKnowledgeStatus,
  knowledgeLabelKey,
  knowledgeQueryTokens,
  knowledgeSourceRef,
  knowledgeSummary,
  knowledgeTitleTokens,
  normalizeKnowledgeTagName,
  scoreKnowledge,
  tokenCoverage,
} from "../../src/application/knowledge-model.js";

test("中文按相邻双字分词，拉丁词整词保留并小写", () => {
  assert.deepEqual(knowledgeQueryTokens("知识库系统"), ["知识", "识库", "库系", "系统"]);
  assert.deepEqual(knowledgeQueryTokens("PostgreSQL 索引"), ["postgresql", "索引"]);
  assert.deepEqual(knowledgeQueryTokens("  "), []);
  assert.deepEqual(knowledgeTitleTokens("Agent 检索"), ["agent", "检索"]);
});

test("标签规范化拒绝空值、纯符号与超长，保留可检索字符", () => {
  assert.equal(normalizeKnowledgeTagName("  TypeScript  "), "TypeScript");
  assert.equal(normalizeKnowledgeTagName("架构   设计"), "架构 设计");
  assert.equal(normalizeKnowledgeTagName("!!!"), null);
  assert.equal(normalizeKnowledgeTagName("   "), null);
  assert.equal(normalizeKnowledgeTagName(42), null);
  assert.equal(normalizeKnowledgeTagName("标".repeat(49)), null);
  assert.equal(knowledgeLabelKey(" TypeScript "), "typescript");
});

test("有效状态只派生：归档优先，其次不可读，最后才是活动", () => {
  assert.equal(effectiveKnowledgeStatus({ status: "ARCHIVED", availability: "AVAILABLE" }), "ARCHIVED");
  assert.equal(effectiveKnowledgeStatus({ status: "ACTIVE", availability: "DELETED" }), "UNAVAILABLE");
  assert.equal(effectiveKnowledgeStatus({ status: "ACTIVE", availability: "AVAILABLE" }), "ACTIVE");
  assert.equal(effectiveKnowledgeStatus({ status: "ACTIVE", availability: null }), "ACTIVE");
});

test("相关性按显式 > 标题 > 正文 > 标签 > 集合 > 来源 > 项目排序", () => {
  const base = { titleOverlap: 0, bodyOverlap: 0, tagHits: 0, collectionHits: 0,
    sourceHit: false, projectMatch: false, explicit: false, effective: "ACTIVE" as const };
  assert.equal(scoreKnowledge(base), 0);
  assert.equal(scoreKnowledge({ ...base, titleOverlap: 0.5 }), 15);
  assert.equal(scoreKnowledge({ ...base, bodyOverlap: 0.5 }), 9);
  assert.equal(scoreKnowledge({ ...base, tagHits: 1 }), KNOWLEDGE_SCORE_WEIGHTS.tag);
  assert.equal(scoreKnowledge({ ...base, tagHits: 9 }), KNOWLEDGE_SCORE_WEIGHTS.tag * 3);
  assert.equal(scoreKnowledge({ ...base, collectionHits: 9 }), KNOWLEDGE_SCORE_WEIGHTS.collection * 3);
  assert.equal(scoreKnowledge({ ...base, sourceHit: true }), KNOWLEDGE_SCORE_WEIGHTS.source);
  assert.equal(scoreKnowledge({ ...base, projectMatch: true }), KNOWLEDGE_SCORE_WEIGHTS.project);
  const explicit = scoreKnowledge({ ...base, explicit: true });
  const everything = scoreKnowledge({ ...base, explicit: true, titleOverlap: 1, bodyOverlap: 1,
    tagHits: 3, collectionHits: 3, sourceHit: true, projectMatch: true });
  assert.ok(everything > explicit);
  assert.ok(explicit > scoreKnowledge({ ...base, titleOverlap: 1 }));
});

test("归档或不可读的知识得分为零，无论标题多相关", () => {
  const base = { titleOverlap: 1, bodyOverlap: 1, tagHits: 3, collectionHits: 3,
    sourceHit: true, projectMatch: true, explicit: true };
  assert.equal(scoreKnowledge({ ...base, effective: "ARCHIVED" }), 0);
  assert.equal(scoreKnowledge({ ...base, effective: "UNAVAILABLE" }), 0);
});

test("词元覆盖率只按查询词元比例计算，空集合不虚报", () => {
  assert.equal(tokenCoverage([], ["a"]), 0);
  assert.equal(tokenCoverage(["a"], []), 0);
  assert.equal(tokenCoverage(["a", "b"], ["a"]), 0.5);
  assert.equal(tokenCoverage(["a", "b"], ["a", "b", "c"]), 1);
});

test("摘要按 Unicode 截断，没有正文时保持 null", () => {
  assert.equal(knowledgeSummary(null), null);
  assert.equal(knowledgeSummary("  "), null);
  assert.equal(knowledgeSummary("第一段\n\n第二段"), "第一段 第二段");
  const summary = knowledgeSummary("知".repeat(300));
  assert.equal([...(summary ?? "")].length, 200);
});

test("来源引用绑定确切版本，id 与版本缺一不可", () => {
  assert.equal(knowledgeSourceRef("abc", 3n), "knowledge:abc:v3");
  assert.equal(knowledgeSourceRef("abc", "12"), "knowledge:abc:v12");
  assert.equal(knowledgeSourceRef("abc", 0n), "knowledge:abc:v0");
});
