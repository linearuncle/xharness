# 侧栏会话预览折叠

## 标准冒烟
- 标题 xharness、侧栏/输入区/发送按钮存在、IPC bridge 就绪、CDP 标记正常

## 主成功路径
- 会话数 > 5 的项目默认只渲染前 5 条 `.sb-conv`
- 其后出现 `.sb-more`，文案为「展开显示」
- 点击后渲染全部会话，文案变为「收起」
- 再点「收起」回到预览 5 条

## 边界 / 回归
- 会话数 ≤ 5 的项目不出现 `.sb-more`
- 激活会话若在预览窗外，该项目自动展开
- 项目之间有更大的上边距（`.sb-project` margin-top: 14px）
- 会话行间距略增大（padding 8px / margin-top 3px）
- 数据目录：真实环境 `~/Library/Application Support/xharness`
