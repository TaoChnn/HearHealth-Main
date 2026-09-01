class AiRequestError extends Error {
  constructor(code, message, debug = null) {
    super(message)
    this.name = 'AiRequestError'
    this.code = code
    this.debug = debug
  }
}

function normalizeSafeDebug(value) {
  if (!value || typeof value !== 'object') return null
  const stringOrEmpty = field => (typeof value[field] === 'string' ? value[field] : '')
  const numberOrNull = field => (Number.isFinite(value[field]) ? value[field] : null)
  return {
    testRecordIdExists: Boolean(value.testRecordIdExists),
    testRecordIdLength: numberOrNull('testRecordIdLength'),
    testRecordIdPrefix: stringOrEmpty('testRecordIdPrefix'),
    resultDataType: stringOrEmpty('resultDataType'),
    resultDataLength: numberOrNull('resultDataLength'),
    documentExists: Boolean(value.documentExists),
    ownershipMatch: Boolean(value.ownershipMatch),
    openidFingerprint: stringOrEmpty('openidFingerprint'),
    recordOpenidFingerprint: stringOrEmpty('recordOpenidFingerprint'),
    lookupErrorCode: value.lookupErrorCode === null
      ? null
      : stringOrEmpty('lookupErrorCode')
  }
}

function callAi(action, data = {}) {
  return wx.cloud.callFunction({
    name: 'aiFunctions',
    data: { action, ...data }
  }).then(response => {
    const result = response.result || {}
    if (result.success !== true) {
      const error = result.error || {}
      throw new AiRequestError(
        error.code || 'MODEL_REQUEST_FAILED',
        error.message || 'AI 解读服务暂时不可用',
        normalizeSafeDebug(result.debug)
      )
    }
    return result.data
  }).catch(error => {
    const requestError = error instanceof AiRequestError
      ? error
      : new AiRequestError('MODEL_REQUEST_FAILED', 'AI 解读服务暂时不可用')
    console.warn('[ai] request failed', {
      code: requestError.code,
      debug: requestError.debug || null
    })
    throw requestError
  })
}

function analyzeHearingTest(testRecordId) {
  const normalizedId = typeof testRecordId === 'string' ? testRecordId.trim() : ''
  return callAi('analyzeHearingTest', { testRecordId: normalizedId })
}

module.exports = {
  AiRequestError,
  normalizeSafeDebug,
  callAi,
  analyzeHearingTest
}
