const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const {
  PROMPT_VERSION,
  AGENT_PROMPT_VERSION,
  SOURCES_MARKER,
  SOURCE_LABELS,
  SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  buildAgentSystemPrompt,
  buildHearingAnalysisUserPrompt
} = require('./prompts')
const {
  SCHEMA_VERSION,
  HEARING_ANALYSIS_SCHEMA,
  validateHearingAnalysis
} = require('./schemas')
const {
  QwenClientError,
  getQwenConfig,
  isConfigured,
  requestHearingAnalysis,
  requestHearingHealthChat,
  requestAgentChat
} = require('./qwen-client')
const { createArchiveStore, formatSnapshot, formatDateText } = require('./archive')
const {
  listToolDefinitions,
  findTool,
  validateWriteArgs,
  describePendingAction
} = require('./tools')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const TEST_COLLECTION = 'test_records'
const ANALYSIS_COLLECTION = 'ai_test_analyses'
const MAX_CHAT_MESSAGES = 12
const MAX_CHAT_CONTENT_LENGTH = 1000
// Agent 每轮最多执行 2 次工具调用，第 3 轮强制输出文字结论，
// 避免模型反复查档案把云函数拖到超时（本函数超时上限见 config.json）
const MAX_AGENT_TOOL_ROUNDS = 2
const MAX_AGENT_TOOL_CALLS = 4
const MAX_TOOL_RESULT_LENGTH = 2000
class AiFunctionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AiFunctionError'
    this.code = code
  }
}

