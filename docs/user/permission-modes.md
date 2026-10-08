# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. New installations start **Supervised**; existing
installations keep whatever default they already have, and existing threads and modes you choose
in a draft keep their permissions. You can change the default back to Full access at any time —
that choice is yours and Doer preserves it on every run.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Scheduled runs keep your choice

A reminder runs with its own task's saved mode — Doer never silently switches it to Full access.
When you create a reminder you choose between working without waiting (full access, best when
the run must finish while you are away) and waiting for approval each run (supervised). A
supervised run pauses for approval and shows as needing attention in Reminders. Scheduled runs
need this computer on with Doer running; a missed run starts once when Doer is back.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, and Cursor; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still require approval.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
