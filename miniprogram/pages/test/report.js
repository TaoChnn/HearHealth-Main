const LATEST_TEST_RESULT_KEY = 'latestHearingTestResult'
// 测试历史页查看某条旧记录时，会把完整结果暂存在这个 key（见 pages/profile/test-history.js）
const HISTORY_TEST_RESULT_KEY = 'historyHearingTestResult'
const COMMUNITY_SHARE_DRAFT_KEY = 'hearingReportShareDraft'
const { callUser } = require('../../utils/auth')
const { analyzeHearingTest } = require('../../utils/ai')
const { drawReportPoster } = require('../../utils/report-poster')

function readTestRecordId(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value).trim()
  } catch (error) {
    return ''
  }
}

Page({
  data: {
    hasResult: false,
    chartDrawFailed: false,
    completedAtText: '',
    earSummaries: [],
    navigating: false,
    shareLoading: false,
    aiStatus: 'idle',
    aiAnalysis: null,
    aiExpanded: false,
    aiErrorMessage: '',
    aiCanRetry: false
  },

  onLoad(options) {
    this.chartReady = false
    this.testRecordId = readTestRecordId(options && options.testRecordId)
    this.aiUnavailableReason = options && options.aiUnavailable
    // from=history：来自测试历史页，渲染指定的历史记录而不是最新一条
    this.fromHistory = Boolean(options && options.from === 'history')
    this.aiStarted = false
    this.loadLatestResult()
  },

  onReady() {
    this.chartReady = true
    if (this.data.hasResult) this.drawThresholdChart()
  },

  onShow() {
    if (this.data.navigating) this.setData({ navigating: false })
  },

  onUnload() {
    if (this.chartRetryTimer) {
      clearTimeout(this.chartRetryTimer)
      this.chartRetryTimer = null
    }
  },

  loadLatestResult() {
    // 历史模式：读取测试历史页暂存的指定记录；数据缺失时展示空态，不回退到最新记录
    if (this.fromHistory) {
      let record
      try {
        record = wx.getStorageSync(HISTORY_TEST_RESULT_KEY)
      } catch (error) {
        record = null
      }
      if (this.isValidResult(record)) this.renderResult(record)
      return
    }

    let result
    try {
      result = wx.getStorageSync(LATEST_TEST_RESULT_KEY)
    } catch (error) {
      result = null
    }

    if (this.isValidResult(result)) {
      this.renderResult(result)
      return
    }

    // 本地无有效结果时从云端兜底拉取（换设备场景）
    callUser('getLatestTestRecord')
      .then(cloudResult => {
        if (!this.isValidResult(cloudResult)) return
        try {
          wx.setStorageSync(LATEST_TEST_RESULT_KEY, cloudResult)
        } catch (error) {
          // 本地缓存失败不影响展示
        }
        this.renderResult(cloudResult)
      })
      .catch(() => {})
  },

  renderResult(result) {
    const leftSummary = this.buildEarSummary('left', '左耳', result.ears.left)
    const rightSummary = this.buildEarSummary('right', '右耳', result.ears.right)

    this.setData({
      hasResult: true,
      chartDrawFailed: false,
      completedAtText: this.formatCompletedAt(result.completedAt),
      earSummaries: [leftSummary, rightSummary]
    }, () => {
      if (this.chartReady) this.drawThresholdChart()
      this.startAiAnalysis()
    })
  },

  startAiAnalysis() {
    if (this.aiStarted || !this.data.hasResult) return
    this.aiStarted = true

    if (!this.testRecordId) {
      const reason = this.aiUnavailableReason
      this.setData({
        aiStatus: 'error',
        aiAnalysis: null,
        aiErrorMessage: reason === 'record-sync-failed'
          ? '测试记录暂未同步到云端，暂时无法生成 AI 解读'
          : reason === 'guest-mode'
            ? '游客模式下测试记录仅保存在本机，登录后完成测试即可生成 AI 解读'
            : '这份报告没有可用的云端记录标识，暂时无法生成 AI 解读',
        aiCanRetry: false
      })
      return
    }

    this.requestAiAnalysis()
  },

  requestAiAnalysis() {
    if (!this.testRecordId || this.data.aiStatus === 'loading') return
    this.setData({
      aiStatus: 'loading',
      aiAnalysis: null,
      aiExpanded: false,
      aiErrorMessage: '',
      aiCanRetry: false
    })

    analyzeHearingTest(this.testRecordId)
      .then(result => {
        if (!result || !result.analysis) throw new Error('missing analysis')
        this.setData({
          aiStatus: 'success',
          aiAnalysis: this.prepareAnalysisForView(result.analysis),
          aiErrorMessage: '',
          aiCanRetry: false
        })
      })
      .catch(error => {
        console.warn('[report] AI analysis failed', {
          code: error && error.code ? error.code : 'AI_REQUEST_FAILED'
        })
        this.setData({
          aiStatus: 'error',
          aiAnalysis: null,
          aiErrorMessage: this.getAiErrorMessage(error && error.code),
          aiCanRetry: true
        })
      })
  },

  retryAiAnalysis() {
    this.requestAiAnalysis()
  },

  toggleAiDetail() {
    this.setData({ aiExpanded: !this.data.aiExpanded })
  },

  getAiErrorMessage(code) {
    switch (code) {
      case 'CONFIG_MISSING':
        return 'AI 服务尚未完成配置，基础听力报告仍可正常查看'
      case 'RECORD_NOT_FOUND':
        return '没有找到对应的云端测试记录，暂时无法生成 AI 解读'
      case 'MODEL_INVALID_RESPONSE':
        return 'AI 返回内容未通过安全校验，请稍后重试'
      case 'CACHE_ERROR':
        return 'AI 分析缓存暂时不可用，请稍后重试'
      default:
        return 'AI 解读暂时不可用，请稍后重试'
    }
  },

  // 报告页只呈现最短的一层解读：一句结论 + 少量建议，
  // 更细的现象、双耳对比和局限折叠到「详情」里，避免整页被长文占满。
  prepareAnalysisForView(analysis) {
    const overview = this.clipText(this.cleanAiDisplayText(analysis.overview), 90)
    const findings = (Array.isArray(analysis.findings) ? analysis.findings : [])
      .map(item => ({
        title: this.clipText(this.cleanAiDisplayText(item && item.title), 30),
        explanation: this.cleanAiDisplayText(item && item.explanation)
      }))
      .filter(item => item.title || item.explanation)
      .slice(0, 2)
      .map((item, index) => ({ id: index, ...item }))
    const recommendations = (Array.isArray(analysis.recommendations) ? analysis.recommendations : [])
      .map(item => ({ text: this.clipText(this.cleanAiDisplayText(item && item.text), 44) }))
      .filter(item => item.text)
      .slice(0, 3)
      .map((item, index) => ({ id: index, ...item }))
    const redFlags = this.cleanAiDisplayList(analysis.redFlags)
      .map(item => this.clipText(item, 60))
      .slice(0, 1)
    const limitations = this.cleanAiDisplayList(analysis.limitations).slice(0, 2)
    const earComparison = {
      summary: this.cleanAiDisplayText(analysis.earComparison && analysis.earComparison.summary)
    }

    return {
      overview,
      findings,
      earComparison,
      recommendations,
      redFlags,
      limitations,
      hasDetail: findings.length > 0 || limitations.length > 0 || Boolean(earComparison.summary)
    }
  },

  clipText(value, max) {
    if (!value || value.length <= max) return value
    return `${value.slice(0, max).trim()}…`
  },

  cleanAiDisplayText(value) {
    if (typeof value !== 'string') return ''
    return value
      .replace(/\bdata(?:\.[A-Za-z_$][\w$]*)+\b/gi, '')
      .replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, '')
      .replace(/\b[a-z]{2,}(?:[A-Z][A-Za-z0-9]*)+\b/g, '')
      .replace(/\b(?:routine|monitor|professional-check|relative-gain-threshold)\b/gi, '')
      .replace(/^\s*[:：,，;；|/\\–—-]+\s*/g, '')
      .replace(/\s*[:：,，;；|/\\–—-]+\s*$/g, '')
      .trim()
  },

  cleanAiDisplayList(value) {
    if (!Array.isArray(value)) return []
    return value.map(this.cleanAiDisplayText).filter(Boolean)
  },

  isValidResult(result) {
    return Boolean(
      result &&
      result.measurement === 'relative-gain-threshold' &&
      result.ears &&
      Array.isArray(result.ears.left) &&
      result.ears.left.length === 6 &&
      Array.isArray(result.ears.right) &&
      result.ears.right.length === 6
    )
  },

  buildEarSummary(key, name, results) {
    const detectedResults = results.filter(item => this.isValidThreshold(item))
    const detectedCount = detectedResults.length
    const averageThreshold = detectedCount
      ? Math.round(
          detectedResults.reduce((total, item) => total + item.thresholdPercent, 0) /
          detectedCount
        )
      : null
    const level = this.getEarLevel(averageThreshold, detectedCount)

    return {
      key,
      name,
      detectedCount,
      levelKey: level.key,
      levelLabel: level.label,
      meterPercent: averageThreshold === null ? 100 : averageThreshold,
      detectedText: `${detectedCount} / 6`,
      averageText: averageThreshold === null ? '—' : `${averageThreshold}%`,
      results: results.map(item => {
        const detected = this.isValidThreshold(item)
        return {
          frequency: item.frequency,
          detected,
          thresholdPercent: detected ? item.thresholdPercent : null,
          thresholdText: detected ? `${item.thresholdPercent}%` : '未测得'
        }
      })
    }
  },

  // 阈值越低表示越早听到；只给出定性参考，不做听损分级
  getEarLevel(averageThreshold, detectedCount) {
    if (detectedCount === 0) return { key: 'notice', label: '未测得' }
    if (detectedCount < 6) return { key: 'notice', label: '建议复查' }
    if (averageThreshold <= 35) return { key: 'good', label: '较灵敏' }
    if (averageThreshold <= 65) return { key: 'watch', label: '一般' }
    return { key: 'notice', label: '建议复查' }
  },

  isValidThreshold(result) {
    return Boolean(
      result &&
      result.detected &&
      Number.isFinite(result.thresholdPercent) &&
      result.thresholdPercent >= 10 &&
      result.thresholdPercent <= 100
    )
  },

  formatCompletedAt(timestamp) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return '完成时间未知'

    const pad = value => String(value).padStart(2, '0')
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  },

  drawThresholdChart(attempt) {
    const currentAttempt = attempt || 0
    const query = this.createSelectorQuery()
    query
      .select('#thresholdChart')
      .fields({ node: true, size: true })
      .exec(result => {
        const canvasInfo = result && result[0]
        if (!canvasInfo || !canvasInfo.node || !canvasInfo.width || !canvasInfo.height) {
          this.retryThresholdChart(currentAttempt)
          return
        }

        try {
          this.renderThresholdChart(
            canvasInfo.node,
            canvasInfo.width,
            canvasInfo.height
          )
        } catch (error) {
          this.retryThresholdChart(currentAttempt)
        }
      })
  },

  // 画布随结果条件渲染，刚插入时节点可能还没完成布局；
  // 查询不到或绘制异常时延迟重试几次，仍失败才展示兜底文案
  retryThresholdChart(attempt) {
    if (this.chartRetryTimer) clearTimeout(this.chartRetryTimer)
    if (attempt >= 3 || !this.data.hasResult) {
      if (this.data.hasResult) this.setData({ chartDrawFailed: true })
      return
    }
    this.chartRetryTimer = setTimeout(() => {
      this.chartRetryTimer = null
      this.drawThresholdChart(attempt + 1)
    }, 200)
  },

  renderThresholdChart(canvas, width, height) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2d context unavailable')

    const pixelRatio = this.getDevicePixelRatio()
    canvas.width = width * pixelRatio
    canvas.height = height * pixelRatio
    context.scale(pixelRatio, pixelRatio)
    context.clearRect(0, 0, width, height)

    const plot = {
      left: 44,
      right: width - 12,
      top: 12,
      bottom: height - 34
    }
    const frequencies = [125, 250, 500, 1000, 2000, 4000]
    const gridLevels = [10, 30, 50, 70, 90, 100]
    const xForIndex = index => (
      plot.left + ((plot.right - plot.left) * index / (frequencies.length - 1))
    )
    const yForLevel = level => (
      plot.top + ((plot.bottom - plot.top) * (level - 10) / 90)
    )

    this.drawChartGrid(context, plot, frequencies, gridLevels, xForIndex, yForLevel)
    this.drawChartSeries(context, this.data.earSummaries[0].results, '#0066cc', xForIndex, yForLevel)
    this.drawChartSeries(context, this.data.earSummaries[1].results, '#34c759', xForIndex, yForLevel)
  },

  drawChartGrid(context, plot, frequencies, levels, xForIndex, yForLevel) {
    context.font = '10px sans-serif'
    context.textBaseline = 'middle'
    context.lineWidth = 1

    levels.forEach(level => {
      const y = yForLevel(level)
      context.beginPath()
      context.moveTo(plot.left, y)
      context.lineTo(plot.right, y)
      context.strokeStyle = '#f0f0f0'
      context.stroke()

      context.fillStyle = '#7a7a7a'
      context.textAlign = 'right'
      context.fillText(`${level}%`, plot.left - 6, y)
    })

    frequencies.forEach((frequency, index) => {
      const x = xForIndex(index)
      context.beginPath()
      context.moveTo(x, plot.top)
      context.lineTo(x, plot.bottom)
      context.strokeStyle = '#f0f0f0'
      context.stroke()

      context.fillStyle = '#7a7a7a'
      context.textAlign = 'center'
      context.textBaseline = 'top'
      const label = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
      context.fillText(label, x, plot.bottom + 8)
    })
  },

  drawChartSeries(context, results, color, xForIndex, yForLevel) {
    let previousPoint = null

    results.forEach((result, index) => {
      const hasPoint = result.detected && Number.isFinite(result.thresholdPercent)
      if (!hasPoint) {
        previousPoint = null
        return
      }

      const point = {
        x: xForIndex(index),
        y: yForLevel(result.thresholdPercent)
      }

      if (previousPoint) {
        context.beginPath()
        context.moveTo(previousPoint.x, previousPoint.y)
        context.lineTo(point.x, point.y)
        context.strokeStyle = color
        context.lineWidth = 2
        context.stroke()
      }

      context.beginPath()
      context.arc(point.x, point.y, 4, 0, Math.PI * 2)
      context.fillStyle = color
      context.fill()
      context.strokeStyle = '#ffffff'
      context.lineWidth = 2
      context.stroke()

      previousPoint = point
    })
  },

  getDevicePixelRatio() {
    try {
      if (typeof wx.getWindowInfo === 'function') {
        return wx.getWindowInfo().pixelRatio || 1
      }
    } catch (error) {
      // 无法读取设备像素比时使用 1，图表内容仍可正常展示。
    }
    return 1
  },

  startTest() {
    if (this.data.navigating) return

    this.setData({ navigating: true })
    wx.reLaunch({
      url: '/pages/test/guide',
      fail: () => this.handleNavigationFailure('暂时无法开始测试')
    })
  },

  // 分享到耳友圈：先把整份报告画成一张长图，再把长图作为帖子图片带过去
  shareToCommunity() {
    if (!this.data.hasResult || this.data.navigating || this.data.shareLoading) return

    this.setData({ shareLoading: true })
    wx.showLoading({ title: '生成长图…', mask: true })

    this.createSharePoster()
      .then(filePath => {
        wx.hideLoading()
        this.setData({ shareLoading: false })

        const draft = this.buildCommunityShareDraft(filePath)
        try {
          wx.setStorageSync(COMMUNITY_SHARE_DRAFT_KEY, draft)
        } catch (error) {
          wx.showToast({ title: '生成分享内容失败，请重试', icon: 'none' })
          return
        }

        this.setData({ navigating: true })
        wx.navigateTo({
          url: '/pages/community/publish?source=hearing-report',
          fail: () => this.handleNavigationFailure('暂时无法进入发布页')
        })
      })
      .catch(error => {
        wx.hideLoading()
        this.setData({ shareLoading: false })
        console.warn('[report] share poster failed', error)
        wx.showToast({ title: '长图生成失败，请重试', icon: 'none' })
      })
  },

  createSharePoster() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .select('#shareCanvas')
        .fields({ node: true, size: true })
        .exec(result => {
          const canvasInfo = result && result[0]
          if (!canvasInfo || !canvasInfo.node) {
            reject(new Error('share canvas unavailable'))
            return
          }

          let size
          try {
            size = drawReportPoster(canvasInfo.node, {
              pixelRatio: this.getDevicePixelRatio(),
              completedAtText: this.data.completedAtText,
              earSummaries: this.data.earSummaries,
              aiAnalysis: this.data.aiStatus === 'success' ? this.data.aiAnalysis : null
            })
          } catch (error) {
            reject(error)
            return
          }

          wx.canvasToTempFilePath({
            canvas: canvasInfo.node,
            fileType: 'jpg',
            quality: 0.92,
            destWidth: size.width * 2,
            destHeight: size.height * 2,
            success: response => resolve(response.tempFilePath),
            fail: reject
          })
        })
    })
  },

  buildCommunityShareDraft(imagePath) {
    const summary = this.data.earSummaries
      .map(item => `${item.name} ${item.averageText}`)
      .join(' · ')

    return {
      source: 'hearing-report',
      tag: 'report',
      content: `我完成了一次听力筛查：${summary}。完整结果见长图。`,
      imagePath,
      createdAt: Date.now()
    }
  },

  returnHome() {
    if (this.data.navigating) return

    this.setData({ navigating: true })
    wx.switchTab({
      url: '/pages/home/home',
      fail: () => this.handleNavigationFailure('暂时无法返回首页')
    })
  },

  handleNavigationFailure(message) {
    this.setData({ navigating: false })
    wx.showToast({ title: message, icon: 'none' })
  }
})
