# Changelog

This project follows [Semantic Versioning](https://semver.org).

## 0.1.0 (2026-10-31)

First release.

- `dispatch_agent` starts several agents in one call, in the background, and delivers each report as a message.
- Live panel above the editor with time, tools, tokens and the current action of each agent.
- `/agents` to pick, open, message, continue and stop agents, with a live view of each conversation.
- `/goal` loop with an optional check command, a judge with a deadline, and a footer that always shows its state. It waits while agents run.
