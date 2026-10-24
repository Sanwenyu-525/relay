# -*- coding: utf-8 -*-
# 一次性脚本 D：①返工的文档同步（五处）。
import io

# 1) 工作台 §27.3.7
path = 'docs/frontend/workbench-design.md'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
old = "- 当前是**首写前像**而非发送前基线：消息发送后、该路径首次写入前的外部修改会被当作发送前状态恢复；与 §27.3.4、运行架构 §8.5 的发送前基线规则冲突。**2026-10-24 用户已拍板按发送前基线返工**（见上）。\r\n"
new = "- 基线语义已按 **2026-10-24 用户拍板返工为发送前基线**并实施：每条用户消息在准入事务内对受管根建字节基线（迁移 0132 的 `assist_message_baselines`＋`assist_message_baseline_files`＋`assist_message_snapshot_blobs` 内容寻址库，同内容跨消息去重），提交后助手轮次才可能写文件，故基线即「发送前」状态；采集失败/超限/预算占满按 INCOMPLETE 如实降级、不阻塞消息（SQL SAVEPOINT 兜底）。前像表与 Gateway 写路径钩子整体移除。RA-10 判定性场景（发送后、首写前外部修改→恢复发送前字节而非外部内容）真实运行通过。\r\n"
assert text.count(old) == 1, 'workbench preimage line'
text = text.replace(old, new)
with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('workbench updated')

# 2) HTTP §10.111：语义偏差段改写
path = 'docs/api/http-command-contract.md'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
old = "- **已知语义偏差**：前像取「消息发送后该路径首次写入前」，不是「消息发送前」。发送后、首写前的外部修改会被当作基线恢复；这与工作台 §27.3.4 与运行架构 §8.5 的发送前基线规则冲突，口径待产品拍板。另："
new = "- **基线语义（2026-10-24 用户拍板后已返工）**：恢复目标读**发送前基线**——目标用户消息在准入事务内对受管根建立的字节基线（`assist_message_baselines`，条目在 `assist_message_baseline_files`，字节在内容寻址库 `assist_message_snapshot_blobs`，同内容跨消息去重）；COMPLETE 基线下无条目＝发送前不存在，INCOMPLETE（采集超限/预算占满/存储失败）下缺条目按 `BASELINE_UNKNOWN`/不可恢复如实处理。发送后、首写前的外部修改不再被当作发送前状态（RA-10 判定性场景通过）。前像表已移除。另："
assert text.count(old) == 1, 'http deviation'
text = text.replace(old, new)
with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('http updated')

# 3) 数据库设计 §111：表清单改写
path = 'docs/database/physical-design-postgresql.md'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
idx = text.index('## 111. 0132')
seg_end = text.index('## 112', idx) if '## 112' in text[idx:] else len(text)
seg = text[idx:seg_end]
old_first = seg[seg.index('- **'):seg.index('\n- **', seg.index('- **`assist_message_recalls`'))]
# 找到前像描述行（含 assist_message_file_preimages 或首行）并替换
if 'assist_message_file_preimages' in seg:
    print('db doc mentions preimages — needs table list rewrite')
else:
    print('db doc clean')
# 直接在段落开头追加返工说明（保守做法：不重写整段）
marker = seg.index('\n', seg.index('## 111.')) + 1
addition = ('\n> **2026-10-24 返工（用户拍板发送前基线口径）**：本节此前描述的 `assist_message_file_preimages`（首写前像）已由 `assist_message_baselines`＋`assist_message_baseline_files`＋`assist_message_snapshot_blobs`（内容寻址字节库，同内容跨消息去重；容量与保留按此计量）替代；前像表与 Gateway 写路径钩子移除。逐行字段描述中「前像」读作「基线条目」，`existed/sha256/content/source` 对应 `existed/blob_sha256/（字节库引用）/（已无）`；基线新增 `status(COMPLETE/INCOMPLETE)/reason/file_count/total_bytes` 与 `uq_assist_baseline_message`。下文按当时快照保留，不逐行改写。\n')
text = text[:idx + marker] + addition + text[idx + marker:]
with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('db updated')

# 4) 测试计划 §26.4
path = 'docs/testing/verification-plan.md'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()
old = "实现采用「消息发送后首写前像」而非 §27.3.4 的发送前基线，因此 BC-12 只按该形态部分覆盖。"
new = "2026-10-24 用户拍板后已**返工为 §27.3.4 的发送前基线**（消息准入事务内建基线、内容寻址去重；前像实现移除），BC-12 的「发送前」语义由 RA-10 判定性场景覆盖（发送后、首写前的外部修改不再被当作发送前状态）。"
assert text.count(old) == 1, 'plan head'
text = text.replace(old, new)
old = "| **语义未满足**：发送后首写前的外部修改会被当作基线恢复；单文件上限 8 MiB 非推荐 50 MiB；无内容寻址去重；真实 Windows 文件系统未验 |"
new = "| 单文件上限 50 MiB（基线/保护副本共享）；内容寻址去重与容量预算已实现（RA-07）；真实 Windows 文件系统未验 |"
assert text.count(old) == 1, 'plan BC-12 gap'
text = text.replace(old, new)
with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('plan updated')
