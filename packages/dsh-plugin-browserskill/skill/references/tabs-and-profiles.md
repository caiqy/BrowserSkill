## Connected browsers and named sessions

```text
bsk_session({ action: "browsers" })
bsk_session({ action: "list" })
```

`browsers` queries connected official browser instances without creating a session
or changing selection. It returns only information actually supplied by the daemon
(such as IDs, names, labels, versions, availability and session counts). An empty
list means no connected instances were returned; a daemon/query error is a failure.
`list` still reports only plugin-owned sessions and pending cleanup, not all daemon
sessions. A connected instance alone does not prove which user profile it represents.

After verifying the required mapping, an optional task `name` labels a new session:

```text
bsk_session({ action: "start", browser: "<verified-instance-id>", name: "Check account layout" })
```

Names do not replace returned session IDs or ownership. Named starts use the same
tracked start journal, recovery and failure cleanup as ordinary starts. If a reply
is lost, inspect owned sessions/pending cleanup before repeating a start.

## Required browser profiles

If the user or workspace requires a specific profile, confirm its instance ID before
starting, even with only one connected browser. If unknown, ask the user to open the
intended profile, check **Profile Path** at `chrome://version` if a directory was
specified, and copy the **Instance ID** or **Copy profile instructions** from the
connected BrowserSkill popup in that same profile. Connected alone and Chrome's
process arguments do not prove the profile.

Use the verified ID (or verified unique BrowserSkill label) on every new session:

```text
bsk_session({ action: "start", browser: "<verified-instance-id>" })
```

For copied command-line examples, use the instance ID in
this tool call, without running the command. A Chrome profile name, directory,
or extension ID is not an instance ID. If the mapping is unclear/ambiguous or the
target unavailable, stop and ask the user to confirm/reconnect. Never omit
`browser` or substitute another instance to recover.

## Borrowing and settings

Use `bsk_tabs` to list IDs before acting. Borrow for the immediate step and
return promptly. Browser Automation settings
govern confirmation and help; never change them to bypass a prompt or repeat
pending/denied/expired borrows. Inspect unknown outcomes; follow version-error hints.
Remote reads/actions require task-created or borrowed tabs; popups gain no control.
An unowned tab inside the Agent Window needs a user move to a user window before borrowing.
