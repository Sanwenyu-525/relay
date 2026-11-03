import type { ReactNode } from "react";

export interface FixtureNoteProps {
  children: ReactNode;
  testId?: string;
}

/**
 * 示例数据 / 未连接说明：中性提示，不使用琥珀警告语义。
 *
 * 警告色只留给真实风险（未保存、结果待核对、权限被拒）。「示例模式没有真实数据」
 * 是产品的正常预览状态，不是风险；用琥珀色当地面会让整页出现第三种语义色，
 * 也会让真正需要停顿的警告失去区分度。样式见 styles.css 的 `.fixture-note`。
 */
export default function FixtureNote({ children, testId }: FixtureNoteProps) {
  return <p className="fixture-note" role="status" data-testid={testId}>{children}</p>;
}
