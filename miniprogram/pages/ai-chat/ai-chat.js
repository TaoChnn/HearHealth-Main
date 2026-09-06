// 健康档案 Agent 对话页
// 与普通聊天机器人的区别：模型在回答前会先读这位用户的档案，并且可以「提议」写入档案。
// 写入一律经过二次确认：云函数只返回待确认动作，用户点确认后才真正落库，
// 落库结果带撤销所需的信息，用户可以在这条消息上直接撤销。
const { agentChat, undoAgentAction, chatHearingHealth } = require('../../utils/ai')

const FRIENDLY_ERROR = 'AI 助手暂时无法回复，请稍后重试。'
const GUEST_HINT = '当前为游客模式，登录后我可以查阅你的听力测试、用耳记录与健康日志。'
// 大模型未配置时云函数会退化为规则化摘要，这里如实告知，避免用户以为收到了个性化生成结果
const OFFLINE_HINT = '当前为离线档案摘要模式，回答由本地档案规则生成。'
const BASIC_FALLBACK_HINT = '健康档案助手暂时不可用，已切换为基础问答模式，暂时读不到你的档案。'

// 把云函数的错误代号翻译成能定位问题的提示。
// 之前所有失败都折叠成同一句话，线上出问题时完全无从判断是没部署、没配置还是模型报错
function resolveErrorMessage(error) {
  const code = error && error.code ? String(error.code) : ''
  const message = error && error.message ? String(error.message) : ''

  // 旧版云函数不认识 agentChat，会返回这句话
  if (message.indexOf('不支持的 AI 操作') >= 0) {
    return '健康档案助手还没有部署到云端，请在开发者工具重新上传 aiFunctions 后重试。'
  }
  if (code === 'CONFIG_MISSING') {
    return 'AI 服务尚未完成配置（云函数环境变量缺失），暂时无法回复。'
  }
  if (code === 'INVALID_CHAT_MESSAGES') {
    return '这条消息没能发送成功，请换个说法再试一次。'
  }
  if (code === 'ARCHIVE_WRITE_FAILED') {
    return '档案写入失败，请稍后重试。'
  }
  return FRIENDLY_ERROR
}

const ACTION_STATE_TEXT = {
  pending: '待确认',
  confirming: '写入中',
  applied: '已写入档案',
  cancelled: '已取消',
  dismissed: '已忽略'
}

const APPLIED_STATE_TEXT = {
  applied: '已写入档案',
  undoing: '撤销中',
  undone: '已撤销',
  'undo-failed': '撤销失败'
}

