# dsh-subagent-continue

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件包：让智能体**在失败子智能体自己的会话里继续工作**，而不是把同样的任务重新交给一个全新的子智能体。

## 为什么需要它

DSH 的 `subagent` 工具只返回一个显示名，而这个名字会被第一个使用它的子智能体永久占用；SessionId 从不传到模型。于是子智能体一旦结束就没有可寻址的入口，模型眼前只剩"重新开一个"——失败子智能体的上下文、工具选择与权限全部丢失。另外 `send_message` 只是把消息放进空闲子智能体的收件箱、并不唤醒它，所以即使寻址正确也可能悄无声息地停住。

本插件补上这个缺口。

## 工具

| 工具 | 作用 |
|---|---|
| `subagent_status` | 列出调用方整棵子智能体树：SessionId、完整名字、任务标签、活动状态（`running`/`inactive`）、当前第几轮、该轮是否已结束、累计用量、是否可续接。读不动的分支报告 `corrupt`/`unsupported`/`unavailable`，但仍可发消息。 |
| `subagent_continue` | 按 **SessionId 或名字**向列表中的某个成员发送后续消息：经子智能体服务冷恢复离线子会话，再唤醒"驻留但空闲"的子智能体（用它自己已接收的那条消息）。同一个会话带着它的历史、工具与权限继续。返回被接受的消息 id；后续工作照常以完成通知回来。 |

## 自动接续

本地子智能体以 `completed`/`aborted` 之外的原因结束时，插件会自动接续至多 `maxRetries` 次（默认 `2`），用尽后停止并记录一条日志。策略针对**委派方自身的委派深度**（默认 `0`）——也就是"重新开一个就是从零开始"的那一层。

## 配置

在你的 profile `cordis.patch.yml` 中给该行加配置：

```yaml
- id: subagent-continue
  config:
    maxRetries: 2         # 每个失败子智能体的自动接续次数；0 表示关闭
    retryDepth: 0         # 要接续的委派方深度；默认 0
    maxStatusRows: 200    # subagent_status 的行数上限
```

`recoveryAttempts` 控制单次自动接续自身投递失败后的重试次数（默认 `1`）。

## 安装

通过 DSH 的插件管理安装：**插件 → 添加插件 → 安装 Git 包**，或命令行：

```text
plugin_manager install_bundle target=git+https://github.com/qingxuan233/dsh-subagent-continue.git
```

纯 Host 插件，只增两个工具、不含任何界面。要求 DSH `>= 0.2.2-rc.5`。

## 设计说明

- **零外部依赖**：以软链接方式安装的 profile 包只能解析浏览器模块表里的包，官方 Harness 包对它的 Host 半不可用。因此工具定义是纯对象 + JSON Schema 参数，投递复用子智能体服务自己已接收的那条消息。
- **防御式激活**：`apply` 绝不抛错——失败只在日志留一条警告，不会拖垮 profile 启动。
- **有界接续**：只自动接续本插件自己发出的投递，显式的 `subagent_continue` 不会被重复。

## 已验证

- `subagent_status` 能列出整棵树的 id、标签与活动状态。
- `subagent_continue` 在同一条会话里跨越应用重启续接（`FIRST → SECOND → 重启 → THIRD`，SessionId 不变）。
- 不存在的名字给出清晰报错（`subagent "x" is unavailable`）。

## 许可证

MIT
