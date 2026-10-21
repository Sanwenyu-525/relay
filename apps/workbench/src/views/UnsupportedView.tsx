import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export default function UnsupportedView() {
  return <section className="unsupported-page"><p className="eyebrow">未找到的入口</p><h1>该入口不存在或未开放</h1><p>请检查地址是否完整。可以从项目列表重新进入，或使用左侧导航前往其他功能。</p><Link className="text-link" to="/projects">返回项目列表<ArrowRight aria-hidden="true" /></Link></section>;
}
