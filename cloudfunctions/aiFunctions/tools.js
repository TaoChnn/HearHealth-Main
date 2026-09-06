// Agent 工具集（Function Calling）
//
// 分层原则：
//   - 只读工具（get_*）：模型可自主调用，直接返回档案明细，不需要用户确认
//   - 写入工具（requiresConfirm）：模型只能「提议」。云函数中断循环，把待确认动作返回前端，
//     用户点确认后再执行一次真正落库，并连同撤销所需的信息一起返回
//
// 写入工具的执行入参来自客户端回传，因此每个工具都必须在执行前重新校验参数：
// 参数空间被限制在枚举 / 定长文本 / 白名单数值内，且写操作一律按调用方 OPENID 收敛，
// 用户即便篡改参数也只能改自己的档案。
const {
  NOTE_TYPES,
  NOTE_TYPE_LABELS,
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  REMINDER_THRESHOLDS,
  FREQUENCIES,
  formatDateText
} = require('./archive')

function thresholdText(value) {
  return Number.isFinite(value) ? `${value}%` : '未测得'
}

function formatEarLine(map) {
  const source = map && typeof map === 'object' ? map : {}
  return FREQUENCIES.map(frequency => `${frequency}:${thresholdText(source[frequency])}`).join(' ')
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 模型偶尔会把参数包成 JSON 字符串，这里统一解析；解析失败回退为空对象由各工具自行兜底
function normalizeArgs(rawArgs) {
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs)
      return isPlainObject(parsed) ? parsed : {}
    } catch (error) {
      return {}
    }
  }
  return isPlainObject(rawArgs) ? rawArgs : {}
}

