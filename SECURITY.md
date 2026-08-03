# 安全说明（Security Policy）

## 威胁模型

xharness 是一个**本地 YOLO 模式的 coding agent**：LLM 输出的工具调用（读写文件、执行
shell 命令）在你的机器上**直接执行，无确认、无沙箱、无命令黑名单**。这是有意的产品
设计，不是漏洞。使用即代表接受：

- 模型可能读写工作目录之外的文件、执行任意命令；
- 请只在可信任务与非关键目录使用，重要数据先做好版本控制/备份；
- GUI 的 API Key **必须手动填写**，**明文**保存在
  `~/Library/Application Support/xharness/xharness.db`（权限 600，防同机其他用户）；
  库文件被拷贝/备份即泄露（GUI 不读环境变量）。

## 支持版本

仅 `main` 分支最新代码。

## 漏洞报告

请通过 GitHub Issues（若涉及敏感细节请用 GitHub Security Advisories 私密报告）提交，
描述复现步骤与影响面。我们会尽快响应。