function sanitizeAnalysisText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\b(?:data\.)?detectedLeft\s*[:=]\s*(\d+)/gi, '本次左耳在 $1 个测试频点检测到声音反应')
    .replace(/\b(?:data\.)?detectedRight\s*[:=]\s*(\d+)/gi, '本次右耳在 $1 个测试频点检测到声音反应')
    .replace(/\b(?:data\.)?detectedLeft\b/gi, '左耳检测到的测试频点数')
    .replace(/\b(?:data\.)?detectedRight\b/gi, '右耳检测到的测试频点数')
    .replace(/\b(?:data\.)?ears\.left\b/gi, '左耳各测试频点结果')
    .replace(/\b(?:data\.)?ears\.right\b/gi, '右耳各测试频点结果')
    .replace(/\b(?:data\.)?schemaVersion\s*[:=]\s*\d+/gi, '')
    .replace(/\b(?:data\.)?measurement\s*[:=]\s*['"]?relative-gain-threshold['"]?/gi, '本次采用相对音量阈值筛查')
    .replace(/\brelative-gain-threshold\b/gi, '相对音量阈值筛查')
    .replace(/\bthresholdPercent\b\s*/gi, '相对音量阈值')
    .replace(/\bschemaVersion\b/gi, '')
    .replace(/\bmeasurement\b/gi, '测试方式')
    .replace(/\bdata\./gi, '')
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, '')
    .replace(/\b[a-z]{2,}(?:[A-Z][A-Za-z0-9]*)+\b/g, '')
    .replace(/\b(?:routine|monitor|professional-check)\b/gi, '')
    .replace(/```[\w-]*\s*/g, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/__/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/#{1,6}/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/^\s*[:：,，;；|/\\–—-]+\s*/g, '')
    .replace(/\s*[:：,，;；|/\\–—-]+\s*$/g, '')
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
    .trim()
}

function sanitizeAnalysisTextList(value) {
  if (!Array.isArray(value)) return []
  return value.map(sanitizeAnalysisText).filter(Boolean)
}

function sanitizeHearingAnalysisText(analysis) {
  return {
    ...analysis,
    overview: sanitizeAnalysisText(analysis.overview),
    findings: analysis.findings.map(item => ({
      ...item,
      title: sanitizeAnalysisText(item.title),
      explanation: sanitizeAnalysisText(item.explanation),
      evidence: sanitizeAnalysisTextList(item.evidence)
    })),
    earComparison: {
      ...analysis.earComparison,
      summary: sanitizeAnalysisText(analysis.earComparison.summary),
      caution: sanitizeAnalysisText(analysis.earComparison.caution)
    },
    recommendations: analysis.recommendations.map(item => ({
      ...item,
      text: sanitizeAnalysisText(item.text),
      reason: sanitizeAnalysisText(item.reason)
    })),
    redFlags: sanitizeAnalysisTextList(analysis.redFlags),
    limitations: sanitizeAnalysisTextList(analysis.limitations),
    disclaimer: sanitizeAnalysisText(analysis.disclaimer)
  }
}

function validateChatMessages(value) {
  if (!Array.isArray(value)) {
    throw new AiFunctionError('INVALID_CHAT_MESSAGES', '聊天消息格式无效')
  }

  const messages = []
  for (let index = value.length - 1; index >= 0 && messages.length < MAX_CHAT_MESSAGES; index -= 1) {
    const item = value[index]
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue
    if (typeof item.content !== 'string') {
      throw new AiFunctionError('INVALID_CHAT_MESSAGES', '聊天消息格式无效')
    }
    const content = item.content.trim()
    if (!content || content.length > MAX_CHAT_CONTENT_LENGTH) {
      throw new AiFunctionError('INVALID_CHAT_MESSAGES', '聊天消息内容无效')
    }
    messages.unshift({ role: item.role, content })
  }

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new AiFunctionError('INVALID_CHAT_MESSAGES', '请先输入要咨询的问题')
  }
  return messages
}

function sanitizeChatReply(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/```[\w-]*\s*/g, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .trim()
}

async function chatHearingHealth(event) {
  const messages = validateChatMessages(event && event.messages)
  const { model } = getQwenConfig()
  let response
  try {
    response = await requestHearingHealthChat({
      systemPrompt: CHAT_SYSTEM_PROMPT,
      messages
    })
  } catch (error) {
    logModelError('chatHearingHealth', error)
    throw new AiFunctionError(
      error instanceof QwenClientError ? error.code : 'MODEL_REQUEST_FAILED',
      error && error.message ? error.message : 'AI 助手请求失败'
    )
  }

  const reply = sanitizeChatReply(response.content)
  if (!reply) {
    throw new AiFunctionError('MODEL_INVALID_RESPONSE', 'AI 助手未返回有效内容')
  }
  return { reply, model: response.model || model }
}

// 模型会在回答末尾写一行「依据：xxx」，这里解析成可点击的溯源标签并从正文里剥掉，
// 用户最终看到的是标签，不是这行原始文本
function parseSources(text) {
  const lines = String(text || '').split('\n')
  const kept = []
  const sources = []
  lines.forEach(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith(SOURCES_MARKER)) {
      trimmed.slice(SOURCES_MARKER.length).split(/[·•、,，/]/).forEach(item => {
        const label = item.trim()
        if (SOURCE_LABELS.includes(label) && !sources.includes(label)) sources.push(label)
      })
      return
    }
    kept.push(line)
  })
  return { reply: kept.join('\n').trim(), sources }
}

// 执行一轮工具调用。只读工具直接返回档案明细；
// 一旦遇到写入工具就立刻中断，把待确认动作交回前端，不在云函数里擅自落库
async function runToolCalls({ store, openid, archive, previousThreshold, toolCalls }) {
  const results = []
  let pending = null

  for (const call of toolCalls) {
    const name = call && call.function && call.function.name
    const rawArgs = call && call.function && call.function.arguments
    const tool = findTool(name)

    if (!tool) {
      results.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '没有这个能力。请直接用文字回答用户，不要再尝试调用工具。'
      })
      continue
    }

    if (tool.requiresConfirm) {
      pending = describePendingAction(name, rawArgs)
      if (pending) break
      results.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '这次记录缺少必要信息，写入已取消。请直接用文字回答用户。'
      })
      continue
    }

    try {
      const result = await tool.run({ store, openid, archive, previousThreshold }, rawArgs)
      results.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result && result.text || '').slice(0, MAX_TOOL_RESULT_LENGTH)
      })
    } catch (error) {
      results.push({
        role: 'tool',
        tool_call_id: call.id,
        content: '读取档案失败。请基于已有信息回答，不要编造数据。'
      })
    }
  }

  return { results, pending }
}

