import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, Bell, BookOpen, CaretDown, CaretRight, Circle, Copy, DotsThree, FileText, Folder, Gear, House, Info, Link, List, MagnifyingGlass, PaperPlaneTilt, Plus, ThumbsDown, ThumbsUp, Trash, X } from '@phosphor-icons/react';
import palette from './palette.json';

const tasks = [
  { id: 'repair', title: '桌面修复D1回归-20260929 委托任务-1790646373833', project: 'UI取证-20260929 空项目B', status: '已取消', time: '10:42', goal: '验证 worker 崩溃后宿主有界重启与可观测性（mock 网关）。' },
  { id: 'output', title: 'UI取证-20260929 产物任务T2', project: 'UI取证-20260929 项目A', status: 'READY', time: '昨天 16:20', goal: '核对候选文档的内容与验收条件。' },
  { id: 'review', title: 'UI取证-20260929 委托任务T6-1', project: 'UI取证-20260929 项目A', status: '已完成', time: '昨天 14:08', goal: '整理本次任务的完成依据。' },
  { id: 'notes', title: 'UI取证-20260929 委托任务T6-2', project: 'UI取证-20260929 项目A', status: 'READY', time: '昨天 10:32', goal: '讨论后续需要核对的范围。' },
  { id: 'thesis-1', title: 'UI取证-20260928 文献综述委托T7-1', project: 'UI取证-20260928 项目A', status: 'READY', time: '周二 09:12', goal: '整理已确认的文献条目与筛选依据。' },
  { id: 'thesis-2', title: 'UI取证-20260928 产物任务T7-2', project: 'UI取证-20260928 项目A', status: '已完成', time: '周二 08:40', goal: '核对引用格式与章节顺序。' },
  { id: 'thesis-3', title: 'UI取证-20260928 委托任务T7-3', project: 'UI取证-20260928 项目A', status: '已取消', time: '周一 20:05', goal: '范围未确认前不继续执行。' },
  { id: 'resume-1', title: 'UI取证-20260928 窗口恢复委托T8-1', project: 'UI取证-20260928 项目B', status: 'READY', time: '周一 15:30', goal: '复核恢复后的运行状态与账本。' },
  { id: 'resume-2', title: 'UI取证-20260928 委托任务T8-2', project: 'UI取证-20260928 项目B', status: '已完成', time: '周一 14:02', goal: '整理停止点与未完成项。' },
  { id: 'resume-3', title: 'UI取证-20260928 产物任务T8-3', project: 'UI取证-20260928 项目B', status: 'READY', time: '周一 11:26', goal: '等待安全点后继续生成。' },
];
const projectOrder = ['UI取证-20260929 空项目B', 'UI取证-20260929 项目A', 'UI取证-20260928 项目A', 'UI取证-20260928 项目B'];
const pinnedProjects = 2;
const sections = [
  { name: '工作台', icon: House, route: '/agent', rule: '采用紧凑上下文、独立消息滚动和底部输入；保留任务与会话身份、草稿以及真实执行状态。' },
  { name: '项目', icon: Folder, route: '/projects', rule: '沿用图标导航与近期工作栏。继续展示项目列表、范围筛选、分页、目标与下一步，页面标题和主操作合并成紧凑工具栏。' },
  { name: '待处理', icon: Bell, route: '/reviews', rule: '沿用共享导航；保留待处理列表、确切正文和判断动作。审批对象、风险与条件常驻，接受判断不等于任务完成。' },
  { name: '资料', icon: BookOpen, route: '/knowledge', rule: '文件名称、版本和编辑同排，正文优先。来源与辅助说明按需打开，历史版本、读取失败与冲突不能被隐藏。' },
  { name: '设置', icon: Gear, route: '/settings', rule: '沿用紧凑上下文。分组与长表单自然滚动，错误紧邻字段；保留草稿、权限边界和原命令核对。' },
  { name: '连接与同步', icon: Link, route: '/connections', rule: '连接、能力与权限分别表达；连接成功不会自动授予执行权限。' },
];
const initialReply = '我目前没有看到任何已选中的资料文件。\n\n当前会话的显式选中资料为「无」。你可以先添加资料，再告诉我希望分析什么。';
const initialMessages = [{ id: 'question', role: 'user', text: '现在可以读取我选中的资料吗？', time: '10:42' }, { id: 'answer', role: 'assistant', text: initialReply, time: '10:42', initial: true }];
const sourceOptions = ['任务说明.md', '桌面诊断.log', '验收条件.txt'];
function IconButton({ icon: Icon, label, onClick, ...props }) { return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick} {...props}><Icon size={23} /></button>; }

