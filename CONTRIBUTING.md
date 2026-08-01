# Contributing

Throughline is a small, personal tool with strong opinions. Contributions are welcome, but the constraints below are load-bearing — they're what keep the thing changeable.

## Setup

There is nothing to install. Clone the repo and you have the tool:

```
git clone https://github.com/tgurgick/tl.git
cd tl
node bin/tl.js --help
```

**Supported Node: 22** — that's what CI runs, and it's the only version verified. Tests use the built-in `node:test` runner, so nearby versions will probably work, but 22 is the contract.

## The zero-dependency rule

`package.json` has no dependencies, and that's a feature, not an accident. The CLI, the worker lanes, and the UI server run on the Node standard library alone — no build step, no lockfile, no supply chain. **A PR that adds an npm dependency will be declined** unless it comes with a very good argument for why the stdlib can't do it.

## Checks

One command:

```
npm test
```

That runs the whole suite (`node --test test/*.test.js`). CI additionally runs `node --check` over `bin/*.js`, `lib/*.js`, and `ui/server.js`, and `git diff --check` for whitespace — see `.github/workflows/test.yml`. New behavior gets a test in `test/`; the existing files there are the style guide.

## Generated files

`AGENTS.md` and the other agent rule files are **generated** by `tl sync-rules` from `skills/*/SKILL.md` — don't edit them by hand. If you change a skill, run `node bin/tl.js sync-rules` and commit the regenerated output; `node bin/tl.js sync-rules --check` fails when they've drifted.

## How work flows

This repo eats its own dog food: changes usually start as a spec in a tl workspace, an agent (or human) carries the work through the tests gate to `in-review/`, and a human reviews it against the acceptance criteria before it lands in `done/` — an agent never signs off its own work. For an outside contribution you don't need any of that machinery: a plain PR with passing tests is fine. The frontmatter contract for workspace files is `_templates/SCHEMA.md`, and `AGENTS.md` has the full quickstart if you want to drive a spec the tl way.

## License

There is no license file yet. That's a deliberate open decision, not an oversight — please don't add one in a PR; it's a call for the repo owner to make.

## Security

Vulnerabilities go through the reporting path in [SECURITY.md](SECURITY.md), not public issues with exploit details.
