import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Plus, Search, ShieldAlert, Trash2 } from "lucide-react";
import tokenDocument from "../../../../docs/frontend/design-tokens.json";
import { cssVariableName } from "../lib/tokens";
import {
  Alert, Badge, Button, Checkbox, Dialog, EmptyState, FormField, IconButton, Input, PageHeader,
  Radio, Select, Skeleton, Spinner, Switch, Textarea
} from "../ui";
import "./UiLab.css";

/**
 * UI Playground（开发环境专用）。
 *
 * 三个约束：
 * 1. **渲染真实组件**：全部从 `src/ui` 取，不给样例另写一套按钮或输入框；样例外面不加
 *    任何外观覆盖，因此「在 Playground 里看到的」就是「页面上会得到的」。
 * 2. **token 用真实计算值**：色块与数值来自 `getComputedStyle(document.documentElement)`，
 *    也就是 installDesignTokens 注入之后浏览器实际拿到的值，不是 JSON 原文。
 *    新增 token 会自动出现在分组里，不需要改这个页面。
 * 3. **构建期隔离**：路由只在 `import.meta.env.DEV` 下注册（见 router.tsx），生产产物里
 *    既没有这条路径也没有本 chunk。
 */

type TokenEntry = { $type?: string; $value: unknown; $description?: string };
const allTokens = (tokenDocument as { tokens: Record<string, TokenEntry> }).tokens;

const GROUPS: Array<{ key: string; title: string; note: string }> = [
  { key: "color", title: "颜色", note: "语义色优先：页面写 color.text.primary，不写具体色号。状态色只有 success/warning/danger/neutral/running 五组。" },
  { key: "font", title: "字体与字号", note: "两档密度：工作台正文 16px（协作长文本），页面档 13px（列表与表单）。同一语义在两档里保持同一比例。" },
  { key: "space", title: "间距", note: "4px 基数。页面内边距、组件内间距、图标与文字间距都从这里取，不写 px 字面值。" },
  { key: "radius", title: "圆角", note: "三档：控件 8px、徽标 6px、容器 16px。容器包含卡片、面板、对话框与输入器。" },
  { key: "shadow", title: "阴影", note: "surface = none：卡片靠 1px 分隔线分层；只有真正浮起来的层（菜单、对话框）用 floating。" },
  { key: "control", title: "控件尺寸", note: "高度分档：prominent 48 / 标准 40 / 舒适 44 / 紧凑 32 / 页面档 34。命中区下限 44px 不随视觉高度缩水。" },
  { key: "layout", title: "布局", note: "页面列 1220px 上限，协作工作区 1280px；两者刻意不同宽，长行不超过可读宽度。" },
  { key: "motion", title: "动效", note: "动效是展示偏好，不是业务状态：关掉之后状态文字与入口都不消失。" }
];

