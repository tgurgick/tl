# Canonical E2E fixtures

Static seeds for `test/canonical-e2e.test.js`. Runtime copies land in `mkdtemp`
workspaces with a real `git init` repo. Fake bins never talk to the network and
are not invoked for paid agent work — the suite injects `which` / `runVerify` /
lease APIs for determinism.

Optional dogfood (paid agents, real workspace): see
`docs/canonical-e2e-path.md` § Optional dogfood validation.
