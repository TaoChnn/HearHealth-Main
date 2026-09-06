class AiRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AiRequestError'
    this.code = code
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
        error.message || 'AI 解读服务暂时不可用'
      )
    }
    return result.data
  }).catch(error => {
    const requestError = error instanceof AiRequestError
      ? error
      : new AiRequestError('MODEL_REQUEST_FAILED', 'AI 解读服务暂时不可用')
    console.warn('[ai] request failed', { action, code: requestError.code })
    throw requestError
  })
}

function analyzeHearingTest(testRecordId) {
  const normalizedId = typeof testRecordId === 'string' ? testRecordId.trim() : ''
  return callAi('analyzeHearingTest', { testRecordId: normalizedId })
}

function chatHearingHealth(messages) {
  return callAi('chatHearingHealth', {
    messages: Array.isArray(messages) ? messages : []
  })
}

// 健康档案 Agent：带档案上下文的对话。
// confirm 用于把用户已确认的写入动作回传，云函数会重新校验参数后再落库
function agentChat(messages, confirm) {
  const payload = {
    messages: Array.isArray(messages) ? messages : []
  }
  if (confirm && typeof confirm === 'object') {
    payload.confirm = confirm
  }
  return callAi('agentChat', payload)
}

// 撤销一次 Agent 已完成的写入（undo 由写入时服务端生成并随结果返回）
function undoAgentAction(undo) {
  return callAi('undoAgentAction', { undo: undo || null })
}

module.exports = {
  AiRequestError,
  callAi,
  analyzeHearingTest,
  chatHearingHealth,
  agentChat,
  undoAgentAction
}
