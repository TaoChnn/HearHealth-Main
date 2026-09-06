// 健康档案数据层（aiFunctions 侧）
//
// 微信云函数按目录独立部署，aiFunctions 与 userFunctions 无法共享本地模块，
// 因此这里维护一份 Agent 专用的档案读写实现。字段规则与 userFunctions 中的
// 同名集合保持一致，改动其中一处需同步另一处。
//
// 档案由四类数据构成（对应「Agent 能写的，用户必须能看见」这条判据）：
//   1. 听力测试记录 test_records  —— 只读，已有资产，档案的骨架
//   2. 用耳行为   usage_records  —— 只读，风险的来源
//   3. 健康日志   health_notes   —— 读写，用户自述的症状/用药/就医/习惯
//   4. AI 记忆    agent_memory   —— 读写，Agent 从对话里提取的长期事实，用户可逐条删
//
// 日期口径：云函数运行环境的系统时区不保证与用户所在时区一致，
// 这里固定按 UTC+8 生成日期键，与小程序端 usage-tracker 的按天口径对齐。
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const HEALTH_NOTES = 'health_notes'
const AGENT_MEMORY = 'agent_memory'
const TEST_COLLECTION = 'test_records'
const USAGE_COLLECTION = 'usage_records'
const USERS_COLLECTION = 'users'

const FREQUENCIES = [125, 250, 500, 1000, 2000, 4000]

const NOTE_TYPES = ['symptom', 'medication', 'visit', 'habit', 'note']
const NOTE_TYPE_LABELS = {
  symptom: '症状',
  medication: '用药',
  visit: '就医',
  habit: '习惯',
  note: '备注'
}
const MEMORY_KINDS = ['fact', 'todo']
const MEMORY_KIND_LABELS = {
  fact: '长期情况',
  todo: '待办'
}

const MAX_NOTE_LENGTH = 200
const MAX_MEMORY_LENGTH = 160
const REMINDER_THRESHOLDS = [1, 2, 3, 4]
const DEFAULT_REMINDER_THRESHOLD = 2

const ARCHIVE_WINDOW_DAYS = 30
const MAX_TESTS = 10
const MAX_NOTES = 20
const MAX_MEMORY = 20
const SNAPSHOT_NOTE_LIMIT = 5
const SNAPSHOT_MEMORY_LIMIT = 5
// 判定「明显变化」的阈值差（百分点）：低于此值视为正常波动，不写进快照
const NOTABLE_DELTA = 15
// 风险口径与小程序端 utils/usage-risk.js 保持一致：达到阈值时长时进度为 70%
const WARNING_PROGRESS = 70
const DANGER_PROGRESS = 90

function pad2(value) {
  return value < 10 ? `0${value}` : `${value}`
}

