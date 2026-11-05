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
below. The browser never calls the local agent loopback address directly, so
Chrome Private Network Access restrictions do not apply.

The delivery command only contains the work-item ID, repository ID and
commit/push/close booleans. Requirement context (breakdown, design reference and
screenshots) is saved separately through
`PUT /api/work-items/:id/delivery-context` and re-read by the runner from
`GET /api/work-items/:id/delivery-context`. For requirement items at least one of
the following is mandatory: a requirement breakdown of 20+ characters, a design
reference, or 1-3 screenshots (max 500KB each, 1.2MB total). Defects are exempt.
The runner writes screenshots under `delivery-artifacts/<work-item>/requirement-assets/`
and passes every image to `codex exec --image`. The agent reports seven step states through
`POST /api/integrations/feishu/agent/commands/:id/progress`: connectivity
(platform + contract + checkout), requirement analysis, business LDD, business
coding, evidence, commit/push and platform write-back. At the start of each phase
Codex writes `delivery-artifacts/<work-item>/.phase-current` with
`analysis|ldd|coding` and prints the matching `LOCAL_DELIVERY_PHASE` marker. The
agent polls that marker and infers the phase from real workspace changes, so the
live step state can move even while `codex exec` buffers its output. Inspect the failed step and its log instead of treating
`fetch failed` as a Codex error. Platform health/bootstrap reads retry transient
network failures automatically.

Set `CODEX_BIN` to the absolute Codex executable when launchd/systemd does not
inherit the user's shell `PATH`. The agent health endpoint must show
`codex.available = true` before a delivery can start.

## Runner

Use this manual form only for diagnostics or when the page agent is unavailable.
From the Orbit project root:

```bash
npm run deliver:local -- \
  --api https://8.145.45.84:8787 \
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
- Commit stage follows the sme-main `/aicr-commit` contract (`$aicr-commit` when
  the Codex session exposes it). Read `.claude/skills-overlay/aicr-commit/SKILL.md`,
  `.claude/skills/aicr-workflow/SKILL.md` and
  `.claude/skills/aicr-pr/references/title-rules.md` before relying on it. The
  staged AICR review must report `approved: true` for the current diff; never
  commit secrets or `.env*`, and never use `--force` or an unauthorized amend.
- Use the shared AICR commit title format: `【缺陷修复】{id} {description}` for
  defects, `【需求实现】{id} {description}` for requirements, and an appropriate
  `【工程】` / `【AI】` / `【国际化】` / `【样式】` / `【重构】` / `【性能】` /
  `【文档】` / `【NA】` prefix when there is no work-item id.
- Mode-switch work uses the LDD at
  `web/docs/ldd/SME-模式切换-LDD.md`. Read it before design or coding and trace
  the frontend (`web/components/views/modeSwitch`), Lua module
  (`lua/luci/modules/mode_switch`), menu registration, confirmation and failure
  states described by the LDD.
- The coding Codex pass must not create, stage, amend, or push Git commits. After it
  exits, the runner starts a second Codex pass in the same checkout that executes
  `/aicr-commit` (staged AICR review + `.git/aicr-ai-review-latest.json` gate +
  AICR-compliant commit title) and never pushes; only an authorized runner `--push` writes the
  remote branch. The runner fails when Codex changes no non-Markdown source file,
  even if design or report documents were generated, and it fails instead of
  creating a commit when AICR review is missing, stale, or not `approved: true`.
  The commit pass must never stage `.env*`, secrets, `delivery-artifacts/**`, logs,
  build output, test files (`__tests__/**`, `*.test.*`, `*.spec.*`) or unrelated files.
  Tests may be executed as verification evidence but must remain uncommitted. Build,
  device-upgrade and test stages stay `pending` unless `build-report.md`/`build.log`,
  `upgrade-report.md`/`upgrade.log`, and `test-report.md` actually exist.
- The server rejects `POST /api/pipelines` and `/advance`; only
  `POST /api/pipelines/local` may record a client result.
- Every one-click run must leave a pipeline record. Successful runs, failed runs and
  runs that intentionally skip commit (`--no-commit`) all write to
  `POST /api/pipelines/local`; failures keep the actual failed stage and error instead of
  disappearing from the pipeline history.
- The runner commits only after validating real source changes and the design and
  integration reports. Do not push unless the runner was invoked with `--push`
  and the user authorized the external write.
- Delivery has independent budgets: coding Codex defaults to 150 minutes
  (`LOCAL_DELIVERY_CODEX_TIMEOUT_MS`), `/aicr-commit` defaults to 30 minutes
  (`LOCAL_DELIVERY_COMMIT_TIMEOUT_MS`), and the agent outer budget defaults to
  210 minutes (`FEISHU_AGENT_DELIVERY_TIMEOUT_MS`). The runner prints
  `LOCAL_DELIVERY_STAGE:codex|commit|push|writeback` markers and writes
  `codex.log` / `codex-commit.log` under `delivery-artifacts/<work-item>/` so a
  timeout is attributed to the real stage instead of the initial JSON output.
- Keep credentials and Feishu/Git tokens out of prompts, logs and reports.
- The local agent exposes the authoritative live job at `GET /status` (and
  `GET /delivery/status/<job-id>`). A job is still running only while
  `status=running` and `processAlive=true`; `running` with `processAlive=false`
  is a stale state that needs agent restart or cleanup. `POST /delivery/cancel`
  kills the local delivery process group; closing the delivery dialog only stops
  browser polling and must not be described as terminating the task.
