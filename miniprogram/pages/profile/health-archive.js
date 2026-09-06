// 健康档案主页
//
// 存在的理由：Agent 会往档案里写入内容。如果用户看不见自己档案里到底有什么，
// 就不会信任它写入的东西；如果看不到，也就无从纠正 AI 记错的内容。
// 因此凡是 Agent 能写的（健康日志、AI 记忆），这里必须能看、能加、能删。
// 听力测试与用耳记录属于原始测量数据，Agent 只读不改，这里只做展示与跳转。
const { callUser, isLoggedIn } = require('../../utils/auth')

const LOGIN_URL = '/pages/splash/splash?redirect=/pages/profile/health-archive'
const STATUS_TEXT = {
  normal: '在阈值内',
  warning: '接近阈值',
  danger: '超出阈值'
}
const NOTE_TYPES = [
  { value: 'symptom', label: '症状' },
  { value: 'medication', label: '用药' },
  { value: 'visit', label: '就医' },
  { value: 'habit', label: '习惯' },
  { value: 'note', label: '备注' }
]
const MAX_NOTE_LENGTH = 200

function earText(detected, average) {
  if (!detected) return '未测得'
  return `测得 ${detected}/6 · 均值 ${average}%`
}

function normalizeArchive(data) {
  const source = data && typeof data === 'object' ? data : {}
  const completeness = source.completeness && typeof source.completeness === 'object'
    ? source.completeness
    : { percent: 0, items: [], missing: [] }
  const profile = source.profile && typeof source.profile === 'object'
    ? source.profile
    : { deviceModel: '', reminderThreshold: 2, testCount: 0 }
  const usage = source.usage && typeof source.usage === 'object' ? source.usage : {}

  const percent = Number(completeness.percent) || 0
  return {
    completeness: {
      percent,
      items: Array.isArray(completeness.items) ? completeness.items : [],
      missingText: Array.isArray(completeness.missing) ? completeness.missing.join('、') : ''
    },
    // 进度条宽度整体在 JS 里拼好：wxml 里写 width: {{percent}}% 会被样式检查误报
    progressStyle: `width: ${percent}%;`,
    profile,
    tests: (Array.isArray(source.tests) ? source.tests : []).map(item => ({
      id: item.id,
      occurredAtText: item.occurredAtText || '时间未知',
      leftText: earText(item.leftDetected, item.leftAverage),
      rightText: earText(item.rightDetected, item.rightAverage)
    })),
    notes: Array.isArray(source.notes) ? source.notes : [],
    memory: Array.isArray(source.memory) ? source.memory : [],
    usage: {
      weekly: usage.weekly ? { ...usage.weekly, statusText: STATUS_TEXT[usage.weekly.status] || '在阈值内' } : null,
      monthly: usage.monthly ? { ...usage.monthly, statusText: STATUS_TEXT[usage.monthly.status] || '在阈值内' } : null
    }
  }
}

Page({
  data: {
    loading: true,
    loggedIn: false,
    completeness: { percent: 0, items: [], missingText: '' },
    progressStyle: 'width: 0%;',
    profile: { deviceModel: '', reminderThreshold: 2, testCount: 0 },
    tests: [],
    notes: [],
    memory: [],
    usage: { weekly: null, monthly: null },
    noteTypes: NOTE_TYPES,
    noteTypeIndex: 0,
    noteContent: '',
    saving: false
  },

  onShow() {
    this.setData({ loggedIn: isLoggedIn() })
    this.loadArchive()
  },

  loadArchive() {
    this.setData({ loading: true })
    callUser('getHealthArchive')
      .then(data => {
        this.setData({ loading: false, ...normalizeArchive(data) })
      })
      .catch(() => {
        // 拉不到就展示空档案，不把整页打死
        this.setData({ loading: false, ...normalizeArchive(null) })
      })
  },

  onNoteTypeChange(event) {
    this.setData({ noteTypeIndex: Number(event.detail.value) || 0 })
  },

  onNoteInput(event) {
    this.setData({ noteContent: event.detail.value || '' })
  },

  onSaveNote() {
    const type = (NOTE_TYPES[this.data.noteTypeIndex] || NOTE_TYPES[0]).value
    const content = String(this.data.noteContent || '').trim().slice(0, MAX_NOTE_LENGTH)
    if (!content || this.data.saving) return

    this.setData({ saving: true })
    // 日志类型必须用 noteType：callUser 会把 data 展开到 { type, ...data } 上，
    // 传 type 会把云函数的分发字段覆盖掉
    callUser('addHealthNote', { noteType: type, content, occurredAt: Date.now() })
      .then(() => {
        this.setData({ saving: false, noteContent: '' })
        wx.showToast({ title: '已记录', icon: 'none' })
        this.loadArchive()
      })
      .catch(() => {
        this.setData({ saving: false })
        wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      })
  },

  // 删除一律先确认：档案内容一旦丢失无法找回，误删的代价远高于多一次点击
  onDeleteNote(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '删除这条记录？',
      content: '删除后无法恢复。',
      confirmColor: '#ff3b30',
      success: res => {
        if (!res.confirm) return
        callUser('removeHealthNote', { id })
          .then(() => this.loadArchive())
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  },

  onDeleteMemory(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '删除这条记忆？',
      content: 'AI 以后不会再参考这条信息。',
      confirmColor: '#ff3b30',
      success: res => {
        if (!res.confirm) return
        callUser('removeAgentMemory', { id })
          .then(() => this.loadArchive())
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  },

  // 只清健康日志与 AI 记忆；听力测试和用耳记录是原始测量数据，不在这里动
  onClearArchive() {
    wx.showModal({
      title: '清空健康日志与 AI 记忆？',
      content: '听力测试与用耳记录会保留，仅清空日志与记忆，且无法恢复。',
      confirmColor: '#ff3b30',
      success: res => {
        if (!res.confirm) return
        callUser('clearHealthArchive')
          .then(() => {
            wx.showToast({ title: '已清空', icon: 'none' })
            this.loadArchive()
          })
          .catch(() => wx.showToast({ title: '清空失败', icon: 'none' }))
      }
    })
  },

  goTestHistory() {
    wx.navigateTo({ url: '/pages/profile/test-history' })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/profile/settings' })
  },

  goAiChat() {
    wx.navigateTo({ url: '/pages/ai-chat/ai-chat' })
  },

  onLoginTap() {
    wx.navigateTo({ url: LOGIN_URL })
  }
})
