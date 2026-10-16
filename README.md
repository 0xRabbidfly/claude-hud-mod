# claude-hud-mod

Claude Code plugins, published as one plugin marketplace.

## Install

You need Claude Code 2.1.289 or later.

```
/plugin marketplace add 0xRabbidfly/claude-hud-mod
/plugin install session-hud@claude-hud-mod
```

To pick up a new version: `claude plugin marketplace update claude-hud-mod`, then
`claude plugin update session-hud@claude-hud-mod`, then `/reload-plugins`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [session-hud](plugins/session-hud) | Sidebar with workspace, git changes, model and effort, a context ring, rate-limit usage, a tool-call flight log and a process list |

## Adding a plugin

Put it under `plugins/<name>/`, add an entry to `.claude-plugin/marketplace.json`, and run
`claude plugin validate plugins/<name>`, `claude plugin validate .` and, where it has
tests, `claude plugin test plugins/<name>` before opening a pull request. Bump `version`
in both manifests on every release: installed copies update only when it changes.

## License

[MIT](LICENSE)