// 大模型未配置时的兜底：不调模型，直接基于档案做规则化回答。
// 目的是让档案读取与整条链路仍然可用，而不是把所有功能都挡在 CONFIG_MISSING 后面
function buildOfflineReply(archive, question) {
  const text = String(question || '')
  const has = (...words) => words.some(word => text.includes(word))
  const trend = archive.trend
  const usage = archive.usage

  if (has('耳鸣', '嗡嗡', '耳朵响')) {
    const lines = [
      '短暂出现的耳鸣在噪声暴露或用耳疲劳之后比较常见，多数会自行缓解。',
      '• 先把音量降下来，连续用耳每 45 到 60 分钟休息几分钟。',
      '• 尽量别在嘈杂环境里靠提高音量盖过噪声。'
    ]
    if (archive.notes.length) {
      lines.push(`你的档案里已有 ${archive.notes.length} 条健康日志，最近一条是 ${archive.notes[0].occurredAtText} 的［${archive.notes[0].typeLabel}］${archive.notes[0].content}。`)
    }
    lines.push('如果耳鸣持续几天不缓解、只在一侧出现，或伴有明显听力下降，建议尽快到耳鼻喉科做专业评估。')
    return { reply: lines.join('\n'), sources: archive.notes.length ? ['健康日志'] : [] }
  }

  if (has('音量', '分贝', '声音', '太响')) {
    const lines = ['一般建议耳机音量不超过最大音量的六成，以能听清内容、不需要提高嗓门说话为准。']
    if (Number.isFinite(usage.weekly.avgVolume)) {
      lines.push(`你近 7 天记录到的耳机平均音量约 ${usage.weekly.avgVolume} 分贝${Number.isFinite(usage.weekly.maxVolume) ? `，最高约 ${usage.weekly.maxVolume} 分贝` : ''}。`)
    } else {
      lines.push('档案里暂时还没有可用的音量记录。')
    }
    lines.push('• 在地铁、公交等嘈杂环境里，优先用降噪或换入耳式物理隔音，而不是提高音量。')
    lines.push('• 出现听不清、需要反复调高音量时，先停下来让耳朵休息。')
    return { reply: lines.join('\n'), sources: ['用耳行为'] }
  }

  if (has('多久', '时长', '几个小时', '超时', '用耳')) {
    const lines = [
      `你近 7 天日均用耳 ${usage.weekly.avgHours} 小时，近 30 天日均 ${usage.monthly.avgHours} 小时，当前每日提醒阈值是 ${usage.weekly.thresholdHours} 小时。`
    ]
    if (usage.weekly.status === 'danger') {
      lines.push('已经明显超过你设定的提醒阈值，建议今天就开始分段休息，并把音量一起降下来。')
    } else if (usage.weekly.status === 'warning') {
      lines.push('接近你设定的提醒阈值，可以把长时间连续使用拆成几段，中间留出安静时间。')
    } else {
      lines.push('目前还在你设定的提醒阈值之内，保持「每 45 到 60 分钟休息几分钟」的节奏即可。')
    }
    lines.push('世界卫生组织建议成年人每周耳机使用控制在 40 小时以内，且音量不宜长期偏高。')
    return { reply: lines.join('\n'), sources: ['用耳行为'] }
  }

  if (has('档案', '完整', '缺', '记了什么', '记录')) {
    const lines = [`你的档案完整度是 ${archive.completeness.percent}%。`]
    if (archive.completeness.missing.length) {
      lines.push(`还缺：${archive.completeness.missing.join('、')}。`)
    } else {
      lines.push('主要信息已经比较完整了。')
    }
    return { reply: lines.join('\n'), sources: ['档案概况'] }
  }

  if (trend) {
    const latest = trend.latest
    const lines = [
      `你最近一次测试在 ${formatDateText(latest.completedAt)}：左耳测得 ${latest.leftDetected}/6 个频点、平均相对阈值 ${latest.leftAverage}%，右耳测得 ${latest.rightDetected}/6 个频点、平均相对阈值 ${latest.rightAverage}%。`
    ]
    if (trend.previous) {
      if (trend.notable.length) {
        lines.push(`和上一次（${formatDateText(trend.previous.completedAt)}）相比，这些频点变化比较明显：`)
        trend.notable.slice(0, 3).forEach(change => {
          const parts = []
          if (Number.isFinite(change.leftDelta)) parts.push(`左耳 ${change.leftDelta > 0 ? '+' : ''}${change.leftDelta}`)
          if (Number.isFinite(change.rightDelta)) parts.push(`右耳 ${change.rightDelta > 0 ? '+' : ''}${change.rightDelta}`)
          lines.push(`• ${change.frequency}Hz ${parts.join('，')}`)
        })
      } else {
        lines.push(`和上一次（${formatDateText(trend.previous.completedAt)}）相比，各频点变化都在正常波动范围内。`)
      }
    } else {
      lines.push('目前只有一次测试记录，再测一次才能看出趋势。')
    }
    lines.push('这些数值不是 dB HL，也不能换算成听损等级，只能作为同一条件下的相对变化参考。')
    return { reply: lines.join('\n'), sources: ['听力测试'] }
  }

  return {
    reply: [
      '档案里暂时还没有足够的记录可以分析。',
      '先做一次听力测试，再保持几天正常的用耳记录，我就能基于你的真实数据给出有针对性的建议了。'
    ].join('\n'),
    sources: []
  }
}

