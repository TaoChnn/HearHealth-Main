// 开屏页 —— 微信授权登录入口
// 已登录（本地有会话）直接进首页；首次未登录停留在本页，
// 由用户点击一键登录进入，或跳过以游客身份浏览。
const { ensureLogin, isLoggedIn } = require('../../utils/auth')

// 开屏最小展示时长（毫秒）：保证品牌画面可被看清，再进入首页
const MIN_SPLASH_MS = 2000

Page({
  data: {
    loggingIn: false,
    errorMsg: ''
  },

  onLoad() {
    this.hasNavigated = false
    this.loadedAt = Date.now()
    if (isLoggedIn()) {
      this.enterApp()
    }
    // 未登录：停留本页展示一键登录按钮，由用户手动登录或跳过
  },

  performLogin() {
    if (this.data.loggingIn || this.hasNavigated) return
    this.setData({ loggingIn: true, errorMsg: '' })

    ensureLogin()
      .then(() => {
        // 手动登录：先给一个成功反馈，再进入首页
        wx.showToast({ title: '登录成功', icon: 'success', duration: 600 })
        setTimeout(() => this.enterApp(), 400)
      })
      .catch(error => {
        console.error('[splash] 登录失败：', error)
        const detail = (error && error.message) || '网络异常，请稍后重试'
        this.setData({ errorMsg: `登录失败：${detail}` })
      })
      .finally(() => {
        this.setData({ loggingIn: false })
      })
  },

  enterApp() {
    if (this.hasNavigated) return
    this.hasNavigated = true
    // 保证开屏至少展示 MIN_SPLASH_MS，已展示够则立即进入
    const elapsed = Date.now() - (this.loadedAt || 0)
    const delay = Math.max(0, MIN_SPLASH_MS - elapsed)
    setTimeout(() => {
      wx.switchTab({ url: '/pages/home/home' })
    }, delay)
  },

  onLoginTap() {
    this.performLogin()
  },

  onSkipTap() {
    // 跳过登录：以游客身份进入，之后可在“我的”页面补登录
    this.enterApp()
  }
})
