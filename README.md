# dsh-subagent-continue

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that lets an agent **continue a failed subagent inside that subagent's own session** instead of delegating the same task to a brand-new one.

## Why

DSH's `subagent` tool returns only a display name, and that name stays bound to the child that first took it. A Session id never reaches the model, so once a child settles there is no address for it and the only visible option is to start another child from scratch — losing the failed child's transcript, tool selection, and permissions. `send_message` also parks input on an idle child without waking it, so an addressed continuation can stop unnoticed.

This bundle adds the missing entry point.

## Tools

| Tool | Purpose |
|---|---|
| `subagent_status` | Lists the calling agent's whole subagent tree: Session id, full name, task label, activity (`running`/`inactive`), the turn each child is on, whether it ended, cumulative usage, and whether it can be resumed. Unreadable branches report `corrupt` / `unsupported` / `unavailable` and stay messageable. |
| `subagent_continue` | Sends a follow-up to one listed member by **Session id or name** through the subagent service, which cold-resumes an inactive child from its saved session, and then wakes a resident-but-idle child with the message the service already accepted. The same session continues with its transcript, tools, and permissions. Returns the accepted message id; later work arrives as the usual completion notice. |

## Automatic continuation

When a local child settles with anything other than `completed` or `aborted`, the bundle follows it up to `maxRetries` times (default `2`) and then stops, logging once that the budget is spent. The policy targets the delegating parent's own delegation depth (`0` by default) — the level where a replacement child would start from nothing.

## Configuration

Add these to the row in your profile's `cordis.patch.yml`:

```yaml
- id: subagent-continue
  config:
    maxRetries: 2         # automatic continuations per failed child; 0 disables them
    retryDepth: 0         # delegating parent's delegation depth to follow; default 0
    maxStatusRows: 200    # row cap for subagent_status
```

`recoveryAttempts` bounds how often one automatic continuation is retried after its own delivery failure (default `1`).

## Install

Install from this repository through DSH's plugin manager: **Plugins → Add plugin → install a Git package**, or from a shell:

```text
plugin_manager install_bundle target=git+https://github.com/qingxuan233/dsh-subagent-continue.git
```

The bundle is Host-only; it adds two tools and no UI. DSH `>= 0.2.2-rc.5` is required.

## Design notes

- **No external imports.** A profile bundle installed as a linked workspace directory resolves only the browser module table's packages, so official Harness packages are unavailable to its Host half. Tool definitions are plain objects with JSON Schema parameters, and delivery reuses the message the subagent service itself accepted.
- **Defensive activation.** `apply` never throws: a failure leaves one warning in the log instead of taking the profile boot down.
- **Bounded following.** Only deliveries this plugin sent are followed automatically, so an explicit `subagent_continue` is never duplicated.

## Verified

- `subagent_status` lists the whole tree with ids, labels, and activity.
- `subagent_continue` resumed the same child session across an app restart (`FIRST → SECOND → restart → THIRD` in one session id).
- An unknown name fails with a clear service error (`subagent "x" is unavailable`).

## License

MIT