// 健康档案 Agent：读档案 → 调工具 → 必要时提议写入 → 输出带溯源标签的回答
async function agentChat(event) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    throw new AiFunctionError('RECORD_NOT_FOUND', '登录后才能使用健康档案助手')
  }

  const messages = validateChatMessages(event && event.messages)
  const store = createArchiveStore(db)
  await store.ensureCollections()

  let archive = await store.buildArchive(OPENID)
  const working = messages.slice()
  let appliedAction = null

  // 确认阶段：执行用户刚确认的写入动作。参数来自客户端，必须重新校验后再落库
  const confirm = event && typeof event.confirm === 'object' ? event.confirm : null
  if (confirm) {
    const name = typeof confirm.name === 'string' ? confirm.name : ''
    const args = validateWriteArgs(name, confirm.args)
    const tool = findTool(name)
    if (!args || !tool || !tool.requiresConfirm) {
      throw new AiFunctionError('INVALID_PENDING_ACTION', '待确认的动作已失效')
    }

    let result
    try {
      result = await tool.run({
        store,
        openid: OPENID,
        archive,
        previousThreshold: archive.profile.reminderThreshold
      }, args)
    } catch (error) {
      console.error('[aiFunctions] archive write failed', {
        code: String(error && error.message || 'WRITE_FAILED').slice(0, 64)
      })
      throw new AiFunctionError('ARCHIVE_WRITE_FAILED', '写入档案失败')
    }

    appliedAction = {
      name,
      title: tool.title,
      summary: tool.preview(args),
      undo: result && result.undo ? result.undo : null
    }
    // 写入后重建档案：本轮后续的工具调用与回答都基于最新状态
    archive = await store.buildArchive(OPENID)
    working.push({
      role: 'system',
      content: `[系统提示] 用户已经确认，${result.text}。请用自然语言告诉用户你做了什么，然后继续回答他原本的问题。`
    })
  }

  const systemPrompt = buildAgentSystemPrompt(formatSnapshot(archive))

  // 大模型未配置：走规则化兜底，保证档案相关功能不整体失效
  if (!isConfigured()) {
    const offline = buildOfflineReply(archive, messages[messages.length - 1].content)
    return {
      reply: offline.reply,
      sources: offline.sources,
      mode: 'offline',
      pendingAction: null,
      appliedAction
    }
  }

  const definitions = listToolDefinitions()
  let reply = ''
  let pendingAction = null
  let model = ''

  for (let round = 0; round <= MAX_AGENT_TOOL_ROUNDS; round += 1) {
    const isFinalRound = round === MAX_AGENT_TOOL_ROUNDS
    let response
    try {
      response = await requestAgentChat({
        systemPrompt,
        messages: working,
        tools: isFinalRound ? null : definitions
      })
    } catch (error) {
      logModelError('agentChat', error)
      throw new AiFunctionError(
        error instanceof QwenClientError ? error.code : 'MODEL_REQUEST_FAILED',
        error && error.message ? error.message : 'AI 助手请求失败'
      )
    }
    model = response.model || model

    const message = response.message
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.slice(0, MAX_AGENT_TOOL_CALLS)
      : []

    if (!toolCalls.length || isFinalRound) {
      reply = sanitizeChatReply(message.content)
      break
    }

    working.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: toolCalls
    })

    const { results, pending } = await runToolCalls({
      store,
      openid: OPENID,
      archive,
      previousThreshold: archive.profile.reminderThreshold,
      toolCalls
    })
    if (pending) {
      pendingAction = pending
      break
    }
    working.push(...results)
  }

  const parsed = parseSources(reply)
  if (!parsed.reply && !pendingAction) {
    throw new AiFunctionError('MODEL_INVALID_RESPONSE', 'AI 助手未返回有效内容')
  }

  return {
    reply: parsed.reply,
    sources: parsed.sources,
    mode: 'agent',
    pendingAction,
    appliedAction,
    model,
    promptVersion: AGENT_PROMPT_VERSION
  }
}

