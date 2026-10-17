import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePriceValue, evaluateFreeEligibility, parseCapabilities, resolveCatalogEntry,
  resolveCatalogSnapshot, REQUIRED_CHAT_PRICE_KEYS,
} from '../../src/workflow/model-catalog-pricing.js';

// FM-01：严格价格解析——零、极小非零、缺失、非法、负数必须区分，绝不把极小非零舍入成零。
test('parsePriceValue: 合法的零的各种写法都判为零', () => {
  for (const zero of ['0', '0.0', '0.00', '+0', '0.', '0e-18', '0E+5', '000']) {
    assert.equal(parsePriceValue(zero).kind, 'ZERO', zero);
  }
});

test('parsePriceValue: 极小非零不判为零（不用浮点）', () => {
  for (const tiny of ['0.0000000001', '1e-18', '0.0001', '.5', '0.000000000000001']) {
    assert.equal(parsePriceValue(tiny).kind, 'NONZERO', tiny);
  }
});

test('parsePriceValue: 缺失、非法、负数、非字符串各自分开', () => {
  assert.equal(parsePriceValue(undefined).kind, 'MISSING');
  assert.equal(parsePriceValue(null).kind, 'MISSING');
  assert.equal(parsePriceValue('').kind, 'MISSING');
  assert.equal(parsePriceValue('  ').kind, 'MISSING');
  assert.equal(parsePriceValue('abc').kind, 'INVALID');
  assert.equal(parsePriceValue('1.2.3').kind, 'INVALID');
  assert.equal(parsePriceValue('-0.0000001').kind, 'NEGATIVE');
  assert.equal(parsePriceValue('-0').kind, 'NEGATIVE'); // 负零也按非法负价保守处理，不判免费
  assert.equal(parsePriceValue(0).kind, 'INVALID'); // 非字符串（JSON number）不接受
});

const zeroTextPrices = { prompt: '0', completion: '0' };
const zeroAll = { ...zeroTextPrices, request: '0' };

test('evaluateFreeEligibility: 官方目录的 prompt/completion 形状可免费，request 省略时不补值', () => {
  const actualOpenRouterShape = { prompt: '0', completion: '0' };
  const d = evaluateFreeEligibility(actualOpenRouterShape);
  assert.equal(d.isFree, true);
  assert.equal(d.reason, null);
  assert.equal(Object.hasOwn(actualOpenRouterShape, 'request'), false);
});

test('evaluateFreeEligibility: 已声明的 request 必须为零', () => {
  const d = evaluateFreeEligibility(zeroAll);
  assert.equal(d.isFree, true);
  assert.equal(d.reason, null);
  assert.deepEqual(evaluateFreeEligibility({ ...zeroTextPrices, request: '0.0001' }),
    { isFree: false, reason: 'NONZERO_PRICE' });
  assert.deepEqual(evaluateFreeEligibility({ ...zeroTextPrices, request: null }),
    { isFree: false, reason: 'MISSING_PRICE' });
});

test('evaluateFreeEligibility: prompt/completion 任一非零/缺失/非法/负都拒绝', () => {
  assert.deepEqual(evaluateFreeEligibility({ ...zeroAll, prompt: '0.0000001' }),
    { isFree: false, reason: 'NONZERO_PRICE' });
  assert.deepEqual(evaluateFreeEligibility({ prompt: '0' }),
    { isFree: false, reason: 'MISSING_PRICE' }); // 缺必需 completion 不默认零
  assert.deepEqual(evaluateFreeEligibility({ completion: '0' }),
    { isFree: false, reason: 'MISSING_PRICE' }); // 缺必需 prompt 不默认零
  assert.deepEqual(evaluateFreeEligibility({ ...zeroAll, completion: 'x' }),
    { isFree: false, reason: 'INVALID_PRICE' });
  assert.deepEqual(evaluateFreeEligibility({ ...zeroAll, request: '-1' }),
    { isFree: false, reason: 'NEGATIVE_PRICE' });
});

