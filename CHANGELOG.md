# Changelog

This project follows [Semantic Versioning](https://semver.org).

## 0.1.0 (2026-10-31)

First release.

- `dispatch_agent` starts several agents in one call, in the background, and delivers each report as a message.
- Live panel above the editor with time, tools, tokens and the current action of each agent.
- `/agents` to pick, open, message, continue and stop agents, with a live view of each conversation.
- `/goal` loop with an optional check command, a judge with a deadline, and a footer that always shows its state. It waits while agents run.

## 0.1.1 (2026-10-31)

- Fixed `/agents stop all`, `/agents open <name>` and similar needing Enter twice: the suggestion list no longer stays open once a word is complete.
- Fixed `/goal stop` being ignored when it arrived during an evaluation.
- `Esc` and `/goal stop` now cancel a running evaluation, including the check command.
- A goal restored by reopening a session now says it is idle instead of "working".
- The report tells the main agent what you sent to a subagent, so a changed plan doesn't read as a disobedient agent.