// 撤销一次由 Agent 完成的写入。撤销信息由写入时生成，同样按 OPENID 收敛
async function undoAgentAction(event) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    throw new AiFunctionError('RECORD_NOT_FOUND', '登录后才能操作档案')
  }

  const undo = event && typeof event.undo === 'object' ? event.undo : null
  if (!undo || typeof undo.type !== 'string') {
    throw new AiFunctionError('INVALID_PENDING_ACTION', '撤销信息无效')
  }

  const store = createArchiveStore(db)
  try {
    if (undo.type === 'removeNote') {
      await store.removeNote(OPENID, undo.id)
    } else if (undo.type === 'removeMemory') {
      await store.removeMemory(OPENID, undo.id)
    } else if (undo.type === 'restoreThreshold') {
      await store.updateReminderThreshold(OPENID, undo.previousThreshold)
    } else {
      throw new AiFunctionError('INVALID_PENDING_ACTION', '撤销信息无效')
    }
  } catch (error) {
    if (error instanceof AiFunctionError) throw error
    throw new AiFunctionError('ARCHIVE_WRITE_FAILED', '撤销失败')
  }

  return { undone: true }
}

function logModelError(action, error) {
  const details = error && error.debug && typeof error.debug === 'object'
    ? error.debug
    : {}
  console.error('[aiFunctions] model request failed', {
    action,
    code: String(error && error.code || 'MODEL_REQUEST_FAILED').slice(0, 128),
    httpStatus: Number.isFinite(Number(details.httpStatus)) ? Number(details.httpStatus) : null,
    providerCode: typeof details.providerCode === 'string' ? details.providerCode.slice(0, 128) : '',
    networkCode: typeof details.networkCode === 'string' ? details.networkCode.slice(0, 128) : ''
  })
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    // 新集合创建后可能需要极短时间生效，避免首次请求立即查询时报缓存错误。
    await new Promise(resolve => setTimeout(resolve, 300))
  } catch (error) {
    // 集合已存在时 createCollection 会失败，后续真实读写负责暴露其他数据库错误。
  }
}

