const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const BUILD_ID = 'ai-agent-20260901-debugstage-v1'
const {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
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
  requestHearingAnalysis,
  requestQwenDiagnostic
} = require('./qwen-client')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const TEST_COLLECTION = 'test_records'
const ANALYSIS_COLLECTION = 'ai_test_analyses'
class AiFunctionError extends Error {
  constructor(code, message, debug = null) {
    super(message)
    this.name = 'AiFunctionError'
    this.code = code
    this.debug = debug
  }
}

function getDiagnosticsData() {
  const baseUrl = String(process.env.DASHSCOPE_BASE_URL || '').trim()
  let baseUrlHost = ''
  if (baseUrl) {
    try {
      baseUrlHost = new URL(baseUrl).hostname
    } catch (error) {
      baseUrlHost = ''
    }
  }
  return {
    buildId: BUILD_ID,
    hasApiKey: Boolean(process.env.DASHSCOPE_API_KEY),
    hasBaseUrl: Boolean(process.env.DASHSCOPE_BASE_URL),
    model: process.env.DASHSCOPE_MODEL || '',
    baseUrlHost
  }
}

async function runQwenDiagnostics() {
  const diagnostics = getDiagnosticsData()
  try {
    const result = await requestQwenDiagnostic()
    return {
      success: true,
      data: {
        buildId: BUILD_ID,
        qwenReachable: true,
        model: result.model || diagnostics.model,
        baseUrlHost: diagnostics.baseUrlHost,
        responseReceived: true,
        contentPreview: result.content.slice(0, 100)
      }
    }
  } catch (error) {
    const fallbackDebug = buildUnexpectedModelDebug(
      error,
      diagnostics.model,
      diagnostics.baseUrlHost ? { hostname: diagnostics.baseUrlHost } : null
    )
    return {
      success: false,
      buildId: BUILD_ID,
      error: {
        code: 'MODEL_REQUEST_FAILED',
        message: 'Qwen cloud diagnostic failed'
      },
      debug: sanitizeQwenDebug(error && error.debug, fallbackDebug)
    }
  }
}

function createDiagnosticHearingRecord() {
  const frequencies = [125, 250, 500, 1000, 2000, 4000]
  const leftThresholds = [10, 10, 15, 15, 20, 20]
  const rightThresholds = [10, 15, 15, 20, 20, 25]
  const answeredAtBase = Date.parse('2026-09-01T00:00:00.000Z')
  const createEarResults = thresholds => frequencies.map((frequency, index) => ({
    frequency,
    detected: true,
    thresholdPercent: thresholds[index],
    maxTestedPercent: thresholds[index],
    attempts: index + 1,
    answeredAt: answeredAtBase + index * 1000
  }))

  return {
    measurement: 'relative-gain-threshold',
    completedAt: new Date('2026-09-01T00:00:00.000Z'),
    detectedLeft: 6,
    detectedRight: 6,
    ears: {
      left: createEarResults(leftThresholds),
      right: createEarResults(rightThresholds)
    }
  }
}

