import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export default function UnsupportedView() {
  return <section className="unsupported-page"><p className="eyebrow">当前范围外入口</p><h1>此入口尚未接入交互预览</h1><p>本轮交互预览已接入项目列表与创建、任务列表与新建、项目任务，以及项目蓝图、任务定义、验收方案与恢复摘要。其他入口不会伪造空白页面或未实现的业务功能。</p><Link className="text-link" to="/projects">前往项目列表<ArrowRight aria-hidden="true" /></Link></section>;
}
