# Contributing

## Setup

You need Node 24 or newer and pnpm.

```bash
pnpm install
pnpm check   # typecheck, lint and tests
```

To try your changes in pi, without your installed copy getting in the way:

```bash
pi --no-extensions -e .
```

Add `-e <path to the provider extension>` if your model comes from one, such as pi-claude-bridge.

## Layout

| Path          | Contents                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------- |
| `extensions/` | The two entry points pi loads: tools, commands and UI wiring                             |
| `src/`        | Logic that doesn't need a running pi: the agent runner, parsers and the live view        |
| `test/`       | Tests. `test/fixtures/fake-pi.mjs` stands in for `pi --mode rpc` as a real child process |

## Pull requests

- Keep logic in `src/` with a test, and keep `extensions/` thin.
- A bug in the child process boundary gets a test against `fake-pi.mjs`, not a mock.
- For UI changes, run it in a real pi session and include a screenshot.
- Add a line to `CHANGELOG.md` for anything a user would notice.
