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

In the delivery dialog choose `客户端本地` and click `一键本机执行`. The page posts a
`delivery_start` command to the same-origin platform API. The local agent claims
that command on its next heartbeat, fetches `/api/bootstrap`, resolves `localPath`
and `branch` from the repository configuration, and executes the same runner
below. The browser never calls `http://127.0.0.1`, so HTTP deployments are not
blocked by Chrome Private Network Access.

The delivery command only contains the work-item ID, repository ID and
commit/push/close booleans. Requirement context (breakdown, design reference and
screenshots) is saved separately through
`PUT /api/work-items/:id/delivery-context` and re-read by the runner from
`GET /api/work-items/:id/delivery-context`. For requirement items at least one of
the following is mandatory: a requirement breakdown of 20+ characters, a design
reference, or 1-3 screenshots (max 500KB each, 1.2MB total). Defects are exempt.
The runner writes screenshots under `delivery-artifacts/<work-item>/requirement-assets/`
and passes every image to `codex exec --image`. The agent reports seven step states through
`POST /api/integrations/feishu/agent/commands/:id/progress`: platform, contract,
checkout, Codex, evidence, commit/push and platform write-back. Inspect the failed
step and its log instead of treating `fetch failed` as a Codex error. Platform
health/bootstrap reads retry transient network failures automatically.

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

- Use `$rjcloud-local-delivery` for RJ Cloud domain and local safety. Follow the
  official SME stage chain from the 天枢 Forge manual
  (https://ruijie.feishu.cn/wiki/Z6yYwTkJfiteT0k5vKHcbtPFnad, baseline 2026-10-29):
  `clarify-requirements → tech-design + case-design → implementation + Web/Lua
  specialties → integration-test → e2e-test → aicr-workflow → aicr-commit/aicr-pr`.
  `$sdd` is only an optional local orchestrator when installed; the stage chain above
  is authoritative.
- Select SME Web specialties from `developer`, `frontend-*`, module federation,
  `echarts`, `menu-module-registration`, `platform-ifdef`, `i18n-usage`,
  `theme-management` and `timezone-format`. Use `lua-module-dev` for LuCI four-layer
  work. SME local entries are `i18n-playwright-mcp-screenshot`,
  `performance-optimization`, `rule-management-lua`,
  `sensitive-keyword-management` and `switch-lua-debug-deploy`.
- If a named organization skill is unavailable in this Codex session, follow its
  stage contract manually and do not claim the skill ran. Design references and
  screenshots are inputs, never acceptance evidence.
- When the Codex session exposes the `feishu` MCP server, use it to read linked
  Feishu documents, Wiki pages, screenshots or messages needed by the work item.
  Meegle work items remain platform-provided and authoritative. MCP output is
  supporting input, not evidence that code, tests or delivery succeeded.
- When the `meegle` MCP server is available, use it for live requirement or defect
  detail lookup when the platform context is incomplete. Do not treat MCP reads as
  acceptance evidence, and do not use write operations without explicit approval.
- Read the nearest `AGENTS.md` before editing `web/` or `lua/`.
- Produce real design, integration and test reports. Never fabricate results.
- Codex must not create, stage, amend, or push Git commits; the runner owns commit
  creation after Codex exits. The runner fails when Codex changes no non-Markdown
  source file, even if design or report documents were generated. Build,
  device-upgrade and test stages stay `pending` unless `build-report.md`/`build.log`,
  `upgrade-report.md`/`upgrade.log`, and `test-report.md` actually exist.
- The server rejects `POST /api/pipelines` and `/advance`; only
  `POST /api/pipelines/local` may record a client result.
- The runner commits only after validating real source changes and the design and
  integration reports. Do not push unless the runner was invoked with `--push`
  and the user authorized the external write.
- Keep credentials and Feishu/Git tokens out of prompts, logs and reports.
