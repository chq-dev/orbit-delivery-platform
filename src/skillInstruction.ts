import {
  codingSkills,
  codingSkillsSource,
  organizationSkillManual,
  smeDeliveryStageChain,
  smeSkillSpecialties,
} from './codingSkills'
import type { Repository, WorkItem } from './types'

export interface LocalSkillDeliveryContext {
  requirementBreakdown?: string
  designReference?: string
  screenshotPaths?: string[]
}

export function buildLocalSkillInstruction(
  item: WorkItem,
  repository?: Repository,
  deliveryContext: LocalSkillDeliveryContext = {},
) {
  const workItemType = item.type === 'requirement' ? 'requirement' : 'defect'
  const externalReference = item.externalId ? `Feishu external ID: ${item.externalId}` : ''
  const requirementBreakdown =
    deliveryContext.requirementBreakdown?.trim() || item.requirementBreakdown?.trim() || ''
  const designReference =
    deliveryContext.designReference?.trim() || item.designReference?.trim() || ''
  const screenshotPaths = (deliveryContext.screenshotPaths ?? []).filter(Boolean)
  return [
    `Use $rjcloud-local-delivery to deliver ${item.id} locally.`,
    '',
    `Project: ${repository?.name ?? 'sme-main'}`,
    `Repository: ${repository?.url ?? 'http://cloudgit.rj.link/sme/sme-main.git'}`,
    `Local checkout: ${repository?.localPath || 'configure in repository settings'}`,
    `Branch: ${item.branch}`,
    `Work item: ${item.title}`,
    `Type: ${workItemType}`,
    externalReference,
    `Description: ${item.description}`,
    requirementBreakdown ? `Requirement breakdown:\n${requirementBreakdown}` : '',
    requirementBreakdown
      ? 'Treat the requirement breakdown as the operator-confirmed delivery scope. Derive acceptance criteria and the affected-module plan from it before editing code.'
      : '',
    designReference ? `Design reference: ${designReference}` : '',
    designReference
      ? 'Treat the design reference as the primary design input when it is readable. If it is a local file or directory, read it before writing the design report; do not ignore it or fabricate missing design content.'
      : '',
    screenshotPaths.length > 0
      ? `Design screenshot files:\n${screenshotPaths.map((path) => `- ${path}`).join('\n')}`
      : '',
    screenshotPaths.length > 0
      ? 'The design screenshots are attached to this Codex run. Inspect every screenshot before planning or editing, and trace the implemented UI/behavior back to the visible requirements.'
      : '',
    'Domain: wireless router, AC/AP and switch device management (WLAN, VLAN/SVI, DHCP, PoE, firmware upgrade).',
    `SME skill manual: ${organizationSkillManual.name} (${organizationSkillManual.url}); baseline ${organizationSkillManual.baseline}.`,
    `Authoritative SME stage chain: ${smeDeliveryStageChain.map((entry) => `${entry.stage}=${entry.entry}`).join(' → ')}.`,
    `Stage handoffs: ${smeDeliveryStageChain.map((entry) => `${entry.stage}=${entry.artifact}`).join('; ')}.`,
    'Use the stage entry that matches this work item. Do not skip the requirement card, design/case, implementation self-check, integration evidence, independent E2E evidence, or AICR review.',
    'If a named organization skill is unavailable in the current Codex session, follow that stage contract manually and never claim the skill ran.',
    `SME Web specialties (select only what the task needs): ${smeSkillSpecialties.web.join(', ')}.`,
    `SME Lua specialty: ${smeSkillSpecialties.lua.join(', ')}. SME local entries: ${smeSkillSpecialties.local.join(', ')}.`,
    'Design references and screenshots are implementation inputs, never acceptance evidence. Acceptance requires executed tests or other observed evidence.',
    'If the Codex session exposes a Feishu MCP server named "feishu", use it to read linked Feishu documents, Wiki pages, screenshots or messages needed for the requirement. Meegle work items remain platform-provided and authoritative; MCP output is supporting input, not acceptance evidence.',
    'If the Codex session exposes a Meegle MCP server named "meegle", use it for live requirement or defect detail lookup when the platform context is incomplete. The platform-provided work item remains authoritative for delivery scope; Meegle MCP output is not acceptance evidence.',
    `Organization skills: ${codingSkillsSource.name} @ ${codingSkillsSource.ref} (${codingSkillsSource.url}).`,
    'Use $rjcloud-local-delivery for RJ Cloud domain rules and local safety. $sdd is only an optional local orchestrator; the SME stage chain above is authoritative.',
    `Currently installed local skill chain: ${codingSkills
      .filter((skill) => !['sdd', 'design-to-l1', 'design-to-l2'].includes(skill.id))
      .map((skill) => `$${skill.id}`)
      .join(' → ')}.`,
    'Use $design-to-l1 or $design-to-l2 only when architecture knowledge also needs normalization.',
    '',
    'Work only in the configured local checkout. For web/ changes read web/AGENTS.md first; for lua/ changes read lua/AGENTS.md and preserve the api -> service -> middle -> utils layering.',
    'Keep the whole workflow local. First analyze the requirement and produce a development design report covering requirement interpretation, affected modules, implementation plan, compatibility, and test strategy.',
    'Then implement the code changes and targeted unit tests according to that design.',
    'Run integration validation next: project-native type checks, Lua module tests, static analysis, firmware/web build checks, and the narrowest useful regression. Produce an integration report with actual results, compatibility findings, and remaining risks.',
    'Do not create, stage, amend, or push Git commits. Leave validated code changes in the working tree; the local delivery runner creates the work-item commit after checking the reports and real code changes.',
    'Build the artifact, run the authorized AC/AP or switch firmware upgrade and automated tests, then archive the test report with real evidence.',
    'Store the design report, integration report, and test report under the project report directory (or delivery-artifacts/<work-item-id>/ if the project has no convention). Never fabricate report content or results.',
    'Do not open Git or Feishu web pages. Ask before a shared-branch change, production OTA, or any external write other than the configured acceptance push.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
}
