---
name: orbit-local-delivery
description: Run Orbit delivery work on the client machine against the configured local checkout. Use when the platform runs on a remote server and cannot access a developer's /Users or local workspace path, or when the user asks to execute the client path locally through a script or Codex skill.
---

# Orbit Local Delivery

The platform server stores work items and repository metadata, but code changes,
tests, commits and pushes must execute on the client that owns the checkout.

## One-click from the Orbit page

Start and keep the local agent running:

```bash
npm run feishu:agent
```

In the delivery dialog choose `客户端本地` and click `一键本机执行`. The page calls
`POST http://127.0.0.1:18787/delivery/start` and polls
`GET /delivery/status/:id`. The request only contains the work-item ID, repository
ID and commit/push/close booleans. The agent fetches `/api/bootstrap`, resolves
`localPath` and `branch` from the repository configuration, then executes the
same runner below without sending a shell command through the browser.

The page origin must be listed in `FEISHU_AGENT_ALLOWED_ORIGINS`. Override the
agent URL in the web build with `VITE_FEISHU_AGENT_URL` only when the agent is not
listening on `http://127.0.0.1:18787`.

The agent exposes seven step states through `/delivery/status/:id`: platform,
contract, checkout, Codex, evidence, commit/push and platform write-back. Inspect
the failed step and its log instead of treating `fetch failed` as a Codex error.
Platform health/bootstrap reads retry transient network failures automatically.

Set `CODEX_BIN` to the absolute Codex executable when launchd/systemd does not
inherit the user's shell `PATH`. The agent health endpoint must show
`codex.available = true` before a delivery can start.

## Runner

Use this manual form only for diagnostics or when the page agent is unavailable.
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
- The runner fails when Codex changes no code or creates no local commit. Build,
  device-upgrade and test stages stay `pending` unless `build-report.md`/`build.log`,
  `upgrade-report.md`/`upgrade.log`, and `test-report.md` actually exist.
- The server rejects `POST /api/pipelines` and `/advance`; only
  `POST /api/pipelines/local` may record a client result.
- Commit only after validation. Do not push unless the runner was invoked with
  `--push` and the user authorized the external write.
- Keep credentials and Feishu/Git tokens out of prompts, logs and reports.