function buildHearingValidationDebug(content, jsonParseSuccess, schemaValid) {
  const responseContent = typeof content === 'string' ? content : ''
  return {
    debugStage: 'hearing-analysis-validation',
    jsonParseSuccess,
    schemaValid,
    responseContentLength: responseContent.length,
    responsePrefix: responseContent.replace(/\s+/g, ' ').slice(0, 100)
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
    .replace(/\bschemaVersion\b/gi, '报告版本')
    .replace(/\bmeasurement\b/gi, '测试方式')
    .replace(/\bdata\./gi, '')
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
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
    .trim()
}

function sanitizeHearingAnalysisText(analysis) {
  return {
    ...analysis,
    overview: sanitizeAnalysisText(analysis.overview),
    findings: analysis.findings.map(item => ({
      ...item,
      title: sanitizeAnalysisText(item.title),
      explanation: sanitizeAnalysisText(item.explanation),
      evidence: item.evidence.map(sanitizeAnalysisText)
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
    redFlags: analysis.redFlags.map(sanitizeAnalysisText),
    limitations: analysis.limitations.map(sanitizeAnalysisText),
    disclaimer: sanitizeAnalysisText(analysis.disclaimer)
  }
}

async function runHearingAnalysisDiagnostics() {
  const diagnostics = getDiagnosticsData()
  let modelResponse
  try {
    modelResponse = await requestHearingAnalysis({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildHearingAnalysisUserPrompt(createDiagnosticHearingRecord()),
      schema: HEARING_ANALYSIS_SCHEMA
    })
  } catch (error) {
    const fallbackDebug = buildUnexpectedModelDebug(
      error,
      diagnostics.model,
      diagnostics.baseUrlHost ? { hostname: diagnostics.baseUrlHost } : null
    )
    return {
      success: false,
      buildId: BUILD_ID,
      error: {
        code: 'MODEL_REQUEST_FAILED',
        message: 'Qwen hearing analysis diagnostic failed'
      },
      debug: sanitizeQwenDebug(error && error.debug, fallbackDebug)
    }
  }

  let analysis
  try {
    analysis = JSON.parse(modelResponse.content)
  } catch (error) {
    return {
      success: false,
      buildId: BUILD_ID,
      error: {
        code: 'MODEL_INVALID_RESPONSE',
        message: 'AI 返回结构未通过校验'
      },
      debug: buildHearingValidationDebug(modelResponse.content, false, false)
    }
  }

  const schemaValid = validateHearingAnalysis(analysis)
  if (!schemaValid) {
    return {
      success: false,
      buildId: BUILD_ID,
      error: {
        code: 'MODEL_INVALID_RESPONSE',
        message: 'AI 返回结构未通过校验'
      },
      debug: buildHearingValidationDebug(modelResponse.content, true, false)
    }
  }

  return {
    success: true,
    data: {
      buildId: BUILD_ID,
      hearingAnalysisReachable: true,
      model: modelResponse.model || diagnostics.model,
      schemaValid: true,
      thinkingDisabled: true,
      overviewPreview: analysis.overview.replace(/\s+/g, ' ').slice(0, 100)
    }
  }
}

function buildUnexpectedModelDebug(error, model, endpoint) {
  return {
    debugStage: 'qwen-runtime',
    networkCode: String(error && error.code || 'UNEXPECTED_QWEN_ERROR').slice(0, 128),
    networkMessage: String(error && error.message || 'Qwen request failed').slice(0, 1000),
    model: String(model || '').slice(0, 256),
    host: endpoint && endpoint.hostname ? endpoint.hostname : ''
  }
}

function sanitizeQwenDebug(debug, fallbackDebug) {
  const allowedStages = ['qwen-http', 'qwen-network', 'qwen-timeout', 'qwen-runtime']
  if (!debug || typeof debug !== 'object' || !allowedStages.includes(debug.debugStage)) {
    return fallbackDebug
  }

  const sanitized = { debugStage: debug.debugStage }
  if (Number.isFinite(Number(debug.httpStatus))) {
    sanitized.httpStatus = Number(debug.httpStatus)
  }
  const stringFields = [
    'providerCode',
    'providerMessage',
    'providerRequestId',
    'networkCode',
    'networkMessage',
    'model',
    'host',
    'path'
  ]
  stringFields.forEach(field => {
    if (debug[field] !== null && debug[field] !== undefined) {
      sanitized[field] = String(debug[field]).slice(0, 1000)
    }
  })
  return sanitized
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

function openidFingerprint(value) {
  return value
    ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
    : ''
}

function normalizeRecordData(rawData) {
  if (Array.isArray(rawData)) return rawData[0] || null
  return rawData && typeof rawData === 'object' ? rawData : null
}

function resultDataType(rawData) {
  if (Array.isArray(rawData)) return 'array'
  if (rawData === null || rawData === undefined) return 'null'
  if (typeof rawData === 'object') return 'object'
  return 'other'
}

function buildLookupDebug({
  testRecordId,
  rawData,
  record,
  openid,
  ownRecordCount = null,
  lookupErrorCode = null
}) {
  const id = typeof testRecordId === 'string' ? testRecordId : ''
  const documentExists = Boolean(record)
  const ownershipMatch = Boolean(record && record.openid === openid)
  return {
    debugStage: 'test-record-lookup',
    testRecordIdExists: Boolean(id),
    testRecordIdLength: id.length,
    testRecordIdPrefix: id.slice(0, 6),
    resultDataType: resultDataType(rawData),
    resultDataLength: Array.isArray(rawData) ? rawData.length : null,
    ownRecordCount: Number.isInteger(ownRecordCount) ? ownRecordCount : null,
    documentExists,
    ownershipMatch,
    openidFingerprint: openidFingerprint(openid),
    recordOpenidFingerprint: openidFingerprint(record && record.openid),
    lookupErrorCode
  }
}

async function findOwnedTestRecord(testRecordId, openid) {
  const normalizedId = typeof testRecordId === 'string' ? testRecordId.trim() : ''
  if (!normalizedId) {
    throw new AiFunctionError('INVALID_TEST_RECORD_ID', '测试记录标识无效')
  }

  let rawData = null
  try {
    const result = await db.collection(TEST_COLLECTION)
      .where({ openid })
      .limit(100)
      .get()
    rawData = result && Array.isArray(result.data) ? result.data : []
  } catch (error) {
    const lookupErrorCode = String(
      error && (error.errCode || error.code) || 'DOCUMENT_LOOKUP_FAILED'
    )
    throw new AiFunctionError(
      'TEST_RECORD_LOOKUP_FAILED',
      '读取测试记录失败',
      buildLookupDebug({
        testRecordId: normalizedId,
        rawData: null,
        record: null,
        openid,
        lookupErrorCode
      })
    )
  }

  const record = rawData.find(item => (
    item &&
    typeof item._id === 'string' &&
    item._id === normalizedId
  )) || null
  const debug = buildLookupDebug({
    testRecordId: normalizedId,
    rawData,
    record,
    openid,
    ownRecordCount: rawData.length
  })
  return {
    record: debug.ownershipMatch ? record : null,
    debug
  }
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
  const rawTestRecordId = event && typeof event.testRecordId === 'string'
    ? event.testRecordId.trim()
    : ''
  if (!OPENID) {
    throw new AiFunctionError(
      'RECORD_NOT_FOUND',
      '没有找到可分析的测试记录',
      buildLookupDebug({
        testRecordId: rawTestRecordId,
        rawData: null,
        record: null,
        openid: '',
        lookupErrorCode: 'MISSING_OPENID'
      })
    )
  }

  let testRecordId
  try {
    testRecordId = validateAnalyzeEvent(event)
  } catch (error) {
    error.debug = buildLookupDebug({
      testRecordId: rawTestRecordId,
      rawData: null,
      record: null,
      openid: OPENID,
      lookupErrorCode: 'INVALID_TEST_RECORD_ID'
    })
    throw error
  }

  const lookup = await findOwnedTestRecord(testRecordId, OPENID)
  if (!lookup.record) {
    throw new AiFunctionError(
      'RECORD_NOT_FOUND',
      '没有找到可分析的测试记录',
      lookup.debug
    )
  }
  const record = lookup.record

  const { model, endpoint } = getQwenConfig()
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
    const fallbackDebug = buildUnexpectedModelDebug(error, model, endpoint)
    const debug = sanitizeQwenDebug(error && error.debug, fallbackDebug)
    if (error instanceof QwenClientError) {
      console.error('[aiFunctions] qwen request failed', {
        code: error.code,
        debug
      })
      throw new AiFunctionError(error.code, error.message, debug)
    }
    console.error('[aiFunctions] qwen request failed', {
      code: 'MODEL_REQUEST_FAILED',
      debug
    })
    throw new AiFunctionError('MODEL_REQUEST_FAILED', 'AI 服务请求失败', debug)
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
    'INVALID_TEST_RECORD_ID',
    'RECORD_NOT_FOUND',
    'TEST_RECORD_LOOKUP_FAILED',
    'MODEL_REQUEST_FAILED',
    'MODEL_INVALID_RESPONSE',
    'CACHE_ERROR'
  ]
  const code = allowedCodes.includes(error && error.code)
    ? error.code
    : 'MODEL_REQUEST_FAILED'
  const fallbackMessages = {
    CONFIG_MISSING: 'AI 服务尚未完成配置',
    INVALID_TEST_RECORD_ID: '测试记录标识无效',
    RECORD_NOT_FOUND: '没有找到可分析的测试记录',
    TEST_RECORD_LOOKUP_FAILED: '读取测试记录失败',
    MODEL_REQUEST_FAILED: 'AI 解读服务暂时不可用',
    MODEL_INVALID_RESPONSE: 'AI 返回内容暂时无法使用',
    CACHE_ERROR: 'AI 分析缓存暂时不可用'
  }
  const response = {
    success: false,
    buildId: BUILD_ID,
    error: {
      code,
      message: fallbackMessages[code]
    }
  }
  const responseDebug = code === 'MODEL_REQUEST_FAILED'
    ? sanitizeQwenDebug(error && error.debug, null)
    : error && error.debug
  if (responseDebug) response.debug = responseDebug
  return response
}

exports.main = async event => {
  if (event && event.action === 'diagnosticsHearingAnalysis') {
    return runHearingAnalysisDiagnostics()
  }
  if (event && event.action === 'diagnosticsQwen') {
    return runQwenDiagnostics()
  }
  if (event && event.action === 'diagnostics') {
    return {
      success: true,
      data: getDiagnosticsData()
    }
  }
  try {
    if (!event || event.action !== 'analyzeHearingTest') {
      throw new AiFunctionError(
        'MODEL_REQUEST_FAILED',
        '不支持的 AI 操作',
        {
          debugStage: 'qwen-runtime',
          networkCode: 'UNSUPPORTED_AI_ACTION',
          networkMessage: 'Unsupported AI action',
          model: '',
          host: ''
        }
      )
    }
    const data = await analyzeHearingTest(event)
    return { success: true, buildId: BUILD_ID, data }
  } catch (error) {
    return errorResponse(error)
  }
}

exports._test = {
  AiFunctionError,
  BUILD_ID,
  errorResponse,
  getDiagnosticsData,
  runQwenDiagnostics,
  createDiagnosticHearingRecord,
  buildHearingValidationDebug,
  sanitizeAnalysisText,
  sanitizeHearingAnalysisText,
  runHearingAnalysisDiagnostics,
  sanitizeQwenDebug,
  analyzeHearingTest,
  createCacheId,
  normalizeRecordData,
  buildLookupDebug,
  validateAnalyzeEvent,
  findOwnedTestRecord,
  readCompletedCache
}