Page({
  data: {
    messages: [],
    inputValue: '',
    loading: false,
    typing: false,
    typingMessageId: '',
    errorMessage: '',
    modeHint: '',
    scrollTarget: '',
    actionStateText: ACTION_STATE_TEXT,
    appliedStateText: APPLIED_STATE_TEXT,
    suggestions: [
      '我的听力最近有变化吗？',
      '我最近用耳是不是太多了？',
      '经常耳鸣需要注意什么？',
      '我的档案还缺什么？'
    ]
  },

  onLoad() {
    this.messageSequence = 0
    this.pageActive = true
    // 待确认动作对应的请求上下文，按下标无关的消息 id 存放，页面重载后对话本身也不保留
    this.pendingPayloads = {}
    this.typewriter = null
  },

  onUnload() {
    this.pageActive = false
    this.stopTypewriter(false)
  },

  // 逐字渲染。wx.cloud.callFunction 不支持流式返回，云函数只能把完整结果一次性传回来，
  // 所以在本地把这段文字按节奏「打」出来，视觉上接近流式。
  // 真正的逐 token 流式需要开通云开发的 HTTP 访问服务（云接入）并用
  // wx.request({ enableChunked: true }) 接 SSE，改动面大得多，这里先不做。
  startTypewriter(targetIndex, messageId, fullText) {
    this.stopTypewriter(false)
    if (!fullText) return

    // 节奏自适应：短句不至于太慢，长句也不会拖太久（整体控制在 0.7s ~ 2.6s）
    const totalDuration = Math.min(2600, Math.max(700, fullText.length * 26))
    const totalTicks = Math.max(6, Math.min(44, Math.round(fullText.length / 3)))
    const interval = totalDuration / totalTicks
    const charsPerTick = fullText.length / totalTicks

    let rendered = 0
    this.typewriter = { targetIndex, messageId, fullText, timer: null, rendered }
    this.setData({ typing: true, typingMessageId: messageId })

    const tick = () => {
      if (!this.pageActive || !this.typewriter) return
      rendered = Math.min(fullText.length, rendered + charsPerTick)
      this.typewriter.rendered = rendered
      this.setData({
        [`messages[${targetIndex}].content`]: fullText.slice(0, Math.round(rendered)),
        scrollTarget: `message-${messageId}`
      })
      if (rendered >= fullText.length) {
        this.typewriter = null
        this.setData({ typing: false })
        return
      }
      this.typewriter.timer = setTimeout(tick, interval)
    }

    // 立刻渲染第一段，避免气泡出现短暂空白
    tick()
  },

  // 结束逐字渲染。flush 为 true 时把剩余文字一次性补全（用于用户打断输入的场景）
  stopTypewriter(flush) {
    if (!this.typewriter) return
    if (this.typewriter.timer) clearTimeout(this.typewriter.timer)

    const { targetIndex, messageId, fullText } = this.typewriter
    this.typewriter = null
    // 页面已卸载（onUnload）时不再触碰 setData
    if (!this.pageActive) return
    this.setData({ typing: false, typingMessageId: '' })

    if (flush && fullText) {
      this.setData({
        [`messages[${targetIndex}].content`]: fullText,
        scrollTarget: `message-${messageId}`
      })
    }
  },

  onInput(event) {
    this.setData({ inputValue: event.detail.value })
  },

  onConfirm() {
    this.sendCurrentInput()
  },

  sendCurrentInput() {
    this.sendMessage(this.data.inputValue)
  },

  sendSuggestion(event) {
    this.sendMessage(event.currentTarget.dataset.question)
  },

  sendMessage(value) {
    if (this.data.loading) return
    const content = typeof value === 'string' ? value.trim() : ''
    if (!content) return

    // 上一条还在逐字渲染时直接补全，避免打字中的消息和新消息混在一起
    this.stopTypewriter(true)

    // 上一条还挂着待确认动作时又问了新问题，视为放弃那条提议
    const messages = this.dismissPending(this.data.messages)
    const userMessage = this.createMessage('user', content)
    const next = [...messages, userMessage]

    this.setData({
      messages: next,
      inputValue: '',
      loading: true,
      errorMessage: '',
      scrollTarget: `message-${userMessage.id}`
    }, () => this.scrollTo('chat-loading'))
    this.requestAssistant(next)
  },

  retryLastMessage() {
    if (this.data.loading || !this.retryContext) return
    this.stopTypewriter(true)
    const context = this.retryContext
    this.setData({ loading: true, errorMessage: '', scrollTarget: 'chat-loading' })
    this.requestAssistant(context.messages, context.confirm, context.confirmIndex)
  },

  requestAssistant(messages, confirm, confirmIndex) {
    this.retryContext = { messages, confirm, confirmIndex }
    const payload = this.toPayload(messages)

    agentChat(payload, confirm)
      .then(result => {
        if (!this.pageActive) return
        const reply = result && typeof result.reply === 'string' ? result.reply.trim() : ''
        const pending = result && result.pendingAction ? result.pendingAction : null
        const applied = result && result.appliedAction ? result.appliedAction : null
        const sources = result && Array.isArray(result.sources) ? result.sources : []

        this.applyModeHint(result && result.mode)

        // 没有正文也没有待确认动作时视为失败，走降级路径
        if (!reply && !pending) throw new Error('empty assistant reply')

        this.appendAssistantReply(reply, { sources, pending, applied }, payload, confirmIndex)
      })
      .catch(error => {
        if (!this.pageActive) return

        // 确认阶段失败不能降级：降级会弄丢待写入的动作，只能把卡片退回让用户重试或取消
        if (confirm) {
          this.revertPendingCard(confirmIndex)
          this.setData({
            loading: false,
            errorMessage: resolveErrorMessage(error),
            scrollTarget: 'chat-error'
          })
          return
        }

        // 普通提问失败时降级为基础问答：用户至少还能得到回答，横幅会如实说明读不到档案
        this.requestPlainFallback(messages, error)
      })
  },

  // 追加一条助手消息；confirmIndex 表示这条回复是对某张待确认卡片的落地结果
  appendAssistantReply(reply, extra, payload, confirmIndex) {
    const list = [...this.data.messages]
    if (typeof confirmIndex === 'number' && list[confirmIndex] && list[confirmIndex].pendingAction) {
      list[confirmIndex] = {
        ...list[confirmIndex],
        pendingAction: { ...list[confirmIndex].pendingAction, state: 'applied' }
      }
    }

    // 正文先置空，由打字器逐段填充；待确认卡片（无正文）保持为空
    const assistantMessage = this.createMessage('assistant', '', {
      sources: extra.sources || [],
      pendingAction: extra.pending ? { ...extra.pending, state: 'pending' } : null,
      appliedAction: extra.applied ? { ...extra.applied, state: 'applied' } : null
    })
    if (extra.pending && payload) this.pendingPayloads[assistantMessage.id] = payload

    list.push(assistantMessage)
    this.setData({
      messages: list,
      loading: false,
      errorMessage: '',
      scrollTarget: reply ? '' : `message-${assistantMessage.id}`
    })

    // 回复正文逐字渲染；待确认卡片（无正文）直接展示
    this.startTypewriter(list.length - 1, assistantMessage.id, reply)
  },

  revertPendingCard(confirmIndex) {
    const list = [...this.data.messages]
    if (typeof confirmIndex === 'number' && list[confirmIndex] && list[confirmIndex].pendingAction) {
      list[confirmIndex] = {
        ...list[confirmIndex],
        pendingAction: { ...list[confirmIndex].pendingAction, state: 'pending' }
      }
    }
    this.setData({ messages: list })
  },

  // Agent 链路失败时的兜底：退回改造前的普通问答。
  // 这样云函数没重新上传、模型暂时不可用等情况下，聊天功能不会整体瘫痪
  requestPlainFallback(messages, cause) {
    console.warn('[ai-chat] agent 请求失败，降级为基础问答', {
      code: cause && cause.code,
      message: cause && cause.message
    })

    chatHearingHealth(this.toPayload(messages))
      .then(result => {
        if (!this.pageActive) return
        const reply = result && typeof result.reply === 'string' ? result.reply.trim() : ''
        if (!reply) throw new Error('empty assistant reply')
        this.setData({ modeHint: BASIC_FALLBACK_HINT })
        this.appendAssistantReply(reply, { sources: [], pending: null, applied: null }, null, null)
      })
      .catch(() => {
        if (!this.pageActive) return
        this.setData({
          loading: false,
          errorMessage: resolveErrorMessage(cause),
          scrollTarget: 'chat-error'
        })
      })
  },

  // 用户确认 Agent 提议的写入：把原始请求上下文连同动作一起回传，
  // 云函数会重新校验参数后落库，再基于「已写入」的状态生成最终回答
  onConfirmAction(event) {
    const index = Number(event.currentTarget.dataset.index)
    const message = this.data.messages[index]
    const pending = message && message.pendingAction
    if (!pending || pending.state !== 'pending' || this.data.loading) return

    this.stopTypewriter(true)

    const payload = this.pendingPayloads[message.id]
    if (!payload) {
      wx.showToast({ title: '这条操作已失效，请重新提问', icon: 'none' })
      this.setData({ [`messages[${index}].pendingAction.state`]: 'dismissed' })
      return
    }

    this.setData({
      [`messages[${index}].pendingAction.state`]: 'confirming',
      loading: true,
      errorMessage: ''
    })
    this.requestAssistant(payload, { name: pending.name, args: pending.args }, index)
  },

  onCancelAction(event) {
    const index = Number(event.currentTarget.dataset.index)
    const message = this.data.messages[index]
    if (!message || !message.pendingAction || message.pendingAction.state !== 'pending') return
    this.stopTypewriter(true)
    this.setData({ [`messages[${index}].pendingAction.state`]: 'cancelled' })
  },

  onUndoAction(event) {
    const index = Number(event.currentTarget.dataset.index)
    const message = this.data.messages[index]
    const applied = message && message.appliedAction
    if (!applied || applied.state !== 'applied' || this.data.loading) return

    this.stopTypewriter(true)

    this.setData({ [`messages[${index}].appliedAction.state`]: 'undoing' })
    undoAgentAction(applied.undo)
      .then(() => {
        if (!this.pageActive) return
        this.setData({ [`messages[${index}].appliedAction.state`]: 'undone' })
        wx.showToast({ title: '已撤销', icon: 'none' })
      })
      .catch(() => {
        if (!this.pageActive) return
        this.setData({ [`messages[${index}].appliedAction.state`]: 'undo-failed' })
        wx.showToast({ title: '撤销失败，请到档案里手动删除', icon: 'none' })
      })
  },

  onOpenArchive() {
    wx.navigateTo({ url: '/pages/profile/health-archive' })
  },

  applyModeHint(mode) {
    if (mode === 'guest') this.setData({ modeHint: GUEST_HINT })
    else if (mode === 'offline') this.setData({ modeHint: OFFLINE_HINT })
    else this.setData({ modeHint: '' })
  },

  // 只把有正文的消息发给模型：待确认的卡片消息没有正文，留在界面上即可
  toPayload(messages) {
    return (Array.isArray(messages) ? messages : [])
      .filter(item => item && (item.role === 'user' || item.role === 'assistant') && item.content)
      .map(item => ({ role: item.role, content: item.content }))
  },

  dismissPending(messages) {
    return messages.map(item => (
      item && item.pendingAction && item.pendingAction.state === 'pending'
        ? { ...item, pendingAction: { ...item.pendingAction, state: 'dismissed' } }
        : item
    ))
  },

  createMessage(role, content, extra) {
    this.messageSequence += 1
    return {
      id: `${Date.now()}-${this.messageSequence}`,
      role,
      content: content || '',
      sources: [],
      pendingAction: null,
      appliedAction: null,
      ...(extra || {})
    }
  },

  scrollTo(target) {
    wx.nextTick(() => {
      if (this.pageActive) this.setData({ scrollTarget: target })
    })
  }
})
