/** 工作台快捷键定义（展示 + 注册共用一份，避免两处写歪）。
 *
 *  设计原则（item 11）：全部避开浏览器占用的组合——
 *  - 不使用 Ctrl/⌘ + 字母（多被浏览器占用：保存 / 查找 / 新标签页等）；
 *  - 触发类快捷键统一走 Alt + 键（Alt 组合极少与网页浏览冲突），并 preventDefault；
 *  - 仅在对话输入框内生效的 Enter / Shift+Enter 属编辑语义，不影响全局。
 */
export interface ShortcutItem {
  keys: string[]
  desc: string
}

export interface ShortcutGroup {
  group: string
  items: ShortcutItem[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    group: '问答管理',
    items: [
      { keys: ['Enter'], desc: '发送消息（输入框内）' },
      { keys: ['Shift', 'Enter'], desc: '换行（输入框内）' },
      { keys: ['Alt', 'I'], desc: '聚焦对话输入框' },
      { keys: ['Alt', '.'], desc: '停止当前运行（运行中）' },
    ],
  },
  {
    group: '会话管理',
    items: [
      { keys: ['Alt', 'N'], desc: '新建会话' },
    ],
  },
  {
    group: '界面导航（左栏 Tab 切换）',
    items: [
      { keys: ['Alt', '1'], desc: '需求' },
      { keys: ['Alt', '2'], desc: 'Files' },
      { keys: ['Alt', '3'], desc: '脚本' },
      { keys: ['Alt', '4'], desc: '用例' },
      { keys: ['Alt', '5'], desc: '归档' },
      { keys: ['Alt', '6'], desc: '帮助' },
      { keys: ['Alt', 'B'], desc: '收起 / 展开左栏' },
    ],
  },
]
