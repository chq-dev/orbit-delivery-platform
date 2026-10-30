import { codingSkills, codingSkillsSource } from './codingSkills'
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
    `Organization skills: ${codingSkillsSource.name} @ ${codingSkillsSource.ref} (${codingSkillsSource.url}).`,
    'Use $rjcloud-local-delivery for RJ Cloud domain rules and local safety. Use $sdd to orchestrate the delivery workflow.',
    `Follow the installed skill chain: ${codingSkills
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