function dateKeyOf(timestamp) {
  const date = new Date(Number(timestamp) + TZ_OFFSET_MS)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (value && typeof value.getTime === 'function') return value.getTime()
  const time = new Date(value || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function formatDateText(value) {
  const timestamp = toTimestamp(value)
  if (!timestamp) return '时间未知'
  const date = new Date(timestamp + TZ_OFFSET_MS)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(100, Math.max(0, Math.round(number)))
}

// 单耳各频点的相对音量阈值：测得为数值，未测得为 null
function earThresholdMap(list) {
  const map = {}
  ;(Array.isArray(list) ? list : []).forEach(item => {
    if (!item || !Number.isFinite(Number(item.frequency))) return
    const frequency = Number(item.frequency)
    const measured = Boolean(item.detected) && Number.isFinite(Number(item.thresholdPercent))
    map[frequency] = measured ? clampPercent(item.thresholdPercent) : null
  })
  return map
}

function earAverage(map) {
  const values = Object.keys(map)
    .map(key => map[key])
    .filter(value => Number.isFinite(value))
  if (!values.length) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function earDetectedCount(map) {
  return Object.keys(map).filter(key => Number.isFinite(map[key])).length
}

// 趋势：只对比最近两次测试。阈值越高代表需要更大音量才能听到，因此 delta 为正表示表现下降
function buildTrend(tests) {
  if (!tests.length) return null
  const latest = tests[tests.length - 1]
  const previous = tests.length > 1 ? tests[tests.length - 2] : null

  const latestLeft = earThresholdMap(latest.ears && latest.ears.left)
  const latestRight = earThresholdMap(latest.ears && latest.ears.right)
  const changes = []

  if (previous) {
    const prevLeft = earThresholdMap(previous.ears && previous.ears.left)
    const prevRight = earThresholdMap(previous.ears && previous.ears.right)
    FREQUENCIES.forEach(frequency => {
      const leftFrom = prevLeft[frequency] === undefined ? null : prevLeft[frequency]
      const leftTo = latestLeft[frequency] === undefined ? null : latestLeft[frequency]
      const rightFrom = prevRight[frequency] === undefined ? null : prevRight[frequency]
      const rightTo = latestRight[frequency] === undefined ? null : latestRight[frequency]
      const leftDelta = Number.isFinite(leftFrom) && Number.isFinite(leftTo) ? leftTo - leftFrom : null
      const rightDelta = Number.isFinite(rightFrom) && Number.isFinite(rightTo) ? rightTo - rightFrom : null
      if (!Number.isFinite(leftDelta) && !Number.isFinite(rightDelta)) return
      changes.push({ frequency, leftFrom, leftTo, leftDelta, rightFrom, rightTo, rightDelta })
    })
  }

  const notable = changes.filter(change => (
    (Number.isFinite(change.leftDelta) && Math.abs(change.leftDelta) >= NOTABLE_DELTA) ||
    (Number.isFinite(change.rightDelta) && Math.abs(change.rightDelta) >= NOTABLE_DELTA)
  ))

  return {
    latest: {
      completedAt: toTimestamp(latest.completedAt),
      left: latestLeft,
      right: latestRight,
      leftAverage: earAverage(latestLeft),
      rightAverage: earAverage(latestRight),
      leftDetected: earDetectedCount(latestLeft),
      rightDetected: earDetectedCount(latestRight)
    },
    previous: previous ? {
      completedAt: toTimestamp(previous.completedAt),
      leftAverage: earAverage(earThresholdMap(previous.ears && previous.ears.left)),
      rightAverage: earAverage(earThresholdMap(previous.ears && previous.ears.right))
    } : null,
    changes,
    notable
  }
}

// 用耳汇总：缺失的日期按 0 计入，避免「只统计有记录的几天」把日均算高
function summarizeUsage(rows, windowDays, thresholdHours) {
  const secondsByDay = {}
  rows.forEach(row => {
    const key = typeof row.dateKey === 'string' ? row.dateKey : ''
    if (!key) return
    secondsByDay[key] = Math.max(0, Math.round(Number(row.seconds) || 0))
  })

  let totalSeconds = 0
  let hpCount = 0
  let hpSum = 0
  let hpMax = null
  const days = Math.max(1, Number(windowDays) || 1)

  for (let index = 0; index < days; index += 1) {
    const key = dateKeyOf(Date.now() - index * DAY_MS)
    totalSeconds += secondsByDay[key] || 0
  }
  rows.forEach(row => {
    const key = typeof row.dateKey === 'string' ? row.dateKey : ''
    if (!key || secondsByDay[key] === undefined) return
    if (Number.isFinite(Number(row.hpCount)) && Number.isFinite(Number(row.hpSum))) {
      hpCount += Number(row.hpCount)
      hpSum += Number(row.hpSum)
    }
    if (Number.isFinite(Number(row.hpMax))) {
      hpMax = hpMax === null ? Number(row.hpMax) : Math.max(hpMax, Number(row.hpMax))
    }
  })

  const avgSeconds = Math.round(totalSeconds / days)
  const limitSeconds = (Number(thresholdHours) || DEFAULT_REMINDER_THRESHOLD) * 3600
  const progress = limitSeconds > 0 ? Math.round((avgSeconds / limitSeconds) * WARNING_PROGRESS) : 0
  let status = 'normal'
  if (progress >= DANGER_PROGRESS) status = 'danger'
  else if (progress >= WARNING_PROGRESS) status = 'warning'

  return {
    windowDays: days,
    totalSeconds,
    avgSeconds,
    avgHours: Number((avgSeconds / 3600).toFixed(1)),
    thresholdHours: Number(thresholdHours) || DEFAULT_REMINDER_THRESHOLD,
    avgVolume: hpCount > 0 ? Math.round(hpSum / hpCount) : null,
    maxVolume: hpMax,
    status,
    trackedDays: Object.keys(secondsByDay).filter(key => secondsByDay[key] > 0).length
  }
}

// 档案完整度：既是给用户看的进度条，也是 Agent 判断「还缺什么信息」的依据
function buildCompleteness({ profile, tests, notes, usage }) {
  const items = [
    { key: 'device', label: '耳机型号', done: Boolean(profile && profile.deviceModel) },
    { key: 'test', label: '首次听力测试', done: tests.length > 0 },
    { key: 'trend', label: '两次以上测试（可对比趋势）', done: tests.length >= 2 },
    { key: 'usage', label: '用耳记录', done: usage.totalSeconds > 0 },
    { key: 'note', label: '健康日志', done: notes.length > 0 },
    {
      key: 'visit',
      label: '就医或用药记录',
      done: notes.some(note => note.type === 'visit' || note.type === 'medication')
    }
  ]
  const done = items.filter(item => item.done).length
  return {
    percent: Math.round((done / items.length) * 100),
    items,
    missing: items.filter(item => !item.done).map(item => item.label)
  }
}

// 快照是给模型看的内部材料，字段名对用户不可见；
// prompt 层会明确要求「不得把这些内部标签原样输出给用户」
function formatSnapshot(archive) {
  const { profile, tests, trend, usage, notes, memory, completeness } = archive
  const lines = []
  const threshold = (profile && profile.reminderThreshold) || DEFAULT_REMINDER_THRESHOLD

  lines.push('【用户健康档案快照】（系统自动生成，内部材料，禁止在回复中原样输出任何字段名或内部标识）')

  const basics = []
  if (profile && profile.deviceModel) basics.push(`常用耳机：${profile.deviceModel}`)
  basics.push(`每日用耳提醒阈值：${threshold} 小时`)
  basics.push(`累计完成听力测试：${tests.length} 次`)
  lines.push(`1. 基本情况：${basics.join('；')}`)

  if (!tests.length) {
    lines.push('2. 听力测试：用户还没有任何测试记录，不要编造测试结果。')
  } else if (trend) {
    const { latest } = trend
    lines.push(
      `2. 最近一次测试（${formatDateText(latest.completedAt)}）：` +
      `左耳测得 ${latest.leftDetected}/${FREQUENCIES.length} 个频点，平均相对阈值 ${latest.leftAverage}%；` +
      `右耳测得 ${latest.rightDetected}/${FREQUENCIES.length} 个频点，平均相对阈值 ${latest.rightAverage}%`
    )

    if (trend.previous) {
      const changeText = trend.notable.length
        ? trend.notable.map(change => {
          const parts = []
          if (Number.isFinite(change.leftDelta)) {
            parts.push(`左耳 ${change.frequency}Hz ${change.leftFrom}% → ${change.leftTo}%`)
          }
          if (Number.isFinite(change.rightDelta)) {
            parts.push(`右耳 ${change.frequency}Hz ${change.rightFrom}% → ${change.rightTo}%`)
          }
          const worst = Math.max(
            Number.isFinite(change.leftDelta) ? change.leftDelta : 0,
            Number.isFinite(change.rightDelta) ? change.rightDelta : 0
          )
          return `${parts.join('，')}（${worst > 0 ? '需要更大音量才能听到，表现下降' : '需要的音量变小，表现改善'}）`
        }).join('；')
        : '各频点变化都在正常波动范围内，没有明显变化'

      lines.push(`3. 与上一次测试（${formatDateText(trend.previous.completedAt)}）对比：${changeText}`)
    } else {
      lines.push('3. 目前只有一次测试记录，还无法判断趋势，可以建议过一段时间再测一次做对比。')
    }
  }

  const usageParts = [
    `近 7 天日均用耳 ${usage.weekly.avgHours} 小时（提醒阈值 ${threshold} 小时，状态 ${usage.weekly.status}）`,
    `近 30 天日均 ${usage.monthly.avgHours} 小时`
  ]
  if (Number.isFinite(usage.weekly.avgVolume)) {
    usageParts.push(`近 7 天耳机平均音量约 ${usage.weekly.avgVolume} 分贝`)
  }
  lines.push(`4. 用耳行为：${usageParts.join('；')}`)

  if (notes.length) {
    lines.push(`5. 健康日志（最近 ${Math.min(notes.length, SNAPSHOT_NOTE_LIMIT)} 条）：`)
    notes.slice(0, SNAPSHOT_NOTE_LIMIT).forEach(note => {
      lines.push(`   - ${formatDateText(note.occurredAt)} [${NOTE_TYPE_LABELS[note.type] || '备注'}] ${note.content}`)
    })
  } else {
    lines.push('5. 健康日志：暂无记录。')
  }

  if (memory.length) {
    lines.push(`6. 已记住的事（${MEMORY_KIND_LABELS.fact} / ${MEMORY_KIND_LABELS.todo}）：`)
    memory.slice(0, SNAPSHOT_MEMORY_LIMIT).forEach(item => {
      lines.push(`   - [${MEMORY_KIND_LABELS[item.kind] || '长期情况'}] ${item.content}`)
    })
  } else {
    lines.push('6. 已记住的事：暂无。')
  }

  lines.push(
    `7. 档案完整度 ${completeness.percent}%` +
    (completeness.missing.length ? `，还缺：${completeness.missing.join('、')}` : '，信息已比较完整')
  )

  return lines.join('\n')
}

function toNoteView(doc) {
  return {
    id: doc._id,
    type: NOTE_TYPES.includes(doc.type) ? doc.type : 'note',
    typeLabel: NOTE_TYPE_LABELS[doc.type] || '备注',
    content: typeof doc.content === 'string' ? doc.content : '',
    occurredAt: toTimestamp(doc.occurredAt),
    occurredAtText: formatDateText(doc.occurredAt),
    source: doc.source === 'agent' ? 'agent' : 'user'
  }
}

function toMemoryView(doc) {
  return {
    id: doc._id,
    kind: MEMORY_KINDS.includes(doc.kind) ? doc.kind : 'fact',
    kindLabel: MEMORY_KIND_LABELS[doc.kind] || '长期情况',
    content: typeof doc.content === 'string' ? doc.content : '',
    createdAt: toTimestamp(doc.createdAt),
    createdAtText: formatDateText(doc.createdAt)
  }
}

// 数据访问工厂：传入 cloud.database() 实例，便于测试时替换
function createArchiveStore(db) {
  async function ensureCollections() {
    const names = [HEALTH_NOTES, AGENT_MEMORY]
    for (const name of names) {
      try {
        await db.createCollection(name)
        await new Promise(resolve => setTimeout(resolve, 300))
      } catch (error) {
        // 集合已存在，或没有建集合权限（读写时才暴露真实错误）
      }
    }
  }

  async function safeList(collection, openid, orderField, limit) {
    try {
      const result = await db.collection(collection)
        .where({ openid })
        .orderBy(orderField, 'desc')
        .limit(limit)
        .get()
      return Array.isArray(result.data) ? result.data : []
    } catch (error) {
      // 档案里的任何一块读不出来都不该让整轮对话失败，降级为空集合
      return []
    }
  }

  async function loadProfile(openid) {
    try {
      const result = await db.collection(USERS_COLLECTION).where({ openid }).limit(1).get()
      const doc = result.data[0]
      if (!doc) return { deviceModel: '', reminderThreshold: DEFAULT_REMINDER_THRESHOLD, testCount: 0 }
      const settings = doc.settings && typeof doc.settings === 'object' ? doc.settings : {}
      return {
        deviceModel: normalizeText(doc.deviceModel, 40),
        reminderThreshold: REMINDER_THRESHOLDS.includes(Number(settings.reminderThreshold))
          ? Number(settings.reminderThreshold)
          : DEFAULT_REMINDER_THRESHOLD,
        testCount: Number(doc.testCount) || 0
      }
    } catch (error) {
      return { deviceModel: '', reminderThreshold: DEFAULT_REMINDER_THRESHOLD, testCount: 0 }
    }
  }

  async function loadTests(openid) {
    const rows = await safeList(TEST_COLLECTION, openid, 'completedAt', MAX_TESTS)
    return rows.reverse() // 趋势按时间升序处理
  }

  async function loadUsage(openid, windowDays) {
    const toDate = dateKeyOf(Date.now())
    const fromDate = dateKeyOf(Date.now() - (windowDays - 1) * DAY_MS)
    try {
      const result = await db.collection(USAGE_COLLECTION)
        .where({
          openid,
          dateKey: db.command.gte(fromDate).and(db.command.lte(toDate))
        })
        .limit(200)
        .get()
      return Array.isArray(result.data) ? result.data : []
    } catch (error) {
      return []
    }
  }

  async function buildArchive(openid) {
    const [profile, tests, usageRows, noteDocs, memoryDocs] = await Promise.all([
      loadProfile(openid),
      loadTests(openid),
      loadUsage(openid, ARCHIVE_WINDOW_DAYS),
      safeList(HEALTH_NOTES, openid, 'occurredAt', MAX_NOTES),
      safeList(AGENT_MEMORY, openid, 'createdAt', MAX_MEMORY)
    ])

    const notes = noteDocs.map(toNoteView)
    const memory = memoryDocs.map(toMemoryView)
    const thresholdHours = profile.reminderThreshold
    const usage = {
      weekly: summarizeUsage(usageRows.slice(-7), 7, thresholdHours),
      monthly: summarizeUsage(usageRows, ARCHIVE_WINDOW_DAYS, thresholdHours)
    }
    const trend = buildTrend(tests)

    return {
      profile,
      // 保留完整的逐频点阈值：快照只概述「明显变化」，工具 get_hearing_trend 需要全量明细
      tests: tests.map(item => ({
        id: item._id,
        completedAt: toTimestamp(item.completedAt),
        detectedLeft: Number(item.detectedLeft) || 0,
        detectedRight: Number(item.detectedRight) || 0,
        left: earThresholdMap(item.ears && item.ears.left),
        right: earThresholdMap(item.ears && item.ears.right)
      })),
      trend,
      usage,
      notes,
      memory,
      completeness: buildCompleteness({ profile, tests, notes, usage: usage.monthly }),
      builtAt: Date.now()
    }
  }

  async function addNote(openid, input) {
    const type = NOTE_TYPES.includes(input && input.type) ? input.type : 'note'
    const content = normalizeText(input && input.content, MAX_NOTE_LENGTH)
    if (!content) throw new Error('EMPTY_NOTE')
    const occurredAt = Number.isFinite(Number(input && input.occurredAt))
      ? new Date(Number(input.occurredAt))
      : new Date()

    const result = await db.collection(HEALTH_NOTES).add({
      data: {
        openid,
        type,
        content,
        occurredAt,
        source: input && input.source === 'agent' ? 'agent' : 'user',
        createTime: new Date()
      }
    })
    return { id: result._id, type, typeLabel: NOTE_TYPE_LABELS[type], content, occurredAt: occurredAt.getTime() }
  }

  async function removeNote(openid, id) {
    const noteId = normalizeText(id, 64)
    if (!noteId) throw new Error('INVALID_NOTE_ID')
    await db.collection(HEALTH_NOTES).where({ openid, _id: noteId }).remove()
    return { id: noteId }
  }

  async function addMemory(openid, input) {
    const kind = MEMORY_KINDS.includes(input && input.kind) ? input.kind : 'fact'
    const content = normalizeText(input && input.content, MAX_MEMORY_LENGTH)
    if (!content) throw new Error('EMPTY_MEMORY')
    const result = await db.collection(AGENT_MEMORY).add({
      data: { openid, kind, content, createTime: new Date() }
    })
    return { id: result._id, kind, kindLabel: MEMORY_KIND_LABELS[kind], content }
  }

  async function removeMemory(openid, id) {
    const memoryId = normalizeText(id, 64)
    if (!memoryId) throw new Error('INVALID_MEMORY_ID')
    await db.collection(AGENT_MEMORY).where({ openid, _id: memoryId }).remove()
    return { id: memoryId }
  }

  async function updateReminderThreshold(openid, hours) {
    const value = Number(hours)
    if (!REMINDER_THRESHOLDS.includes(value)) throw new Error('INVALID_THRESHOLD')
    const result = await db.collection(USERS_COLLECTION).where({ openid }).limit(1).get()
    const doc = result.data[0]
    if (!doc) throw new Error('USER_NOT_FOUND')
    const settings = doc.settings && typeof doc.settings === 'object' ? doc.settings : {}
    await db.collection(USERS_COLLECTION).doc(doc._id).update({
      data: { settings: { ...settings, reminderThreshold: value } }
    })
    return { reminderThreshold: value }
  }

  async function clearArchive(openid) {
    const removeAll = async name => {
      for (;;) {
        let result
        try {
          result = await db.collection(name).where({ openid }).limit(100).get()
        } catch (error) {
          return
        }
        if (!result.data.length) return
        await Promise.all(result.data.map(doc =>
          db.collection(name).doc(doc._id).remove().catch(() => {})
        ))
        if (result.data.length < 100) return
      }
    }
    await Promise.all([removeAll(HEALTH_NOTES), removeAll(AGENT_MEMORY)])
    return { cleared: true }
  }

  return {
    ensureCollections,
    buildArchive,
    addNote,
    removeNote,
    addMemory,
    removeMemory,
    updateReminderThreshold,
    clearArchive
  }
}

module.exports = {
  HEALTH_NOTES,
  AGENT_MEMORY,
  NOTE_TYPES,
  NOTE_TYPE_LABELS,
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  REMINDER_THRESHOLDS,
  MAX_NOTE_LENGTH,
  MAX_MEMORY_LENGTH,
  FREQUENCIES,
  dateKeyOf,
  formatDateText,
  toTimestamp,
  earThresholdMap,
  earAverage,
  buildTrend,
  summarizeUsage,
  buildCompleteness,
  formatSnapshot,
  createArchiveStore
}
