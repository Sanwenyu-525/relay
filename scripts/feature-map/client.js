(() => {
  let data = window.FEATURE_MAP;
  const live = location.protocol === 'http:' || location.protocol === 'https:';
  const state = { tab: 'map', module: '', filter: 'all', query: '', limit: 80, detail: null, cadence: 0 };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const labels = { code: '代码', docs: '文档', prompts: '提示词', tests: '测试', current: '当前范围', planned: '规划范围', research: '研究范围',
    'scoped-pass': '关联范围已通过', partial: '部分 / 含待验', failed: '关联记录未通过', unverified: '未验收', unconnected: '未接入' };
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
  const sourceUrl = (file, line) => live ? `/source?path=${encodeURIComponent(file)}${line ? `#L${line}` : ''}` : `../../${file.split('/').map(encodeURIComponent).join('/')}`;
  const link = (file, text, line) => `<a href="${esc(sourceUrl(file, line))}" target="_blank" rel="noopener">${esc(text ?? file)}</a>`;
  const badge = (kind, text) => `<span class="badge ${esc(kind)}">${esc(text ?? labels[kind])}</span>`;
  const matches = (value) => JSON.stringify(value).toLocaleLowerCase().includes(state.query.toLocaleLowerCase());
  const flat = () => data.modules.flatMap((module) => module.features.map((feature) => ({ ...feature, module })));
  const ownerAllowed = (file) => !state.module || file.owners.some((owner) => owner.moduleId === state.module);

  function filters() {
    let options;
    if (state.tab === 'map') options = [['all', '全部范围'], ['current', '当前'], ['planned', '规划'], ['research', '研究'], ['changed', '代码有变化'], ['no-evidence', '无验收关联']];
    else if (state.tab === 'acceptance') options = [['all', '全部结论'], ['scoped-pass', '范围通过'], ['partial', '部分 / 待验'], ['failed', '未通过'], ['unverified', '未验收'], ['unconnected', '未接入']];
    else if (state.tab === 'prompts') options = [['all', '全部提示词'], ['development', '开发输入'], ['runtime', '运行时'], ['unlinked', '未关联']];
    else options = [['all', '全部资料'], ['code', '代码'], ['docs', '文档'], ['tests', '测试'], ['changed', '有变化'], ['unlinked', '未关联']];
    $('filters').innerHTML = options.map(([id, label]) => `<button type="button" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('');
  }

  function header() {
    $('feature-count').textContent = `${data.summary.modules} 模块 / ${data.summary.features} 功能`;
    $('source-nav').innerHTML = link('CODEX_NEXT_STEP.md', '当前阶段 ↗') + link('docs/testing/overall-acceptance-2026-09-28.md', '验收事实源 ↗', 7) + link('docs/feature-map/catalog.json', '功能关联目录 ↗');
    $('stats').innerHTML = [[data.summary.modules, '业务与技术模块'], [data.summary.features, '已登记功能'], [data.summary.relatedFiles, '关联代码与资料'], [data.git.available ? data.summary.changedFiles : '—', data.git.available ? '有未提交变化的资料' : 'Git 状态不可用'], [data.summary.unlinkedFiles, '待人工归类的文件']].map(([number, name]) => `<div class="stat"><b>${number}</b><span>${name}</span></div>`).join('');
    $('snapshot-time').textContent = `快照 ${date(data.generatedAt)} · HEAD ${data.git.head ?? '不可用'} · ${data.revision}`;
    $('refresh').hidden = !live;
    $('cadence').parentElement.hidden = !live;
    if (!live) { $('sync-state').textContent = '离线快照 · 生成后不会自动更新'; $('sync-state').className = 'offline'; }
    const errors = [...data.diagnostics, ...(data.scanError ? [`重新扫描失败，保留上一快照：${data.scanError}`] : [])];
    $('error').hidden = errors.length === 0;
    $('error').textContent = errors.join('\n');
    $('modules').innerHTML = data.modules.map((module) => `<button type="button" class="module" data-module="${esc(module.id)}" aria-pressed="${state.module === module.id}">${esc(module.name)}<span>${module.features.length}</span></button>`).join('');
  }

  function count(files) {
    const missing = files.filter((file) => !file.exists).length;
    const changed = files.filter((file) => file.change).length;
    return `<span class="count">${files.filter((file) => file.exists).length}${missing ? `<small class="missing">缺失 ${missing}</small>` : changed ? `<small class="changed">变化 ${changed}</small>` : ''}</span>`;
  }

  function featureEvidence(feature) {
    if (!feature.acceptance.length) return `${badge(feature.intent === 'current' ? 'unverified' : feature.intent, feature.intent === 'current' ? '无验收关联' : labels[feature.intent])}`;
    const priority = { failed: 0, unconnected: 1, partial: 2, unverified: 3, 'scoped-pass': 4 };
    const first = [...feature.acceptance].sort((a, b) => priority[a.kind] - priority[b.kind])[0];
    return `${badge(first.kind, first.conclusion)}<small>${feature.acceptance.length > 1 ? `另有 ${feature.acceptance.length - 1} 项关联记录 · ` : ''}范围与版本见详情</small>`;
  }

  function mapView() {
    let total = 0;
    const html = data.modules.filter((module) => !state.module || module.id === state.module).map((module) => {
      const features = module.features.filter((feature) => matches(feature) && (state.filter === 'all' || feature.intent === state.filter
        || state.filter === 'changed' && feature.code.some((file) => file.change)
        || state.filter === 'no-evidence' && !feature.acceptance.length));
      total += features.length;
      if (!features.length) return '';
      const stages = module.stageIds.map((id) => data.stages.find((stage) => stage.id === id)).filter(Boolean);
      return `<section class="module-section"><div class="section-head"><div><h2>${esc(module.name)} <span class="count">${features.length}</span></h2><p>${esc(module.description)}</p></div><div class="stages">${stages.map((stage) => `<span class="stage" title="${esc(stage.detail)}"><b>${stage.id}</b>${esc(stage.status)}</span>`).join('')}</div></div><div class="column-labels"><span>功能 · 点击展开关联资料</span><span>代码</span><span>文档</span><span>提示词</span><span>关联验收原文</span></div>${features.map((feature) => `<button type="button" class="feature" data-feature="${esc(feature.id)}"><span><span class="feature-title">${esc(feature.name)} ${feature.intent !== 'current' ? badge(feature.intent) : ''}</span><span class="feature-description">${esc(feature.description)}</span></span>${count(feature.code)}${count(feature.docs)}${count(feature.prompts)}<span class="evidence-cell">${featureEvidence(feature)}</span></button>`).join('')}</section>`;
    }).join('');
    return { html, total, label: '项功能' };
  }

  function recordHtml(record) {
    return `<article class="record"><div class="record-head"><h3>${esc(record.name)}</h3>${badge(record.kind, record.conclusion)}</div>${record.sourceWarning ? `<p class="remaining">${esc(record.sourceWarning)}</p>` : ''}<details data-record="${esc(record.name)}"><summary>查看已验证范围、依据与剩余项</summary><p>${esc(record.evidence)}</p><p class="remaining">剩余项：${esc(record.remaining || '源表未填写')}</p></details><p>${link(record.source, `查看事实源第 ${record.line} 行 ↗`, record.line)}</p></article>`;
  }

  function acceptanceView() {
    const related = new Set(flat().filter((feature) => !state.module || feature.module.id === state.module).flatMap((feature) => feature.acceptance.map((record) => record.name)));
    const rows = data.acceptance.filter((record) => (!state.module || related.has(record.name)) && matches(record) && (state.filter === 'all' || state.filter === record.kind));
    return { html: `<p class="scope-note">以下按当前表原文展示。记录保留受验时点；表后有整改接续时，请查看原文，不把历史红灯或旧通过直接当作当前源码结论。</p>${rows.map(recordHtml).join('')}`, total: rows.length, label: '项验收记录' };
  }

  function resourceView(prompts = false) {
    const isPrompt = (file) => file.path.startsWith('prompts/') || file.owners.some((owner) => owner.group === 'prompts');
    const files = data.resources.filter((file) => ownerAllowed(file) && matches(file) && (!prompts || isPrompt(file)) && (
      state.filter === 'all' || state.filter === 'unlinked' && !file.owners.length
      || state.filter === 'changed' && file.change || state.filter === file.kind
      || state.filter === 'development' && file.path.startsWith('prompts/')
      || state.filter === 'runtime' && !file.path.startsWith('prompts/')));
    const visible = files.slice(0, state.limit);
    return { html: `${prompts ? '<p class="scope-note">开发提示词、整改提示词与产品运行时提示词按来源展示；它们的授权及历史角色仍以原文为准。</p>' : ''}${visible.map((file) => `<article class="file-row"><div class="file-head">${file.exists ? link(file.path) : `<span class="missing">${esc(file.path)} · 缺失</span>`}${file.change ? badge('partial', file.change === '??' ? '未跟踪文件' : '未提交变化') : ''}</div><p class="file-meta">${esc(labels[file.kind] ?? file.kind)} · 最近修改 ${date(file.modifiedAt)} · ${file.size ?? 0} bytes</p><div class="owners">${file.owners.length ? file.owners.map((owner) => `<button type="button" data-feature="${esc(owner.featureId)}">${esc(owner.module)} / ${esc(owner.feature)}</button>`).join('') : badge('unverified', '尚未归类 · 不代表新增功能已实现')}</div></article>`).join('')}${files.length > visible.length ? `<p class="pagination"><button type="button" data-more="true">再显示 80 项</button>已显示 ${visible.length} / ${files.length}，可搜索精确定位。</p>` : ''}`, total: files.length, label: prompts ? '份提示词资料' : '份资料' };
  }

  function replaceContent(target, html) {
    const expanded = new Set([...target.querySelectorAll('details[open]')].map((item) => item.dataset.record));
    const focus = target.contains(document.activeElement) ? document.activeElement.closest('details')?.dataset.record : null;
    target.innerHTML = html;
    target.querySelectorAll('details').forEach((item) => {
      item.open = expanded.has(item.dataset.record);
      if (focus === item.dataset.record) item.querySelector('summary').focus({ preventScroll: true });
    });
  }

  function render() {
    header(); filters();
    const result = state.tab === 'map' ? mapView() : state.tab === 'acceptance' ? acceptanceView() : resourceView(state.tab === 'prompts');
    $('results-label').textContent = `${state.module ? data.modules.find((module) => module.id === state.module)?.name + ' · ' : ''}${result.total} ${result.label}${state.query ? ` · 搜索“${state.query}”` : ''}`;
    replaceContent($('results'), result.total ? result.html : '<p class="empty">没有匹配项。可以清空搜索，或选择全部模块与范围。</p>');
    if ($('detail').open) showDetail(state.detail, false);
  }

  function showDetail(id, open = true) {
    const feature = flat().find((item) => item.id === id);
    if (!feature) { $('detail').close(); return; }
    state.detail = id;
    const scroll = $('detail').scrollTop;
    $('detail-module').textContent = `${feature.module.name} / ${feature.module.stageIds.join(' · ')}`;
    $('detail-title').textContent = feature.name;
    replaceContent($('detail-body'), `<p>${esc(feature.description)}</p><p>${badge(feature.intent)} · ${feature.code.length ? '有代码资料关联；具体实现范围请核对源码与验收。' : '尚未关联实现代码。'}</p>${feature.note ? `<p class="scope-note">${esc(feature.note)}</p>` : ''}${['code', 'docs', 'prompts', 'tests'].map((group) => `<h3>${labels[group]} <span class="count">${feature[group].length}</span></h3>${feature[group].length ? `<ul>${feature[group].map((file) => `<li>${file.exists ? link(file.path) : `<span class="missing">${esc(file.path)} · 缺失/不可读</span>`}<p class="file-meta">${date(file.modifiedAt)}${file.change ? ' · ' + (file.change === '??' ? '未跟踪文件' : '未提交变化') : ''}</p></li>`).join('')}</ul>` : '<p class="file-meta">尚无关联；不自动推断实现或验收结果。</p>'}`).join('')}<h3>关联验收与剩余项</h3>${feature.acceptance.length ? feature.acceptance.map(recordHtml).join('') : '<p class="scope-note">暂无确切验收记录关联。文件存在不能替代运行证据。</p>'}`);
    if (open) $('detail').showModal(); else $('detail').scrollTop = scroll;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tab) {
      state.tab = button.dataset.tab; state.filter = 'all'; state.limit = 80;
      $('tabs').querySelectorAll('button').forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.tab === state.tab)));
    } else if (button.dataset.module) { state.module = button.dataset.module; state.limit = 80; }
    else if (button.id === 'all-modules') { state.module = ''; state.limit = 80; }
    else if (button.dataset.filter) { state.filter = button.dataset.filter; state.limit = 80; }
    else if (button.dataset.feature) { showDetail(button.dataset.feature); return; }
    else if (button.dataset.more) state.limit += 80;
    else return;
    render();
  });
  $('search').addEventListener('input', (event) => { state.query = event.target.value.trim(); state.limit = 80; render(); });
  $('close-detail').addEventListener('click', () => $('detail').close());
  $('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'relay-feature-map.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const CADENCE = [0, 2000, 5000, 15000, 60000, 300000, 1800000, 3600000, 7200000, 18000000];
  const cadenceLabel = (ms) => (ms % 3600000 ? (ms >= 60000 ? `每 ${ms / 60000} 分钟` : `每 ${ms / 1000} 秒`) : `每 ${ms / 3600000} 小时`);
  const statusText = () => (state.cadence ? `${state.cadence <= 15000 ? '实时更新' : '自动检查'} · ${cadenceLabel(state.cadence)}` : '手动模式 · 点刷新才检查');
  let syncing = false, timer = null;
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const response = await fetch('/api/map', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      const changed = next.revision !== data.revision || next.scanError !== data.scanError;
      data = next;
      $('sync-state').textContent = next.scanError ? '扫描失败 · 显示上一快照' : statusText();
      $('sync-state').className = next.scanError ? 'offline' : 'live';
      if (changed) render();
    } catch (error) {
      $('sync-state').textContent = `更新已中断 · 保留快照（${error.message}）`;
      $('sync-state').className = 'offline';
    } finally { syncing = false; }
  }
  function schedule() {
    clearInterval(timer);
    timer = state.cadence ? setInterval(sync, state.cadence) : null;
  }
  $('cadence').addEventListener('change', (event) => {
    state.cadence = Number(event.target.value);
    localStorage.setItem('relay-feature-map-cadence', String(state.cadence));
    schedule();
    $('sync-state').textContent = statusText();
    $('sync-state').className = state.cadence ? 'live' : 'offline';
    if (state.cadence) sync();
  });
  $('refresh').addEventListener('click', sync);
  render();
  if (live) {
    state.cadence = Number(localStorage.getItem('relay-feature-map-cadence') ?? 2000);
    if (!CADENCE.includes(state.cadence)) state.cadence = 2000;
    $('cadence').value = String(state.cadence);
    schedule();
    sync();
  }
})();