export function App() {
  const [taskId, setTaskId] = useState('repair');
  const [session, setSession] = useState('current');
  const [chats, setChats] = useState({ 'repair:current': initialMessages });
  const [drafts, setDrafts] = useState({});
  const [sources, setSources] = useState({});
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState(null);
  const [scope, setScope] = useState(sections[0]);
  const [menu, setMenu] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const [intent, setIntent] = useState('普通讨论');
  const [busy, setBusy] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [allProjects, setAllProjects] = useState(false);
  const [notice, setNotice] = useState('');
  const searchRef = useRef(null), inputRef = useRef(null), messagesRef = useRef(null), panelCloseRef = useRef(null), returnFocusRef = useRef(null);
  const timerRef = useRef(null), composingRef = useRef(false), followRef = useRef(true);
  const task = tasks.find(item => item.id === taskId);
  const key = `${taskId}:${session}`;
  const messages = chats[key] || [];
  const draft = drafts[key] || '';
  const selectedSources = sources[key] || [];
  const listedProjects = allProjects ? projectOrder : projectOrder.slice(0, pinnedProjects);
  const hiddenProjects = projectOrder.length - pinnedProjects;
  const matches = item => `${item.title} ${item.project}`.toLowerCase().includes(query.trim().toLowerCase());
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => { if (followRef.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight; }, [messages, busy, key]);
  useEffect(() => { if (panel) panelCloseRef.current?.focus(); }, [panel]);
  useEffect(() => {
    const onKey = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape') { setMenu(false); setNavigation(false); if (panel) { setPanel(null); returnFocusRef.current?.focus(); } }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel]);
  function openPanel(next, event) { returnFocusRef.current = event.currentTarget; setMenu(false); setNavigation(false); setPanel(next); }
  function closePanel() { setPanel(null); returnFocusRef.current?.focus(); }
  function changeConversation(nextTask, nextSession = 'current') {
    if (busy) return;
    setTaskId(nextTask); setSession(nextSession); setNavigation(false); setPanel(null); setMenu(false);
    followRef.current = true; setFollowLatest(true); setNotice('');
  }
  function newConversation() { changeConversation(taskId, `new-${Date.now()}`); inputRef.current?.focus(); }
  function updateDraft(value) { setDrafts(previous => ({ ...previous, [key]: value })); }
  function sendMessage(event) {
    event?.preventDefault();
    if (busy || !draft.trim()) return;
    const conversationKey = key, text = draft.trim(), sourceCount = selectedSources.length;
    setChats(previous => ({ ...previous, [conversationKey]: [...(previous[conversationKey] || []), { id: `user-${Date.now()}`, role: 'user', text, time: '刚刚' }] }));
    updateDraft(''); setBusy(true);
    timerRef.current = setTimeout(() => {
      const answer = sourceCount ? `已在这段示例讨论中选中 ${sourceCount} 份资料。你可以继续说明希望分析的重点；此处展示回复排版，不代表已经读取真实文件。` : '我记下了这段讨论。当前尚未选中资料；你可以添加资料，或继续直接提供内容。任务状态保持原样，没有开始执行。';
      setChats(previous => ({ ...previous, [conversationKey]: [...(previous[conversationKey] || []), { id: `assistant-${Date.now()}`, role: 'assistant', text: answer, time: '刚刚' }] }));
      setBusy(false);
    }, 650);
  }
  function onScroll() { const element = messagesRef.current; const following = element.scrollHeight - element.scrollTop - element.clientHeight < 48; followRef.current = following; setFollowLatest(following); }
  function latest() { followRef.current = true; setFollowLatest(true); messagesRef.current.scrollTop = messagesRef.current.scrollHeight; }
  function toggleSource(name) { setSources(previous => ({ ...previous, [key]: selectedSources.includes(name) ? selectedSources.filter(item => item !== name) : [...selectedSources, name] })); }
  const style = Object.fromEntries(Object.entries(palette).map(([name, value]) => [`--${name}`, value]));
  return <div className="prototype-app" style={style}>
    <header className="window-toolbar">
      <IconButton icon={List} label="打开近期任务导航" onClick={() => setNavigation(value => !value)} className="icon-button mobile-navigation" />
      <IconButton icon={ArrowLeft} label="上一个任务" disabled={busy || taskId === tasks[0].id} onClick={() => changeConversation(tasks[Math.max(0, tasks.findIndex(item => item.id === taskId) - 1)].id)} />
      <IconButton icon={ArrowRight} label="下一个任务" disabled={busy || taskId === tasks[tasks.length - 1].id} onClick={() => changeConversation(tasks[Math.min(tasks.length - 1, tasks.findIndex(item => item.id === taskId) + 1)].id)} />
      <button className="toolbar-search" onClick={() => searchRef.current?.focus()}><MagnifyingGlass size={22} />搜索资料…</button>
      <button className="button" onClick={newConversation} disabled={busy}><Plus size={22} />新建</button>
    </header>
    <div className="workspace">
      <aside className="icon-rail" aria-label="主导航"><div className="rail-main">{sections.slice(0, 4).map(({ name, icon: Icon }, index) => <button key={name} className={`rail-link ${index === 0 ? 'selected' : ''}`} aria-current={index === 0 ? 'page' : undefined} onClick={event => { setScope(sections[index]); openPanel('scope', event); }}><Icon size={32} /><span>{name}</span></button>)}</div><div className="rail-bottom">{sections.slice(4).map(section => <button key={section.name} className="rail-link" onClick={event => { setScope(section); openPanel('scope', event); }}><section.icon size={31} /><span>{section.name}</span></button>)}</div></aside>
      {navigation && <button className="navigation-scrim" aria-label="关闭近期任务导航" onClick={() => setNavigation(false)} />}
      <aside className={`recent-panel ${navigation ? 'is-open' : ''}`} aria-label="近期任务">
        <div className="recent-brand"><strong>Relay</strong><button className="button" disabled={busy} onClick={newConversation}><Plus size={22} />新对话</button></div>
        <label className="recent-search"><MagnifyingGlass size={23} /><input ref={searchRef} aria-label="搜索项目或任务" placeholder="搜索项目或任务…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="recent-heading"><span>最近的任务</span><span>已加载 {tasks.length} 项</span></div>
        <div className="recent-list">{listedProjects.map(project => <section className="project-group" key={project}><h2><CaretDown size={16} /><span className="group-name">{project}</span><span className="group-count">（{tasks.filter(item => item.project === project).length}）</span></h2><div className="project-tasks">{tasks.filter(item => item.project === project && matches(item)).map(item => <button disabled={busy} className={`task-row ${item.id === taskId ? 'selected' : ''}`} key={item.id} onClick={() => changeConversation(item.id)} title={item.title}><span>{item.title}</span><small>{item.time}</small></button>)}</div></section>)}{!allProjects && hiddenProjects > 0 && <button className="more-projects" onClick={() => setAllProjects(true)}><CaretRight size={16} />更多项目（{hiddenProjects}）</button>}{!tasks.some(matches) && <p className="empty-search">没有匹配的项目或任务</p>}</div>
      </aside>
      <main className="conversation">
        <header className="chat-header"><Folder size={31} className="header-folder" /><div className="chat-context"><div className="task-heading"><h1 title={task.title}>{task.title}</h1><span className="status-badge">{task.status}</span></div><p>{task.project}<span className="meta-dot">·</span>当前无执行</p></div><button className="details-toggle" onClick={event => openPanel('task', event)}><FileText size={23} /><span>任务详情</span></button><div className="more-wrap"><IconButton icon={DotsThree} label="更多操作" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(value => !value)} />{menu && <div className="more-menu" role="menu"><button role="menuitem" onClick={event => openPanel('task', event)}>查看完整任务</button><button role="menuitem" onClick={newConversation} disabled={busy}>新建对话</button><button role="menuitem" disabled>委托 AI 执行</button><p>{task.status === 'READY' ? '原型仅演示讨论，不发起真实执行' : '仅 READY 任务可委托'}</p></div>}</div></header>
        <div className="chat-content"><div className="messages" ref={messagesRef} onScroll={onScroll} aria-label="聊天记录" tabIndex={0}><div className="message-column">{messages.length === 0 && <div className="empty-conversation"><h2>开始新的讨论</h2><p>沿用当前任务。发送想法，或先选择需要讨论的资料。</p></div>}{messages.map(message => <article key={message.id} className={`message ${message.role}`}><p className="message-author">{message.role === 'user' ? '我' : 'Relay'}<span>· {message.time}</span></p><div className="message-body">{message.text.split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}{message.initial && <><h2>接下来可以这样做</h2><ol><li><strong>选择或上传资料</strong><p>在输入区点击「资料」，添加文档、代码或日志。</p></li><li><strong>直接粘贴内容</strong><p>资料较少时，可以直接粘贴到对话中。</p></li></ol><p>添加资料后，我会先确认读取范围，再继续分析。</p></>}</div>{message.role === 'assistant' && <div className="message-actions"><span><BookOpen size={23} />{message.initial ? '未读取资料' : '示例回复'}</span><IconButton icon={Copy} label="复制回复" onClick={async () => { try { await navigator.clipboard.writeText(message.text); setNotice('已复制回复'); } catch { setNotice('请选取正文后复制'); } }} /><IconButton icon={ThumbsUp} label="认可回复" onClick={() => setNotice('已记录这条示例回复的反馈')} /><IconButton icon={ThumbsDown} label="需要改进" onClick={() => setNotice('已记录这条示例回复的反馈')} /></div>}</article>)}{busy && <p className="reply-pending" role="status">Relay 正在组织回复…</p>}</div></div>{!followLatest && <button className="latest-button" onClick={latest}><ArrowDown size={22} />回到最新</button>}
          <div className="composer-wrap"><form className="composer" onSubmit={sendMessage}><textarea ref={inputRef} aria-label="输入你的想法" placeholder="输入你的想法、修改意见或新的要求" value={draft} onChange={event => updateDraft(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); sendMessage(); } }} /><div className="composer-footer"><button className="button source-button" type="button" onClick={event => openPanel('sources', event)}><BookOpen size={24} />资料 {selectedSources.length}</button><label className="intent-select"><Plus size={20} /><select aria-label="讨论意图" value={intent} onChange={event => setIntent(event.target.value)}><option>普通讨论</option><option>分析资料</option></select></label><span className="composer-spacer" /><span className="usage"><Circle size={21} />缓存未采集<Info size={18} /></span><button className="send-button" disabled={busy || !draft.trim()} type="submit" aria-label="发送讨论"><PaperPlaneTilt size={27} /></button></div></form></div>
        </div>
      </main>
    </div>
    {panel && <><button className="panel-scrim" aria-label="关闭详情面板" onClick={closePanel} /><aside className="detail-panel" role="dialog" aria-modal="true" aria-labelledby="panelTitle"><header><h2 id="panelTitle">{panel === 'task' ? '任务详情' : panel === 'sources' ? '选择资料' : `${scope.name} · 适配范围`}</h2><button ref={panelCloseRef} className="icon-button" aria-label="关闭详情" onClick={closePanel}><X size={24} /></button></header><div className="panel-body">{panel === 'task' && <><dl><dt>任务</dt><dd>{task.title}</dd><dt>状态</dt><dd>{task.status}</dd><dt>项目</dt><dd>{task.project}</dd><dt>目标</dt><dd>{task.goal}</dd><dt>当前会话</dt><dd><select className="panel-select" aria-label="切换会话" disabled={busy} value={session} onChange={event => changeConversation(taskId, event.target.value)}><option value="current">当前会话</option><option value="previous">上一次讨论</option>{session.startsWith('new-') && <option value={session}>新对话</option>}</select></dd><dt>当前执行</dt><dd>无活动 Run</dd><dt>当前执行者</dt><dd>我</dd></dl><button className="button disabled-delegate" disabled>委托 AI 执行</button><p className="panel-help">{task.status === 'READY' ? '原型仅演示讨论，不发起真实执行。' : '仅 READY 任务可委托。'}</p></>}{panel === 'sources' && <><p>选择用于这段讨论的示例资料。</p>{sourceOptions.map(name => <label className="source-option" key={name}><input type="checkbox" checked={selectedSources.includes(name)} onChange={() => toggleSource(name)} /><FileText size={23} /><span>{name}</span></label>)}{selectedSources.length > 0 && <button className="button" onClick={() => setSources(previous => ({ ...previous, [key]: [] }))}><Trash size={21} />移除全部选中资料</button>}<p className="panel-help">这里仅演示资料选择，不上传或读取真实文件。</p></>}{panel === 'scope' && <><p className="scope-route">{scope.route}</p><p>{scope.rule}</p><h3>全站共享规则</h3><p>图标导航、近期工作与紧凑上下文保持一致；正文依据各页用途组织。</p><p>UNKNOWN、停止待安全点、权限拒绝、审批风险与冲突必须保持可见。</p><p className="panel-help">这是其他页面的设计适配说明，尚未制作对应业务页面。</p></>}<p className="prototype-note">交互原型 · 示例数据，所有讨论只保留在本页内存中。</p></div></aside></>}
    {notice && <div className="feedback-notice" role="status">{notice}<button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={17} /></button></div>}
  </div>;
}