function validateAnalyzeEvent(event) {
  const source = event && typeof event === 'object' ? event : {}
  const testRecordId = typeof source.testRecordId === 'string' ? source.testRecordId.trim() : ''
  if (!testRecordId) {
    throw new AiFunctionError('INVALID_TEST_RECORD_ID', '测试记录标识无效')
  }
  return testRecordId
}

function createCacheId(testRecordId, promptVersion, model) {
  return crypto
    .createHash('sha256')
    .update(`${testRecordId}|${promptVersion}|${model}`)
    .digest('hex')
}

async function findOwnedTestRecord(testRecordId, openid) {
  const normalizedId = typeof testRecordId === 'string' ? testRecordId.trim() : ''
  if (!normalizedId) {
    throw new AiFunctionError('INVALID_TEST_RECORD_ID', '测试记录标识无效')
  }

  let records
  try {
    const result = await db.collection(TEST_COLLECTION)
      .where({ openid })
      .limit(100)
      .get()
    records = result && Array.isArray(result.data) ? result.data : []
  } catch (error) {
    console.error('[aiFunctions] test record lookup failed', {
      code: String(error && (error.errCode || error.code) || 'DOCUMENT_LOOKUP_FAILED').slice(0, 128)
    })
    throw new AiFunctionError('TEST_RECORD_LOOKUP_FAILED', '读取测试记录失败')
  }

  const record = records.find(item => (
    item &&
    typeof item._id === 'string' &&
    item._id === normalizedId
  )) || null
  return record && record.openid === openid ? record : null
}

async function readCompletedCache(cacheId, openid) {
  let result
  try {
    result = await db.collection(ANALYSIS_COLLECTION)
      .where({ _id: cacheId, openid })
      .limit(1)
      .get()
  } catch (error) {
    throw new AiFunctionError('CACHE_ERROR', 'AI 分析缓存暂时不可用')
  }

  const cached = result.data[0]
  if (!cached || cached.status !== 'completed') return null
  if (!validateHearingAnalysis(cached.analysis)) {
    throw new AiFunctionError('CACHE_ERROR', 'AI 分析缓存内容无效')
  }
  return cached
}

async function saveCompletedCache({ cacheId, openid, testRecordId, analysis, model }) {
  const now = new Date()
  try {
    await db.collection(ANALYSIS_COLLECTION).doc(cacheId).set({
      data: {
        openid,
        testRecordId,
        status: 'completed',
        analysis,
        model,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now
      }
    })
  } catch (error) {
    throw new AiFunctionError('CACHE_ERROR', 'AI 分析结果暂时无法保存')
  }
}

async function analyzeHearingTest(event) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    throw new AiFunctionError('RECORD_NOT_FOUND', '没有找到可分析的测试记录')
  }

  const testRecordId = validateAnalyzeEvent(event)
  const record = await findOwnedTestRecord(testRecordId, OPENID)
  if (!record) {
    throw new AiFunctionError('RECORD_NOT_FOUND', '没有找到可分析的测试记录')
  }

  const { model } = getQwenConfig()
  await ensureCollection(ANALYSIS_COLLECTION)
  const cacheId = createCacheId(testRecordId, PROMPT_VERSION, model)
  const cached = await readCompletedCache(cacheId, OPENID)
  if (cached) {
    return {
      analysis: sanitizeHearingAnalysisText(cached.analysis),
      cached: true,
      model: cached.model,
      promptVersion: cached.promptVersion,
      schemaVersion: cached.schemaVersion
    }
  }

  let modelResponse
  try {
    modelResponse = await requestHearingAnalysis({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildHearingAnalysisUserPrompt(record),
      schema: HEARING_ANALYSIS_SCHEMA
    })
  } catch (error) {
    logModelError('analyzeHearingTest', error)
    if (error instanceof QwenClientError) {
      throw new AiFunctionError(error.code, error.message)
    }
    throw new AiFunctionError('MODEL_REQUEST_FAILED', 'AI 服务请求失败')
  }

  let analysis
  try {
    analysis = JSON.parse(modelResponse.content)
  } catch (error) {
    throw new AiFunctionError('MODEL_INVALID_RESPONSE', 'AI 返回内容无法解析')
  }
  if (!validateHearingAnalysis(analysis)) {
    throw new AiFunctionError('MODEL_INVALID_RESPONSE', 'AI 返回内容未通过安全校验')
  }
  analysis = sanitizeHearingAnalysisText(analysis)

  await saveCompletedCache({
    cacheId,
    openid: OPENID,
    testRecordId,
    analysis,
    model: modelResponse.model
  })

  return {
    analysis,
    cached: false,
    model: modelResponse.model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION
  }
}

