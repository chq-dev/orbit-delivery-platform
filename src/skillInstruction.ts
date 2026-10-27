import { codingSkills, codingSkillsSource } from './codingSkills'
import type { Repository, WorkItem } from './types'

export function buildLocalSkillInstruction(item: WorkItem, repository?: Repository) {
  const workItemType = item.type === 'requirement' ? 'requirement' : 'defect'
  const externalReference = item.externalId ? `Feishu external ID: ${item.externalId}` : ''
  return [
    `Use $rjcloud-local-delivery to deliver ${item.id} locally.`,
    '',
    `Project: ${repository?.name ?? 'sme-main'}`,
    `Repository: ${repository?.url ?? 'http://cloudgit.rj.link/sme/sme-main.git'}`,
    `Branch: ${item.branch}`,
    `Work item: ${item.title}`,
    `Type: ${workItemType}`,
    externalReference,
    `Description: ${item.description}`,
    'Domain: wireless router, AC/AP and switch device management (WLAN, VLAN/SVI, DHCP, PoE, firmware upgrade).',
    `Organization skills: ${codingSkillsSource.name} @ ${codingSkillsSource.ref} (${codingSkillsSource.url}).`,
    'Use $rjcloud-local-delivery for RJ Cloud domain rules and local safety. Use $sdd to orchestrate the delivery workflow.',
    `Follow the installed skill chain: ${codingSkills
      .filter((skill) => !['sdd', 'design-to-l1', 'design-to-l2'].includes(skill.id))
      .map((skill) => `$${skill.id}`)
      .join(' → ')}.`,
    'Use $design-to-l1 or $design-to-l2 only when architecture knowledge also needs normalization.',
    '',
    'Work only in the existing local sme-main checkout. For web/ changes read web/AGENTS.md first; for lua/ changes read lua/AGENTS.md and preserve the api -> service -> middle -> utils layering.',
    'Keep the whole workflow local. First analyze the requirement and produce a development design report covering requirement interpretation, affected modules, implementation plan, compatibility, and test strategy.',
    'Then implement the code changes and targeted unit tests according to that design.',
    'Run integration validation next: project-native type checks, Lua module tests, static analysis, firmware/web build checks, and the narrowest useful regression. Produce an integration report with actual results, compatibility findings, and remaining risks.',
    'Only after the design and integration reports exist, create a local commit linked to the work item. Do not push the branch automatically.',
    'Build the artifact, run the authorized AC/AP or switch firmware upgrade and automated tests, then archive the test report with real evidence.',
    'Store the design report, integration report, and test report under the project report directory (or delivery-artifacts/<work-item-id>/ if the project has no convention). Never fabricate report content or results.',
    'Do not open Git or Feishu web pages. Ask before any remote push, shared-branch change, production OTA, or other external write.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
}
