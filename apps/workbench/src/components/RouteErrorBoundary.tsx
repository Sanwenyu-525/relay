import { Link, useRouteError } from "react-router-dom";

/**
 * 路由级兜底错误页（router.tsx 根路由的 errorElement）。
 *
 * 此前任何组件的渲染错误都会摔到 React Router 面向开发者的英文默认错误页
 * （2026-10-15 更换目录弹窗的一次 HMR 中间态就触发过）。这里换成中文兜底页：
 * 如实显示错误名与消息，不吞错误也不猜原因；给「刷新页面」与「返回工作台」
 * 两个出口。崩溃只影响前端视图，服务端的项目、任务与会话事实不受影响。
 * 堆栈仅在 dev 构建展开：帮助定位，又不把调用路径铺满用户屏幕。
 */
export default function RouteErrorBoundary() {
  const error = useRouteError();
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return <main className="route-error" data-testid="route-error-boundary">
    <h1>界面遇到未处理的错误</h1>
    <p className="action-error" data-testid="route-error-summary">{summary}</p>
    <p className="helper-text">这一页停止渲染是前端问题；服务端保存的项目、任务与会话不受影响。刷新页面会重新加载最新代码。</p>
    <div className="form-actions">
      <button type="button" className="primary-button" data-testid="route-error-reload"
        onClick={() => window.location.reload()}>刷新页面</button>
      <Link className="secondary-button" to="/projects">返回工作台</Link>
    </div>
    {import.meta.env.DEV && error instanceof Error && error.stack &&
      <pre className="route-error-stack" data-testid="route-error-stack">{error.stack}</pre>}
  </main>;
}