function tokenValueOf(name: string): string {
  const value = allTokens[name]?.$value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

export default function UiLabView() {
  const [computed, setComputed] = useState<Record<string, string>>({});
  const [dialogOpen, setDialogOpen] = useState<"none" | "dialog" | "drawer" | "lg">("none");
  const [previewWidth, setPreviewWidth] = useState<number | null>(1024);
  const [switchOn, setSwitchOn] = useState(true);

  useEffect(() => {
    const root = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const name of Object.keys(allTokens)) next[name] = root.getPropertyValue(cssVariableName(name)).trim();
    setComputed(next);
  }, []);

  const groups = useMemo(() => GROUPS.map((group) => ({
    ...group,
    tokens: Object.keys(allTokens).filter((name) => name.startsWith(`${group.key}.`))
  })), []);

  return <div className="ui-lab" data-testid="ui-lab">
    <header className="ui-lab-head">
      <div>
        <h1 className="ui-lab-title">Relay UI Playground</h1>
        <p className="ui-lab-sub">
          开发环境专用。这里渲染的是 <code>src/ui</code> 的真实生产组件与 <code>design-tokens.json</code> 的真实计算值；
          生产构建不包含这条路由（构建期隔离）。悬停、Tab、点击可直接验证交互状态。
        </p>
      </div>
      <Badge tone="neutral">仅开发环境</Badge>
    </header>

    <nav className="ui-lab-nav" aria-label="分组导航">
      <a className="text-link" href="#lab-general">通用</a>
      <a className="text-link" href="#lab-controls">控件</a>
      <a className="text-link" href="#lab-feedback">状态与反馈</a>
      <a className="text-link" href="#lab-overlay">浮层</a>
      <a className="text-link" href="#lab-structure">页面结构</a>
      <a className="text-link" href="#lab-tokens">Design Tokens</a>
      <a className="text-link" href="#lab-props">Props 约定</a>
    </nav>

    <section className="ui-lab-section" id="lab-general" aria-labelledby="lab-general-h">
      <h2 id="lab-general-h">按钮</h2>
      <p>四档变体是全部语义：primary 只给「这一步的唯一主动作」，danger 只给不可逆或终止性操作，secondary 承担其余动作，text 用于行内与密集列表。</p>

      <div className="ui-lab-row">
        <span className="ui-lab-label">变体 · md</span>
        <Button variant="primary">确认</Button>
        <Button variant="secondary">取消</Button>
        <Button variant="danger">删除</Button>
        <Button variant="text">更多</Button>
      </div>
      <div className="ui-lab-row">
        <span className="ui-lab-label">变体 · sm</span>
        <Button variant="primary" size="sm">确认</Button>
        <Button variant="secondary" size="sm">取消</Button>
        <Button variant="danger" size="sm">删除</Button>
        <Button variant="text" size="sm">更多</Button>
      </div>
      <div className="ui-lab-row">
        <span className="ui-lab-label">状态</span>
        <Button variant="secondary" disabled>不可用</Button>
        <Button variant="primary" busy>保存中</Button>
        <Button variant="secondary" icon={Plus}>带图标</Button>
        <Button variant="secondary" icon={Search}>搜索</Button>
      </div>
      <div className="ui-lab-row">
        <span className="ui-lab-label">整行</span>
        <Button variant="primary" block>主操作占满整行</Button>
      </div>
      <div className="ui-lab-row">
        <span className="ui-lab-label">图标按钮</span>
        <IconButton label="删除任务" icon={Trash2} tone="danger" />
        <IconButton label="新增" icon={Plus} />
        <IconButton label="新增（紧凑）" icon={Plus} size="sm" />
        <IconButton label="已禁用" icon={Trash2} disabled />
      </div>
    </section>

    <section className="ui-lab-section" id="lab-controls" aria-labelledby="lab-controls-h">
      <h2 id="lab-controls-h">表单控件</h2>
      <p>输入框、下拉与多行框由 styles.css 的全局控件规则统一几何与各状态；FormField 只负责标签关联与错误播报。校验失败时错误用 role="alert" 播报，边框色只在视觉上补一次。</p>

      <div className="ui-lab-form">
        <FormField label="项目名称" htmlFor="lab-name" required hint="用于列表与面包屑显示">
          <Input id="lab-name" defaultValue="毕业论文项目" />
        </FormField>
        <FormField label="工作目录" htmlFor="lab-dir" hint="本机绝对路径">
          <Input id="lab-dir" defaultValue="D:/Develop/Relay-Agent" />
        </FormField>
        <FormField label="优先级" htmlFor="lab-priority">
          <Select id="lab-priority" defaultValue="normal">
            <option value="low">低</option>
            <option value="normal">普通</option>
            <option value="high">高</option>
          </Select>
        </FormField>
        <FormField label="名称" htmlFor="lab-invalid" error="名称不能为空">
          <Input id="lab-invalid" invalid defaultValue="" />
        </FormField>
        <FormField label="已禁用" htmlFor="lab-disabled">
          <Input id="lab-disabled" disabled defaultValue="不可编辑" />
        </FormField>
        <FormField label="任务描述" htmlFor="lab-desc" hint="支持多行">
          <Textarea id="lab-desc" rows={3} defaultValue="整理第三章的证据链。" />
        </FormField>
      </div>

      <div className="ui-lab-row" style={{ marginBlockStart: "var(--relay-space-4)" }}>
        <span className="ui-lab-label">勾选</span>
        <Checkbox label="记住这次选择" description="下次不再询问" defaultChecked />
        <Checkbox label="已禁用" disabled />
      </div>
      <div className="ui-lab-row">
        <span className="ui-lab-label">单选</span>
        <Radio name="lab-radio" label="本机执行" defaultChecked />
        <Radio name="lab-radio" label="委派给 Agent" />
      </div>
      <div className="ui-lab-row">
        <span className="ui-lab-label">开关</span>
        <Switch checked={switchOn} onChange={setSwitchOn} label="启用记忆" description="仅保存在本机" />
        <Switch checked={false} onChange={() => undefined} label="已禁用" disabled />
      </div>

      <div className="ui-lab-row">
        <span className="ui-lab-label">宽度预览</span>
        {[390, 768, 1024, 1280].map((width) => <Button
          key={width}
          variant={previewWidth === width ? "primary" : "secondary"}
          size="sm"
          onClick={() => setPreviewWidth(width)}
        >{width}px</Button>)}
        <Button variant={previewWidth === null ? "primary" : "secondary"} size="sm" onClick={() => setPreviewWidth(null)}>自适应</Button>
      </div>
      <div className="ui-lab-preview" style={{ maxWidth: previewWidth ?? "100%" }}>
        <div className="ui-lab-row" style={{ marginBlockEnd: "var(--relay-space-3)" }}>
          <Button variant="primary" size="sm">主操作</Button>
          <Button variant="secondary" size="sm">次操作</Button>
          <Badge tone="success">3 项通过</Badge>
        </div>
        <FormField label="窄容器里的字段" htmlFor="lab-narrow" hint="字段在 390px 下应保持单列且不溢出">
          <Input id="lab-narrow" placeholder="输入内容" />
        </FormField>
      </div>
    </section>

    <section className="ui-lab-section" id="lab-feedback" aria-labelledby="lab-feedback-h">
      <h2 id="lab-feedback-h">状态与反馈</h2>
      <p>状态标签只有四档语气，且与任务状态芯片共用同一套类名。状态条（Alert）四档共用一套配方：状态底色 + 35% 状态色的 1px 边框。</p>

      <div className="ui-lab-row">
        <span className="ui-lab-label">标签</span>
        <Badge tone="neutral">示例数据</Badge>
        <Badge tone="success" icon={CheckCircle2}>已通过</Badge>
        <Badge tone="warning" icon={AlertTriangle}>待确认</Badge>
        <Badge tone="danger" icon={ShieldAlert}>已阻塞</Badge>
      </div>
      <div className="ui-lab-row" style={{ marginBlockEnd: "var(--relay-space-4)" }}>
        <span className="ui-lab-label">加载</span>
        <Spinner label="正在载入" />
        <Button variant="secondary" size="sm" busy>进行中</Button>
        <div style={{ width: "12rem" }}>
          <Skeleton lines={2} />
        </div>
      </div>
      <div style={{ display: "grid", gap: "var(--relay-space-3)" }}>
        <Alert tone="info" icon={Info} title="示例数据预览">当前读取的是本机示例数据，不写入任何业务事实。</Alert>
        <Alert tone="success" icon={CheckCircle2} title="已保存">草稿已写入本地，未提交到项目状态。</Alert>
        <Alert tone="warning" icon={AlertTriangle} title="需要人工确认" actions={<Button variant="secondary" size="sm" icon={ArrowRight}>去确认</Button>}>
          该任务等待验收，Agent 不会自行推进。
        </Alert>
        <Alert tone="danger" icon={ShieldAlert} title="保存失败">网络不可用，请检查本机服务后重试。</Alert>
      </div>
      <div style={{ marginBlockStart: "var(--relay-space-4)", border: "var(--relay-border-width) solid var(--relay-color-border-separator)", borderRadius: "var(--relay-radius-control)" }}>
        <EmptyState
          title="还没有任务"
          description="任务来自项目状态。先建一个项目，再为它拆出第一步。"
          actions={<Button variant="primary" size="sm" icon={Plus}>新建任务</Button>}
        />
      </div>
    </section>

    <section className="ui-lab-section" id="lab-overlay" aria-labelledby="lab-overlay-h">
      <h2 id="lab-overlay-h">浮层</h2>
      <p>对话框与抽屉是同一个组件的两个变体：焦点进入面板、Tab 在面板内循环、Esc 关闭并把焦点还给触发元素。这些行为由 AppDialog 统一负责，页面不自行实现。</p>
      <div className="ui-lab-row">
        <Button variant="secondary" onClick={() => setDialogOpen("dialog")}>打开对话框</Button>
        <Button variant="secondary" onClick={() => setDialogOpen("drawer")}>打开抽屉</Button>
        <Button variant="secondary" onClick={() => setDialogOpen("lg")}>加宽对话框</Button>
        <span className="ui-lab-sub">打开后按 Tab 检查焦点循环，按 Esc 关闭并检查焦点是否回到按钮上。</span>
      </div>
      <Dialog
        open={dialogOpen !== "none"}
        title={dialogOpen === "drawer" ? "检查器" : "确认删除"}
        variant={dialogOpen === "drawer" ? "drawer" : "dialog"}
        size={dialogOpen === "lg" ? "lg" : undefined}
        subtitle={dialogOpen === "lg" ? "这一档用于需要并排比较内容的场景" : undefined}
        onClose={() => setDialogOpen("none")}
      >
        <FormField label="删除原因" htmlFor="lab-dialog-reason" hint="会记录在活动里">
          <Input id="lab-dialog-reason" placeholder="例如：重复任务" />
        </FormField>
        <div className="ui-lab-row" style={{ marginBlockStart: "var(--relay-space-4)", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={() => setDialogOpen("none")}>取消</Button>
          <Button variant="danger" onClick={() => setDialogOpen("none")}>删除</Button>
        </div>
      </Dialog>
    </section>

    <section className="ui-lab-section" id="lab-structure" aria-labelledby="lab-structure-h">
      <h2 id="lab-structure-h">页面结构</h2>
      <p>页头是所有页面的第一层：标题、状态、并列事实、目标句、常驻动作。次级与诊断动作收进「更多操作」，不隐藏也不占首屏。</p>
      <div style={{ border: "var(--relay-border-width) solid var(--relay-color-border-separator)", borderRadius: "var(--relay-radius-control)", padding: "var(--relay-space-4)" }}>
        <PageHeader
          title="页面标题样例"
          status={<Badge tone="warning">进行中</Badge>}
          meta="P-01 · 最近更新 10 分钟前"
          lede="一句话说明这个页面要让用户决定什么，而不是复述模块名。"
          actions={<Button variant="primary" size="sm" icon={Plus}>新建</Button>}
          more={<Button variant="text" size="sm">归档</Button>}
        />
      </div>
    </section>

    <section className="ui-lab-section" id="lab-tokens" aria-labelledby="lab-tokens-h">
      <h2 id="lab-tokens-h">Design Tokens</h2>
      <p>下面每一项都是浏览器实际计算出来的值（插值后），与 <code>docs/frontend/design-tokens.json</code> 一一对应。页面只应引用变量名，不要抄这里的值。</p>
      {groups.map((group) => <div key={group.key} style={{ marginBlockEnd: "var(--relay-space-6)" }}>
        <h3 id={`lab-tokens-${group.key}`} style={{ fontSize: "var(--relay-font-size-meta)", marginBlockEnd: "var(--relay-space-1)" }}>{group.title}</h3>
        <p className="ui-lab-sub" style={{ marginBlockEnd: "var(--relay-space-3)" }}>{group.note}</p>
        {/* 颜色用色块网格（看得出深浅），其余用紧凑表（只有名字和值，一屏能扫完）。 */}
        {group.key === "color"
          ? <div className="ui-lab-grid">
            {group.tokens.map((name) => <div className="ui-lab-card" key={name}>
              <span className="ui-lab-swatch">
                <span className="ui-lab-swatch__chip" style={{ background: `var(${cssVariableName(name)})` }} aria-hidden="true" />
                <span className="ui-lab-swatch__value" title={name}>{name}</span>
              </span>
              <span className="ui-lab-swatch__value" style={{ color: "var(--relay-color-text-primary)" }}>{computed[name] ?? tokenValueOf(name)}</span>
            </div>)}
          </div>
          : <table className="ui-lab-table">
            <thead><tr><th>token</th><th>运行时值</th><th>源值</th></tr></thead>
            <tbody>
              {group.tokens.map((name) => <tr key={name}>
                <td><code>{name}</code></td>
                <td>{computed[name] || "—"}</td>
                <td>{tokenValueOf(name)}</td>
              </tr>)}
            </tbody>
          </table>}
      </div>)}
    </section>

    <section className="ui-lab-section" id="lab-props" aria-labelledby="lab-props-h">
      <h2 id="lab-props-h">Props 约定</h2>
      <p>Props 是 API 契约：新增变体要改这里和组件，不能在页面里靠 className 拼出第五种按钮。</p>
      <table className="ui-lab-table">
        <thead><tr><th>组件</th><th>Props</th><th>约定</th></tr></thead>
        <tbody>
          <tr><td><code>Button</code></td><td><code>variant</code> primary | secondary(默认) | danger | text · <code>size</code> md | sm · <code>block</code> · <code>busy</code> · <code>icon</code></td><td>busy 自动置 disabled 与 aria-busy；链接用 buttonClassName 复用同一套类名。</td></tr>
          <tr><td><code>IconButton</code></td><td><code>label</code>（必填）· <code>icon</code> · <code>size</code> · <code>tone</code></td><td>label 同时是 aria-label 与原生 title；不提供无名图标按钮。</td></tr>
          <tr><td><code>FormField</code></td><td><code>label</code> · <code>hint</code> · <code>error</code> · <code>required</code> · <code>htmlFor</code> · <code>layout</code> stack | row | grid</td><td>有 error 时不再显示 hint，并用 role="alert" 播报。</td></tr>
          <tr><td><code>Switch</code></td><td><code>checked</code> · <code>onChange</code> · <code>label</code> · <code>description</code> · <code>disabled</code></td><td>role="switch"，受控；不发命令，只报告用户意图。</td></tr>
          <tr><td><code>Badge</code></td><td><code>tone</code> neutral | success | warning | danger · <code>icon</code> · <code>title</code></td><td>与任务状态芯片共用 .status-chip，不再出现第二种标签。</td></tr>
          <tr><td><code>Alert</code></td><td><code>tone</code> info | success | warning | danger · <code>title</code> · <code>actions</code></td><td>danger 用 role="alert"，其余 status。</td></tr>
        </tbody>
      </table>
    </section>
  </div>;
}