test('evaluateFreeEligibility: 仅名称含 free、价格为空不入选', () => {
  // 判定只看价格，不看 id/name——:free 后缀不构成免费证据。
  assert.equal(REQUIRED_CHAT_PRICE_KEYS.length, 2);
  assert.deepEqual(evaluateFreeEligibility({}), { isFree: false, reason: 'MISSING_PRICE' });
});

test('evaluateFreeEligibility: 已知媒体/搜索项非零不阻断文本免费', () => {
  const d = evaluateFreeEligibility({ ...zeroAll, image: '0.001', web_search: '0.01' });
  assert.equal(d.isFree, true); // 本批不启用媒体/搜索，不因此否认文本零价
});

test('evaluateFreeEligibility: 来源新增未知收费键非零则保守拒绝', () => {
  const d = evaluateFreeEligibility({ ...zeroAll, hypothetical_fee: '0.02' });
  assert.deepEqual(d, { isFree: false, reason: 'UNKNOWN_BILLABLE_ITEM' });
  for (const key of ['per_request', 'per_request_call']) {
    assert.deepEqual(evaluateFreeEligibility({ ...zeroTextPrices, [key]: '0.01' }),
      { isFree: false, reason: 'UNKNOWN_BILLABLE_ITEM' }, key);
  }
  // 未知键但确为零，不影响入选。
  assert.equal(evaluateFreeEligibility({ ...zeroAll, hypothetical_fee: '0' }).isFree, true);
});

test('evaluateFreeEligibility: 未知收费项为 null / 空值 / 非法值时都不能判免费', () => {
  // 「这一项没给出价格」不等于「这一项不收费」：缺值、null、空串、空白、非数字一律保守拒绝。
  for (const value of [null, undefined, '', '   ', 'n/a', 0.0001, -1]) {
    const d = evaluateFreeEligibility({ ...zeroAll, input_cache_read: value });
    assert.deepEqual(d, { isFree: false, reason: 'UNKNOWN_BILLABLE_ITEM' },
      `未知收费项 ${String(value)} 不能判免费`);
  }
  // 明确为零才放行（缓存读价也是真实文本调用计价项，非零同样拒绝）。
  assert.equal(evaluateFreeEligibility({ ...zeroAll, input_cache_read: '0' }).isFree, true);
  assert.deepEqual(evaluateFreeEligibility({ ...zeroAll, input_cache_read: '0.00000025' }),
    { isFree: false, reason: 'UNKNOWN_BILLABLE_ITEM' });
});

test('parseCapabilities: true / false / null 三态，缺字段不冒充可用', () => {
  // 用**官方真实结构**：supported_parameters 在模型顶层，模态在 architecture 内。
  // 模态列表「给出了但没有 image」= 明确不支持（false），列表缺失才是未知（null）。
  assert.deepEqual(parseCapabilities({
    supported_parameters: ['tools', 'temperature'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] } }),
  { tools: true, structured_outputs: false, response_format: false,
    text_input: true, text_output: true, image_input: false });
  assert.deepEqual(parseCapabilities({
    supported_parameters: ['temperature'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] } }),
  { tools: false, structured_outputs: false, response_format: false,
    text_input: true, text_output: true, image_input: false });
  assert.deepEqual(parseCapabilities({
    supported_parameters: ['tools', 'response_format'],
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }),
  { tools: true, structured_outputs: false, response_format: true,
    text_input: true, text_output: true, image_input: true });
  assert.deepEqual(parseCapabilities({}),
    { tools: null, structured_outputs: null, response_format: null,
      text_input: null, text_output: null, image_input: null });
  assert.deepEqual(parseCapabilities(undefined),
    { tools: null, structured_outputs: null, response_format: null,
      text_input: null, text_output: null, image_input: null });
});

test('parseCapabilities: 把 supported_parameters 放进 architecture（旧的错误嵌套）不得被读成具备工具', () => {
  // 这正是修复前的缺陷：受控完整条目在 architecture 里声明 tools 却得到 tools:null。
  // 反向也必须成立——错误嵌套不得被读成 tools:true，否则就是拿错结构的 fixture 自证可用。
  assert.deepEqual(parseCapabilities({
    architecture: { supported_parameters: ['tools'], input_modalities: ['text'], output_modalities: ['text'] } }),
  { tools: null, structured_outputs: null, response_format: null,
    text_input: true, text_output: true, image_input: false });
});

