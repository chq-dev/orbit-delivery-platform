---
name: orbit-local-delivery
description: Run Orbit delivery work on the client machine against the configured local checkout. Use when the platform runs on a remote server and cannot access a developer's /Users or local workspace path, or when the user asks to execute the client path locally through a script or Codex skill.
---

# Orbit Local Delivery

The platform server stores work items and repository metadata, but code changes,
tests, commits and pushes must execute on the client that owns the checkout.

## Runner

From the Orbit project root:

```bash
npm run deliver:local -- \
  --api http://8.145.45.84:8787 \
  --work-item REQ-1137 \
  --repo repo-1 \
  --path /Users/chenhuaqu/sme/sme-main \
  --branch dev-harvey \
  --run \
  --push
```

The runner validates the absolute path, Git root, branch and origin, writes
`delivery-artifacts/<work-item>/codex-prompt.md`, then starts `codex exec` in the
client checkout. Add `--push` only when the user has authorized an external branch
write; non-interactive use also requires `--yes`. `--close` records a completed
local defect as closed and reuses the platform's Feishu close outbox.

## Required behavior

- Use `$rjcloud-local-delivery` for the RJ Cloud domain workflow and `$sdd` for the
  design, implementation, verification and review chain.
- Read the nearest `AGENTS.md` before editing `web/` or `lua/`.
- Produce real design, integration and test reports. Never fabricate results.
- Commit only after validation. Do not push unless the runner was invoked with
  `--push` and the user authorized the external write.
- Keep credentials and Feishu/Git tokens out of prompts, logs and reports.
