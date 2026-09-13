# Computer use

Computer use lets an agent see your desktop and operate real apps on this
computer: testing an app it just built, driving a browser, reproducing a bug
that only happens on screen, or changing a setting that has no command line.
It works on macOS and Windows on a logged-in desktop; on Linux it needs a
logged-in graphical session and works best on straightforward desktop setups.

## Getting started

Computer use is on by default. The first time an agent needs it, Doer
installs a small pinned helper and checks system permissions. On macOS, grant
**Screen Recording** and **Accessibility** to Open Computer Use when prompted;
without them the agent can neither see nor click anything. On Windows, keep
the target app visible on the active desktop while the task runs.

When the agent notices your task involves a desktop app or something on
screen, it offers to use computer use and names the app it wants. Restart an
existing agent session after changing access settings so it picks them up.

## Approving apps

An agent may only operate apps you approve, one app at a time. When it needs a
new app, it asks you in chat; saying yes lets it record that approval, which
sticks until you revoke it. Ask the agent to forget an app, or turn off
**Agent computer access** in **Settings → Integrations**, to take approvals
away. Turning access off hides the
computer tools from agents started from then on.

Treat computer use like handing someone your mouse: keep tasks narrow, close
apps with sensitive content you do not need, and stay nearby for anything that
sends, deletes, buys, or uploads. On Windows the agent moves your real pointer
and types in the foreground, so hand the desktop over while it works and stop
the task before using the computer yourself. On macOS it normally works in the
background without moving your pointer.

## What it is good for

Choose computer use when the task depends on a graphical interface that files
and command output cannot show: checking the app you are building, stepping
through a browser or simulator flow, reproducing a GUI-only bug, or reading
something that lives only inside an app. For web pages you are building
locally, the shared browser comes first; for phone apps, the Device panel
comes first.
