import type { PlatformMeta } from './types'

export const platformLinks = {
  gitRepository: 'http://cloudgit.rj.link/sme/sme-main.git',
  feishuIssue: 'https://project.feishu.cn/rjcloud/issue/homepage',
  feishuStory: 'https://project.feishu.cn/rjcloud/story/homepage',
  ruijieBug: 'http://bugs.ruijie.com.cn/bug_switch/bug/main',
} as const

export const platformMeta: Record<string, PlatformMeta> = {
  git: {
    key: 'git',
    name: 'Git 代码仓库',
    description: 'GitLab / GitHub / Gitee',
    color: '#f97316',
    softColor: '#fff4e8',
    shortName: 'Git',
  },
  feishu: {
    key: 'feishu',
    name: '飞书协作',
    description: 'rjcloud · 需求与缺陷',
    color: '#3370ff',
    softColor: '#edf3ff',
    shortName: '飞书',
  },
  figma: {
    key: 'figma',
    name: 'Figma 设计',
    description: '设计稿、标注与切图',
    color: '#a259ff',
    softColor: '#f8f1ff',
    shortName: 'Figma',
  },
  build: {
    key: 'build',
    name: '编译系统',
    description: 'sm-web 与 RGOS 构建产物',
    color: '#8b5cf6',
    softColor: '#f4efff',
    shortName: '编译',
  },
  device: {
    key: 'device',
    name: '设备管理',
    description: 'AC/AP 与交换机固件升级',
    color: '#0f9f87',
    softColor: '#e9faf6',
    shortName: '设备',
  },
  ruijie: {
    key: 'ruijie',
    name: '锐捷 BUG',
    description: 'BUG 系统缺陷同步',
    color: '#d94a3a',
    softColor: '#fff0ed',
    shortName: '锐捷',
  },
}