// run 统一返回 { text, undo }：text 是喂回模型的执行结果，undo 供前端「撤销」使用
const TOOLS = [
  {
    name: 'get_hearing_trend',
    title: '查看听力趋势',
    requiresConfirm: false,
    definition: {
      type: 'function',
      function: {
        name: 'get_hearing_trend',
        description: '读取用户全部听力测试记录的逐频点明细，以及最近两次测试之间的变化。用户问「有没有好转或变差」「哪个频率有问题」「和上次比怎么样」时调用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    async run({ archive }) {
      if (!archive.tests.length) {
        return { text: '用户还没有任何听力测试记录。不要编造结果，可以引导用户先做一次测试。' }
      }

      const lines = [
        `最近 ${archive.tests.length} 次测试（时间从早到晚）。数值是相对音量阈值，越高代表需要越大音量才能听到，也就越不理想：`
      ]
      archive.tests.forEach(item => {
        lines.push(`${formatDateText(item.completedAt)} 左耳 ${formatEarLine(item.left)}｜右耳 ${formatEarLine(item.right)}`)
      })

      const trend = archive.trend
      if (trend && trend.changes.length) {
        lines.push('最近一次与上一次的差值（正值为需要更大音量，表现下降；负值为表现改善）：')
        trend.changes.forEach(change => {
          const parts = []
          if (Number.isFinite(change.leftDelta)) parts.push(`左耳 ${signed(change.leftDelta)}`)
          if (Number.isFinite(change.rightDelta)) parts.push(`右耳 ${signed(change.rightDelta)}`)
          lines.push(`${change.frequency}Hz ${parts.join('，')}`)
        })
      } else {
        lines.push('目前只有一次测试记录，没有可对比的历史，不能判断趋势。')
      }

      lines.push('提醒：这些数值不是 dB HL，也不能换算成听损等级，只能作为同一条件下的相对变化参考。')
      return { text: lines.join('\n') }
    }
  },
  {
    name: 'get_usage_summary',
    title: '查看用耳行为',
    requiresConfirm: false,
    definition: {
      type: 'function',
      function: {
        name: 'get_usage_summary',
        description: '读取用户近 7 天或近 30 天的用耳时长与耳机音量汇总。用户问「我最近用耳多不多」「音量是不是太大」「有没有超标」时调用。',
        parameters: {
          type: 'object',
          properties: {
            days: { type: 'integer', description: '统计天数，只能是 7 或 30，默认 7' }
          }
        }
      }
    },
    async run({ archive }, rawArgs) {
      const args = normalizeArgs(rawArgs)
      const days = Number(args.days) === 30 ? 30 : 7
      const summary = days === 30 ? archive.usage.monthly : archive.usage.weekly
      const parts = [
        `近 ${days} 天日均用耳 ${summary.avgHours} 小时`,
        `提醒阈值 ${summary.thresholdHours} 小时`,
        `风险状态 ${summary.status}`
      ]
      if (Number.isFinite(summary.avgVolume)) parts.push(`耳机平均音量约 ${summary.avgVolume} 分贝`)
      if (Number.isFinite(summary.maxVolume)) parts.push(`最高约 ${summary.maxVolume} 分贝`)
      return {
        text: `${parts.join('，')}。统计口径是小程序前台停留时长，只作为用耳习惯的粗略参考。`
      }
    }
  },
  {
    name: 'get_health_notes',
    title: '查看健康日志',
    requiresConfirm: false,
    definition: {
      type: 'function',
      function: {
        name: 'get_health_notes',
        description: '读取用户自己或 AI 记下的健康日志（症状、用药、就医、习惯、备注）。用户问「我之前记过什么」「我的耳鸣记录」时调用。',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: NOTE_TYPES, description: '按类型过滤：symptom 症状 / medication 用药 / visit 就医 / habit 习惯 / note 备注' }
          }
        }
      }
    },
    async run({ archive }, rawArgs) {
      const args = normalizeArgs(rawArgs)
      const type = NOTE_TYPES.includes(args.type) ? args.type : ''
      const list = type ? archive.notes.filter(item => item.type === type) : archive.notes
      if (!list.length) {
        return {
          text: type
            ? `还没有${NOTE_TYPE_LABELS[type]}类的记录。`
            : '健康日志还是空的，可以建议用户把症状和就医情况记下来，方便以后对比。'
        }
      }
      return {
        text: list.map((item, index) => (
          `${index + 1}. ${item.occurredAtText}［${item.typeLabel}］${item.content}（${item.source === 'agent' ? 'AI 记录' : '用户记录'}）`
        )).join('\n')
      }
    }
  },
  {
    name: 'get_health_profile',
    title: '查看档案概况',
    requiresConfirm: false,
    definition: {
      type: 'function',
      function: {
        name: 'get_health_profile',
        description: '读取档案的基本概况：耳机型号、提醒阈值、测试次数、档案完整度与缺失项。用户问「我的档案怎么样」「还缺什么」时调用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    async run({ archive }) {
      const profile = archive.profile
      const lines = [
        `常用耳机：${profile.deviceModel || '未填写'}`,
        `每日用耳提醒阈值：${profile.reminderThreshold} 小时`,
        `累计听力测试：${profile.testCount} 次`,
        `档案完整度：${archive.completeness.percent}%`
      ]
      if (archive.completeness.missing.length) {
        lines.push(`还缺：${archive.completeness.missing.join('、')}`)
      }
      return { text: lines.join('\n') }
    }
  },
  {
    name: 'add_health_note',
    title: '记录到健康日志',
    requiresConfirm: true,
    definition: {
      type: 'function',
      function: {
        name: 'add_health_note',
        description: '把用户明确说出的症状、用药、就医或用耳习惯记入健康档案。只在用户确实陈述了事实、且值得长期留存时调用；不要替用户推测或补充没说过的内容，也不要记录能从测试数据直接算出的内容。',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: NOTE_TYPES, description: 'symptom 症状 / medication 用药 / visit 就医 / habit 习惯 / note 其他备注' },
            content: { type: 'string', description: '一句话记录，不超过 60 字，用用户自己的话，不加推测和诊断' },
            occurredAt: { type: 'integer', description: '事件发生时间的毫秒时间戳；用户没说具体时间时省略' }
          },
          required: ['type', 'content']
        }
      }
    },
    preview(args) {
      return `［${NOTE_TYPE_LABELS[args.type] || '备注'}］${args.content}`
    },
    async run({ store, openid }, rawArgs) {
      const args = normalizeArgs(rawArgs)
      const note = await store.addNote(openid, {
        type: args.type,
        content: args.content,
        occurredAt: args.occurredAt,
        source: 'agent'
      })
      return {
        text: `已写入健康日志：${formatDateText(note.occurredAt)}［${note.typeLabel}］${note.content}`,
        undo: { type: 'removeNote', id: note.id }
      }
    }
  },
  {
    name: 'save_agent_memory',
    title: '记住这件事',
    requiresConfirm: true,
    definition: {
      type: 'function',
      function: {
        name: 'save_agent_memory',
        description: '把对话中确认下来的长期事实或待办事项记进档案，供以后的对话使用。只记用户明确说出、且对后续建议确实有用的信息，例如通勤方式、工作环境、复测计划。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: MEMORY_KINDS, description: 'fact 长期情况；todo 待办事项' },
            content: { type: 'string', description: '一句话，不超过 40 字' }
          },
          required: ['kind', 'content']
        }
      }
    },
    preview(args) {
      return `［${MEMORY_KIND_LABELS[args.kind] || '长期情况'}］${args.content}`
    },
    async run({ store, openid }, rawArgs) {
      const args = normalizeArgs(rawArgs)
      const memory = await store.addMemory(openid, { kind: args.kind, content: args.content })
      return {
        text: `已记住：［${memory.kindLabel}］${memory.content}`,
        undo: { type: 'removeMemory', id: memory.id }
      }
    }
  },
  {
    name: 'update_reminder_setting',
    title: '修改提醒设置',
    requiresConfirm: true,
    definition: {
      type: 'function',
      function: {
        name: 'update_reminder_setting',
        description: '修改每日用耳时长的提醒阈值。只有用户明确提出要修改时才调用，不要主动建议修改。',
        parameters: {
          type: 'object',
          properties: {
            reminderThreshold: { type: 'integer', enum: REMINDER_THRESHOLDS, description: '每日用耳提醒阈值，单位小时，只能是 1、2、3 或 4' }
          },
          required: ['reminderThreshold']
        }
      }
    },
    preview(args) {
      return `${args.reminderThreshold} 小时`
    },
    async run({ store, openid, previousThreshold }, rawArgs) {
      const args = normalizeArgs(rawArgs)
      const result = await store.updateReminderThreshold(openid, args.reminderThreshold)
      return {
        text: `已把每日用耳提醒阈值改为 ${result.reminderThreshold} 小时`,
        undo: { type: 'restoreThreshold', previousThreshold }
      }
    }
  }
]

