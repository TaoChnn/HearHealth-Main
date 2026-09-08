/**
 * 听力报告长图
 * 把报告页的结论、频率曲线和 AI 解读按同样的排版绘制成一张竖版长图，
 * 供「分享到耳友圈」使用。画布宽度固定 750（设计像素），高度按内容计算。
 */

const WIDTH = 750
const PAD = 56
const CARD_PAD = 28
const BOX_GAP = 20
const EAR_BOX_H = 200
const CHART_H = 300
// 量文字高度时先按最大高度开画布，量完再按真实高度重画
const MAX_HEIGHT = 2600

const COLOR = {
  ink: '#1d1d1f',
  body: '#333333',
  muted: '#7a7a7a',
  primary: '#0066cc',
  primarySoft: 'rgba(0, 102, 204, 0.09)',
  canvas: '#ffffff',
  pearl: '#fafafc',
  track: '#ececec',
  bg: '#f5f5f7',
  hairline: '#f0f0f0',
  left: '#0066cc',
  right: '#34c759'
}

const LEVEL = {
  good: { bg: 'rgba(52, 199, 89, 0.16)', fg: '#248a3d', bar: '#34c759' },
  watch: { bg: 'rgba(255, 204, 0, 0.22)', fg: '#8a6d00', bar: '#ffcc00' },
  notice: { bg: 'rgba(255, 59, 48, 0.12)', fg: '#d70015', bar: '#ff3b30' }
}

const FONT_SANS = 'sans-serif'