function errorResponse(error) {
  const allowedCodes = [
    'CONFIG_MISSING',
    'INVALID_CHAT_MESSAGES',
    'INVALID_TEST_RECORD_ID',
    'RECORD_NOT_FOUND',
    'TEST_RECORD_LOOKUP_FAILED',
    'MODEL_REQUEST_FAILED',
    'MODEL_INVALID_RESPONSE',
    'CACHE_ERROR',
    'INVALID_PENDING_ACTION',
    'ARCHIVE_WRITE_FAILED'
  ]
  const code = allowedCodes.includes(error && error.code)
    ? error.code
    : 'MODEL_REQUEST_FAILED'
  const fallbackMessages = {
    CONFIG_MISSING: 'AI 服务尚未完成配置',
    INVALID_CHAT_MESSAGES: '聊天消息格式无效',
    INVALID_TEST_RECORD_ID: '测试记录标识无效',
    RECORD_NOT_FOUND: '没有找到可分析的测试记录',
    TEST_RECORD_LOOKUP_FAILED: '读取测试记录失败',
    MODEL_REQUEST_FAILED: 'AI 解读服务暂时不可用',
    MODEL_INVALID_RESPONSE: 'AI 返回内容暂时无法使用',
    CACHE_ERROR: 'AI 分析缓存暂时不可用',
    INVALID_PENDING_ACTION: '这个操作已失效，请重新发起',
    ARCHIVE_WRITE_FAILED: '写入健康档案失败，请稍后重试'
  }
  return {
    success: false,
    error: {
      code,
      message: fallbackMessages[code]
    }
  }
}

exports.main = async event => {
  try {
    if (event && event.action === 'chatHearingHealth') {
      const data = await chatHearingHealth(event)
      return { success: true, data }
    }
    if (event && event.action === 'agentChat') {
      // 游客没有云端档案：降级成不带档案的普通问答，保留原有体验
      const { OPENID } = cloud.getWXContext()
      if (!OPENID) {
        const data = await chatHearingHealth(event)
        return {
          success: true,
          data: {
            ...data,
            mode: 'guest',
            sources: [],
            pendingAction: null,
            appliedAction: null
          }
        }
      }
      const data = await agentChat(event)
      return { success: true, data }
    }
    if (event && event.action === 'undoAgentAction') {
      const data = await undoAgentAction(event)
      return { success: true, data }
    }
    if (!event || event.action !== 'analyzeHearingTest') {
      throw new AiFunctionError('MODEL_REQUEST_FAILED', '不支持的 AI 操作')
    }
    const data = await analyzeHearingTest(event)
    return { success: true, data }
  } catch (error) {
    return errorResponse(error)
  }
}

exports._test = {
  AiFunctionError,
  errorResponse,
  sanitizeAnalysisText,
  sanitizeHearingAnalysisText,
  validateChatMessages,
  sanitizeChatReply,
  chatHearingHealth,
  analyzeHearingTest,
  createCacheId,
  validateAnalyzeEvent,
  findOwnedTestRecord,
  readCompletedCache,
  agentChat,
  undoAgentAction,
  buildOfflineReply,
  parseSources,
  runToolCalls
}