function listToolDefinitions() {
  return TOOLS.map(tool => tool.definition)
}

function findTool(name) {
  return TOOLS.find(tool => tool.name === name) || null
}

// 写入工具在落库前必须再校验一次参数：客户端回传的数据一律不可信
function validateWriteArgs(name, rawArgs) {
  const args = normalizeArgs(rawArgs)
  if (name === 'add_health_note') {
    if (!NOTE_TYPES.includes(args.type)) return null
    if (typeof args.content !== 'string' || !args.content.trim()) return null
    return { type: args.type, content: args.content, occurredAt: args.occurredAt }
  }
  if (name === 'save_agent_memory') {
    if (!MEMORY_KINDS.includes(args.kind)) return null
    if (typeof args.content !== 'string' || !args.content.trim()) return null
    return { kind: args.kind, content: args.content }
  }
  if (name === 'update_reminder_setting') {
    const value = Number(args.reminderThreshold)
    if (!REMINDER_THRESHOLDS.includes(value)) return null
    return { reminderThreshold: value }
  }
  return null
}

// 待确认动作的卡片文案：只说明将要发生什么，不暴露参数结构与内部标识
function describePendingAction(name, rawArgs) {
  const tool = findTool(name)
  if (!tool) return null
  const args = validateWriteArgs(name, rawArgs)
  if (!args) return null
  return {
    name,
    title: tool.title,
    summary: tool.preview(args),
    args
  }
}

module.exports = {
  TOOLS,
  listToolDefinitions,
  findTool,
  validateWriteArgs,
  describePendingAction,
  normalizeArgs
}