function font(size, weight) {
  return `${weight ? `${weight} ` : ''}${size}px ${FONT_SANS}`
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []

  const lines = []
  let line = ''
  source.split('').forEach(char => {
    const next = line + char
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = char
    } else {
      line = next
    }
  })
  if (line) lines.push(line)

  if (maxLines && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, -1)}…`
    return kept
  }
  return lines
}

function measureLines(ctx, text, style, maxWidth, maxLines) {
  ctx.font = style
  return wrapText(ctx, text, maxWidth, maxLines)
}

function buildLayout(ctx, data) {
  const cardW = WIDTH - PAD * 2
  const innerW = cardW - CARD_PAD * 2
  const ai = data.aiAnalysis
  const hasAi = Boolean(ai && (ai.overview || (ai.recommendations && ai.recommendations.length)))

  const overviewLines = hasAi && ai.overview
    ? measureLines(ctx, ai.overview, font(28), innerW, 3)
    : []
  const tips = hasAi && Array.isArray(ai.recommendations)
    ? ai.recommendations.slice(0, 3)
    : []
  const tipLines = tips.map(tip => measureLines(ctx, tip.text, font(26), innerW - 30, 2))

  const heroH = CARD_PAD + EAR_BOX_H + 20 + 26 + CARD_PAD
  const chartCardH = CARD_PAD + 36 + 16 + CHART_H + 24 + CARD_PAD
  const aiH = hasAi
    ? CARD_PAD + 48 + 24 + overviewLines.length * 42 + (tipLines.length ? 16 : 0) +
      tipLines.reduce((total, lines) => total + lines.length * 38 + 12, 0) + CARD_PAD
    : 0

  let cursor = 56
  const titleY = cursor + 44
  cursor = titleY + 44

  const heroY = cursor
  cursor = heroY + heroH + 24

  const chartY = cursor
  cursor = chartY + chartCardH + 24

  let aiY = 0
  if (hasAi) {
    aiY = cursor
    cursor = aiY + aiH + 24
  }

  const footerY = cursor + 12
  const height = footerY + 66 + 40

  return {
    height,
    cardW,
    innerW,
    titleY,
    heroY,
    heroH,
    boxW: (cardW - CARD_PAD * 2 - BOX_GAP) / 2,
    chartY,
    chartCardH,
    aiY,
    aiH,
    hasAi,
    overviewLines,
    tips,
    tipLines,
    footerY
  }
}

function drawCard(ctx, x, y, width, height) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.06)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 4
  ctx.fillStyle = COLOR.canvas
  roundRect(ctx, x, y, width, height, 28)
  ctx.fill()
  ctx.restore()
}

function drawEarBox(ctx, box, summary) {
  const theme = LEVEL[summary.levelKey] || LEVEL.watch

  ctx.fillStyle = COLOR.pearl
  roundRect(ctx, box.x, box.y, box.w, EAR_BOX_H, 20)
  ctx.fill()

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR.body
  ctx.font = font(26, 600)
  ctx.fillText(summary.name, box.x + 24, box.y + 50)

  // 右上角定性标签
  ctx.font = font(22, 600)
  const pillW = ctx.measureText(summary.levelLabel).width + 28
  const pillX = box.x + box.w - 24 - pillW
  ctx.fillStyle = theme.bg
  roundRect(ctx, pillX, box.y + 28, pillW, 38, 19)
  ctx.fill()
  ctx.fillStyle = theme.fg
  ctx.textBaseline = 'middle'
  ctx.fillText(summary.levelLabel, pillX + 14, box.y + 47)

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR.ink
  ctx.font = font(54, 700)
  ctx.fillText(summary.averageText, box.x + 24, box.y + 116)

  // 相对阈值条
  const trackY = box.y + 134
  ctx.fillStyle = COLOR.track
  roundRect(ctx, box.x + 24, trackY, box.w - 48, 10, 5)
  ctx.fill()
  ctx.fillStyle = theme.bar
  const fillW = Math.max(10, ((box.w - 48) * Number(summary.meterPercent || 0)) / 100)
  roundRect(ctx, box.x + 24, trackY, fillW, 10, 5)
  ctx.fill()

  ctx.fillStyle = COLOR.muted
  ctx.font = font(20)
  ctx.fillText(`平均相对阈值 · 测得 ${summary.detectedText}`, box.x + 24, box.y + 172)
}

function drawChart(ctx, x, y, width, height, earSummaries) {
  const plot = {
    left: x + 56,
    right: x + width - 16,
    top: y + 16,
    bottom: y + height - 40
  }
  const frequencies = [125, 250, 500, 1000, 2000, 4000]
  const gridLevels = [10, 30, 50, 70, 90, 100]
  const xForIndex = index => plot.left + ((plot.right - plot.left) * index) / (frequencies.length - 1)
  const yForLevel = level => plot.top + ((plot.bottom - plot.top) * (level - 10)) / 90

  ctx.lineWidth = 1
  ctx.font = font(20)
  ctx.textBaseline = 'middle'
  gridLevels.forEach(level => {
    const lineY = yForLevel(level)
    ctx.beginPath()
    ctx.moveTo(plot.left, lineY)
    ctx.lineTo(plot.right, lineY)
    ctx.strokeStyle = COLOR.hairline
    ctx.stroke()

    ctx.fillStyle = COLOR.muted
    ctx.textAlign = 'right'
    ctx.fillText(`${level}%`, plot.left - 12, lineY)
  })

  ctx.textBaseline = 'top'
  frequencies.forEach((frequency, index) => {
    const lineX = xForIndex(index)
    ctx.beginPath()
    ctx.moveTo(lineX, plot.top)
    ctx.lineTo(lineX, plot.bottom)
    ctx.strokeStyle = COLOR.hairline
    ctx.stroke()

    ctx.fillStyle = COLOR.muted
    ctx.textAlign = 'center'
    ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : String(frequency), lineX, plot.bottom + 12)
  })

  const series = [
    { results: earSummaries[0] && earSummaries[0].results, color: COLOR.left },
    { results: earSummaries[1] && earSummaries[1].results, color: COLOR.right }
  ]

  series.forEach(item => {
    if (!Array.isArray(item.results)) return
    let previous = null
    item.results.forEach((result, index) => {
      if (!result.detected || !Number.isFinite(result.thresholdPercent)) {
        previous = null
        return
      }
      const point = { x: xForIndex(index), y: yForLevel(result.thresholdPercent) }
      if (previous) {
        ctx.beginPath()
        ctx.moveTo(previous.x, previous.y)
        ctx.lineTo(point.x, point.y)
        ctx.strokeStyle = item.color
        ctx.lineWidth = 4
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(point.x, point.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = item.color
      ctx.fill()
      ctx.strokeStyle = COLOR.canvas
      ctx.lineWidth = 3
      ctx.stroke()
      previous = point
    })
  })
}

function drawLegend(ctx, rightX, centerY) {
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = font(24)

  let x = rightX
  const right = '右耳'
  const left = '左耳'

  x -= ctx.measureText(right).width
  ctx.fillStyle = COLOR.muted
  ctx.fillText(right, x, centerY)
  x -= 14
  ctx.beginPath()
  ctx.arc(x, centerY, 8, 0, Math.PI * 2)
  ctx.fillStyle = COLOR.right
  ctx.fill()

  x -= 36 + ctx.measureText(left).width
  ctx.fillStyle = COLOR.muted
  ctx.fillText(left, x, centerY)
  x -= 14
  ctx.beginPath()
  ctx.arc(x, centerY, 8, 0, Math.PI * 2)
  ctx.fillStyle = COLOR.left
  ctx.fill()
}

function paint(ctx, data, plan) {
  ctx.fillStyle = COLOR.bg
  ctx.fillRect(0, 0, WIDTH, plan.height)

  // 标题 + 完成时间
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = COLOR.ink
  ctx.font = font(46, 700)
  ctx.fillText('听力报告', PAD, plan.titleY)

  ctx.textAlign = 'right'
  ctx.fillStyle = COLOR.muted
  ctx.font = font(24)
  ctx.fillText(data.completedAtText || '', WIDTH - PAD, plan.titleY)

  // 结论卡
  drawCard(ctx, PAD, plan.heroY, plan.cardW, plan.heroH)
  const boxY = plan.heroY + CARD_PAD
  const summaries = Array.isArray(data.earSummaries) ? data.earSummaries : []
  summaries.slice(0, 2).forEach((summary, index) => {
    drawEarBox(ctx, {
      x: PAD + CARD_PAD + index * (plan.boxW + BOX_GAP),
      y: boxY,
      w: plan.boxW
    }, summary)
  })

  ctx.textAlign = 'left'
  ctx.fillStyle = COLOR.muted
  ctx.font = font(22)
  ctx.fillText('百分比越小，表示耳朵状况良好', PAD + CARD_PAD, plan.heroY + CARD_PAD + EAR_BOX_H + 42)

  // 频率曲线卡
  drawCard(ctx, PAD, plan.chartY, plan.cardW, plan.chartCardH)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR.ink
  ctx.font = font(28, 700)
  ctx.fillText('频率表现', PAD + CARD_PAD, plan.chartY + CARD_PAD + 28)
  drawLegend(ctx, PAD + plan.cardW - CARD_PAD, plan.chartY + CARD_PAD + 20)
  drawChart(
    ctx,
    PAD + CARD_PAD,
    plan.chartY + CARD_PAD + 52,
    plan.cardW - CARD_PAD * 2,
    CHART_H,
    summaries
  )

  // AI 解读卡
  if (plan.hasAi) {
    drawCard(ctx, PAD, plan.aiY, plan.cardW, plan.aiH)

    let cursor = plan.aiY + CARD_PAD
    ctx.fillStyle = COLOR.primarySoft
    roundRect(ctx, PAD + CARD_PAD, cursor + 6, 52, 52, 16)
    ctx.fill()
    ctx.fillStyle = COLOR.primary
    ctx.font = font(22, 700)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('AI', PAD + CARD_PAD + 26, cursor + 32)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = COLOR.ink
    ctx.font = font(28, 700)
    ctx.fillText('结果解读', PAD + CARD_PAD + 68, cursor + 40)
    cursor += 48 + 24

    ctx.fillStyle = COLOR.body
    ctx.font = font(28)
    plan.overviewLines.forEach(line => {
      ctx.fillText(line, PAD + CARD_PAD, cursor + 28)
      cursor += 42
    })

    cursor += 16
    plan.tips.forEach((tip, index) => {
      ctx.fillStyle = COLOR.primary
      ctx.beginPath()
      ctx.arc(PAD + CARD_PAD + 6, cursor + 16, 6, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = COLOR.body
      ctx.font = font(26)
      plan.tipLines[index].forEach(line => {
        ctx.fillText(line, PAD + CARD_PAD + 30, cursor + 26)
        cursor += 38
      })
      cursor += 12
    })
  }

  // 页脚
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR.muted
  ctx.font = font(20)
  ctx.fillText('结果为固定音量下的相对增益，与 AI 解读均不构成医学诊断。', PAD, plan.footerY + 28)
  ctx.textAlign = 'right'
  ctx.fillText('HearHealth · 用耳健康', WIDTH - PAD, plan.footerY + 28)
}

function drawReportPoster(canvas, options) {
  const data = options || {}
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  const ratio = data.pixelRatio || 1

  canvas.width = WIDTH * ratio
  canvas.height = MAX_HEIGHT * ratio
  ctx.scale(ratio, ratio)
  const plan = buildLayout(ctx, data)

  // 重设尺寸会清空画布并重置变换，量完高度后再正式绘制
  canvas.width = WIDTH * ratio
  canvas.height = plan.height * ratio
  ctx.scale(ratio, ratio)
  paint(ctx, data, plan)

  return { width: WIDTH, height: plan.height }
}

module.exports = {
  WIDTH,
  drawReportPoster
}