test('response_format JSON mode does not require strict structured_outputs capability', () => {
  const capabilities = parseCapabilities({ supported_parameters: ['response_format'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
  assert.equal(capabilities.response_format, true);
  assert.equal(capabilities.structured_outputs, false);
});

test('resolveCatalogEntry: 缺失身份拒绝、缺价保守为非免费、上下文非法为 null', () => {
  assert.equal(resolveCatalogEntry(null), null);
  assert.equal(resolveCatalogEntry({ name: 'No Id' }), null);
  const free = resolveCatalogEntry({ id: 'acme/model:free', name: 'Acme', context_length: 8192,
    pricing: zeroTextPrices, supported_parameters: ['tools'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
  assert.ok(free);
  assert.equal(free.is_free, true);
  assert.equal(free.not_free_reason, null);
  assert.equal(free.context_window, 8192);
  assert.equal(free.capabilities.tools, true);
  assert.deepEqual(free.pricing, zeroTextPrices); // 不把缺失的 request 改写成 0

  const missing = resolveCatalogEntry({ id: 'acme/paid', pricing: {} });
  assert.ok(missing);
  assert.equal(missing.is_free, false);
  assert.equal(missing.not_free_reason, 'MISSING_PRICE');
  assert.equal(missing.display_name, 'acme/paid'); // 名称缺失回退到确切 ID
  assert.equal(missing.context_window, null); // context_length 缺失 → null，不写 0
});

test('resolveCatalogSnapshot: 合法空目录仍是「OK 且零条目」，不是畸形', () => {
  assert.deepEqual(resolveCatalogSnapshot([]), { kind: 'OK', entries: [] });
});

test('resolveCatalogSnapshot: 非空但没有一条身份完整 → INCOMPLETE，绝不解析成合法空目录', () => {
  // data:[{}] 的真实形状：什么字段都没有。
  for (const raw of [[{}], [{ name: 'No Id' }], [null], ['text'], [{ id: '   ' }]]) {
    assert.equal(resolveCatalogSnapshot(raw).kind, 'INCOMPLETE', JSON.stringify(raw));
  }
  // 部分合法、部分身份不完整同样整份拒绝：出现这种形状说明来源结果不可信。
  const partial = resolveCatalogSnapshot([{ id: 'ok', pricing: zeroAll }, {}]);
  assert.equal(partial.kind, 'INCOMPLETE');
});

test('resolveCatalogSnapshot: 完全一致的重复 id 去重，矛盾的重复 id 整份拒绝', () => {
  const identical = resolveCatalogSnapshot([
    { id: 'dup', name: 'Dup', context_length: 4096, pricing: zeroAll },
    { id: 'dup', name: 'Dup', context_length: 4096, pricing: zeroAll },
  ]);
  assert.equal(identical.kind, 'OK');
  if (identical.kind === 'OK') assert.deepEqual(identical.entries.map((e) => e.source_model_id), ['dup']);

  // 同一 id 一条免费一条收费：绝不能按数组顺序静默挑第一条。
  const conflicting = resolveCatalogSnapshot([
    { id: 'dup', name: 'Dup', pricing: zeroAll },
    { id: 'dup', name: 'Dup', pricing: { prompt: '0', completion: '0.001', request: '0' } },
  ]);
  assert.equal(conflicting.kind, 'CONFLICT');
});

test('resolveCatalogSnapshot: 条目按 id 稳定排序，便于入库顺序与候选排序可复现', () => {
  const resolved = resolveCatalogSnapshot([
    { id: 'z/last', pricing: zeroAll },
    { id: 'a/first', pricing: zeroAll },
  ]);
  assert.equal(resolved.kind, 'OK');
  if (resolved.kind === 'OK') {
    assert.deepEqual(resolved.entries.map((e) => e.source_model_id), ['a/first', 'z/last']);
  }
});
