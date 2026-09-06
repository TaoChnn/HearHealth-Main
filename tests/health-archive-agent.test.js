const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const projectRoot = path.resolve(__dirname, '..')
const archive = require('../cloudfunctions/aiFunctions/archive')
const tools = require('../cloudfunctions/aiFunctions/tools')

const FREQUENCIES = [125, 250, 500, 1000, 2000, 4000]

// 同一文件里多个测试都要挂载同一个页面：不清缓存的话第二次 require 拿到的是模块缓存，
// global.Page 不会再被调用，definition 会是 undefined
function loadPage(relativePath) {
  const modulePath = require.resolve(relativePath)
  delete require.cache[modulePath]
  require(relativePath)
}

function mountPage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = function setData(patch, callback) {
    Object.keys(patch).forEach(key => {
      // 支持 messages[0].pendingAction.state 这类路径
      const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      for (let i = 0; i < segments.length - 1; i += 1) {
        target = target[segments[i]]
      }
      target[segments[segments.length - 1]] = patch[key]
    })
    if (typeof callback === 'function') callback()
  }
  return page
}

function buildTest(completedAt, left, right) {
  const toEar = values => values.map((value, index) => ({
    frequency: FREQUENCIES[index],
    detected: value !== null,
    thresholdPercent: value
  }))
  return {
    _id: `test-${completedAt}`,
    completedAt: new Date(completedAt),
    detectedLeft: left.filter(value => value !== null).length,
    detectedRight: right.filter(value => value !== null).length,
    ears: { left: toEar(left), right: toEar(right) }
  }
}

function buildArchiveFixture() {
  const now = Date.now()
  const previous = buildTest(now - 30 * 86400000, [40, 35, 30, 28, 35, 40], [38, 32, 30, 30, 38, 50])
  const latest = buildTest(now, [42, 36, 31, 29, 36, 55], [39, 33, 30, 30, 38, 60])
  const tests = [previous, latest]
  const notes = [{
    id: 'n1',
    type: 'symptom',
    typeLabel: '症状',
    content: '左耳轻微耳鸣，持续两天',
    occurredAt: now,
    occurredAtText: '2026-08-30',
    source: 'agent'
  }]
  const usageRows = [{ dateKey: archive.dateKeyOf(now), seconds: 7200, hpCount: 2, hpSum: 136, hpMax: 82 }]

  return {
    profile: { deviceModel: 'AirPods Pro', reminderThreshold: 2, testCount: 2 },
    tests: tests.map(item => ({
      id: item._id,
      completedAt: item.completedAt.getTime(),
      detectedLeft: item.detectedLeft,
      detectedRight: item.detectedRight,
      left: archive.earThresholdMap(item.ears.left),
      right: archive.earThresholdMap(item.ears.right)
    })),
    trend: archive.buildTrend(tests),
    usage: {
      weekly: archive.summarizeUsage(usageRows, 7, 2),
      monthly: archive.summarizeUsage(usageRows, 30, 2)
    },
    notes,
    memory: [{
      id: 'm1',
      kind: 'fact',
      kindLabel: '长期情况',
      content: '通勤坐地铁，环境噪声大',
      createdAt: now,
      createdAtText: '2026-08-28'
    }],
    completeness: archive.buildCompleteness({
      profile: { deviceModel: 'AirPods Pro' },
      tests,
      notes,
      usage: { totalSeconds: 7200 }
    }),
    builtAt: now
  }
}

test('健康档案页面已注册到小程序路由', () => {
  const appConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'miniprogram/app.json'), 'utf8')
  )
  assert.equal(appConfig.pages.includes('pages/profile/health-archive'), true)
})

test('个人中心的健康档案入口指向已注册页面', () => {
  let profilePage
  global.wx = {
    getStorageSync() {
      return null
    }
  }
  global.Page = definition => {
    profilePage = definition
  }

  require('../miniprogram/pages/profile/profile')

  const menuItems = profilePage.data.menuGroups.flatMap(group => group.items)
  const archiveItem = menuItems.find(item => item.id === 'health-archive')

  assert.ok(archiveItem)
  assert.equal(archiveItem.url, '/pages/profile/health-archive')

  delete global.Page
  delete global.wx
})

test('趋势计算：阈值升高记为表现下降，并单独标出明显变化的频点', () => {
  const previous = buildTest(Date.now() - 86400000, [40, 35, 30, 28, 35, 40], [40, 35, 30, 28, 35, 40])
  const latest = buildTest(Date.now(), [42, 36, 31, 29, 36, 55], [40, 35, 30, 28, 35, 40])
  const trend = archive.buildTrend([previous, latest])

  assert.equal(trend.changes.length, FREQUENCIES.length)

  const at4000 = trend.changes.find(change => change.frequency === 4000)
  assert.equal(at4000.leftDelta, 15)
  assert.equal(at4000.rightDelta, 0)

  // 只有 4000Hz 左耳变化达到 15 个百分点，其余都算正常波动
  assert.equal(trend.notable.length, 1)
  assert.equal(trend.notable[0].frequency, 4000)
  assert.equal(trend.latest.leftAverage, 38)
})

test('用耳汇总：没有记录的日期按 0 计入，避免把日均算高', () => {
  const now = Date.now()
  const rows = [{ dateKey: archive.dateKeyOf(now), seconds: 7200 }]
  const summary = archive.summarizeUsage(rows, 7, 2)

  assert.equal(summary.windowDays, 7)
  assert.equal(summary.avgSeconds, Math.round(7200 / 7))
  assert.equal(summary.status, 'normal')

  // 单日用满 4 小时、阈值 2 小时 → 日均 4/7 小时仍在阈值内，说明分母用的是窗口天数
  const heavy = [{ dateKey: archive.dateKeyOf(now), seconds: 14400 }]
  assert.equal(archive.summarizeUsage(heavy, 7, 2).status, 'normal')
})

test('档案完整度：缺就医与用药记录时明确列出', () => {
  const completeness = archive.buildCompleteness({
    profile: { deviceModel: '' },
    tests: [buildTest(Date.now(), [40, 35, 30, 28, 35, 40], [40, 35, 30, 28, 35, 40])],
    notes: [{ type: 'symptom' }],
    usage: { totalSeconds: 0 }
  })

  assert.ok(completeness.missing.includes('就医或用药记录'))
  assert.ok(completeness.missing.includes('耳机型号'))
  assert.ok(completeness.percent < 50)
})

test('档案快照覆盖测试、用耳、日志与记忆四类内容', () => {
  const snapshot = archive.formatSnapshot(buildArchiveFixture())

  assert.ok(snapshot.includes('最近一次测试'))
  assert.ok(snapshot.includes('与上一次测试'))
  assert.ok(snapshot.includes('用耳行为'))
  assert.ok(snapshot.includes('健康日志'))
  assert.ok(snapshot.includes('左耳轻微耳鸣'))
  assert.ok(snapshot.includes('已记住的事'))
  assert.ok(snapshot.includes('通勤坐地铁'))
})

test('写入工具默认只提议不落库，确认后才写入并带上撤销信息', async () => {
  const writeToolNames = tools.TOOLS
    .filter(tool => tool.requiresConfirm)
    .map(tool => tool.name)
    .sort()
  assert.deepEqual(writeToolNames, ['add_health_note', 'save_agent_memory', 'update_reminder_setting'])

  let addedNotes = 0
  const store = {
    addNote: async () => {
      addedNotes += 1
      return {
        id: 'n1',
        type: 'symptom',
        typeLabel: '症状',
        content: '左耳耳鸣三天',
        occurredAt: Date.now()
      }
    }
  }

  const pending = tools.describePendingAction('add_health_note', {
    type: 'symptom',
    content: '左耳耳鸣三天'
  })

  // 只生成待确认卡片时不应该碰数据库
  assert.ok(pending)
  assert.equal(addedNotes, 0)

  const result = await tools.findTool('add_health_note').run({ store, openid: 'user-1' }, pending.args)

  assert.equal(addedNotes, 1)
  assert.deepEqual(result.undo, { type: 'removeNote', id: 'n1' })
})

test('客户端回传的非法写入参数在落库前被拦下', () => {
  assert.equal(tools.validateWriteArgs('add_health_note', { type: 'diagnosis', content: '中耳炎' }), null)
  assert.equal(tools.validateWriteArgs('add_health_note', { type: 'symptom', content: '   ' }), null)
  assert.equal(tools.validateWriteArgs('add_health_note', 'not-an-object'), null)
  assert.equal(tools.validateWriteArgs('save_agent_memory', { kind: 'guess', content: 'x' }), null)
  assert.equal(tools.validateWriteArgs('update_reminder_setting', { reminderThreshold: 9 }), null)
  assert.equal(tools.validateWriteArgs('unknown_tool', {}), null)

  assert.deepEqual(
    tools.validateWriteArgs('update_reminder_setting', { reminderThreshold: 3 }),
    { reminderThreshold: 3 }
  )
  // 待确认卡片同样不接受非法参数
  assert.equal(tools.describePendingAction('update_reminder_setting', { reminderThreshold: 9 }), null)
})

test('待确认卡片只暴露标题与摘要，不暴露内部字段结构', () => {
  const pending = tools.describePendingAction('add_health_note', {
    type: 'symptom',
    content: '左耳耳鸣三天'
  })

  assert.equal(pending.title, '记录到健康日志')
  assert.equal(pending.summary, '［症状］左耳耳鸣三天')
  assert.equal(pending.summary.includes('thresholdPercent'), false)
})

test('聊天页：Agent 链路失败时降级为基础问答而不是直接报错', async () => {
  const requests = []
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  global.wx = {
    cloud: {
      callFunction: ({ data }) => {
        requests.push(data)
        // 模拟云端还是旧版本：不认识 agentChat
        if (data.action === 'agentChat') {
          return Promise.resolve({
            result: { success: false, error: { code: 'MODEL_REQUEST_FAILED', message: '不支持的 AI 操作' } }
          })
        }
        return Promise.resolve({ result: { success: true, data: { reply: '耳痛建议尽快到耳鼻喉科检查。' } } })
      }
    },
    nextTick: callback => callback(),
    showToast: () => {}
  }

  let definition
  global.Page = value => {
    definition = value
  }
  loadPage('../miniprogram/pages/ai-chat/ai-chat')
  const page = mountPage(definition)
  page.onLoad()

  page.sendMessage('我突然耳朵很痛')
  await flush()

  // agentChat 失败后自动补发一次基础问答
  assert.equal(requests.length, 2)
  assert.equal(requests[0].action, 'agentChat')
  assert.equal(requests[1].action, 'chatHearingHealth')
  assert.equal(page.data.messages.length, 2)

  // 回复是逐字渲染的：此刻应该正在打字，且内容尚未完整
  assert.equal(page.data.typing, true, '回复进入逐字渲染状态')
  assert.equal(page.data.typingMessageId, page.data.messages[1].id)
  assert.ok(
    page.data.messages[1].content.length < '耳痛建议尽快到耳鼻喉科检查。'.length,
    '逐字渲染时内容尚未完整'
  )

  page.stopTypewriter(true)
  assert.equal(page.data.messages[1].content, '耳痛建议尽快到耳鼻喉科检查。')
  assert.equal(page.data.typing, false, '补全后退出逐字渲染状态')
  assert.ok(page.data.modeHint.indexOf('基础问答') >= 0, '降级时用横幅告知当前读不到档案')
  assert.equal(page.data.loading, false)

  delete global.Page
  delete global.wx
})

test('聊天页：确认写入失败时退回卡片而不降级', async () => {
  const requests = []
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  let failConfirm = false

  global.wx = {
    cloud: {
      callFunction: ({ data }) => {
        requests.push(data)
        if (data.confirm && failConfirm) {
          return Promise.resolve({ result: { success: false, error: { code: 'ARCHIVE_WRITE_FAILED', message: '写入档案失败' } } })
        }
        if (data.action === 'agentChat') {
          return Promise.resolve({
            result: {
              success: true,
              data: {
                reply: '',
                sources: [],
                mode: 'agent',
                pendingAction: { name: 'add_health_note', title: '记录到健康日志', summary: '［症状］耳痛', args: { type: 'symptom', content: '耳痛' } },
                appliedAction: null
              }
            }
          })
        }
        return Promise.resolve({ result: { success: true, data: { reply: '已记录。' } } })
      }
    },
    nextTick: callback => callback(),
    showToast: () => {}
  }

  let definition
  global.Page = value => {
    definition = value
  }
  loadPage('../miniprogram/pages/ai-chat/ai-chat')
  const page = mountPage(definition)
  page.onLoad()

  page.sendMessage('我耳朵痛')
  await flush()

  // 确认阶段失败：不能降级成基础问答，否则待写入的动作就丢了
  failConfirm = true
  page.onConfirmAction({ currentTarget: { dataset: { index: 1 } } })
  await flush()

  assert.equal(requests.length, 2, '确认失败后不再补发基础问答')
  assert.equal(page.data.messages[1].pendingAction.state, 'pending', '卡片退回可确认状态')
  assert.ok(page.data.errorMessage.indexOf('档案写入失败') >= 0, '错误提示说明是写入失败')
  assert.equal(page.data.messages.length, 2, '没有追加降级回复')

  delete global.Page
  delete global.wx
})

test('档案主页添加日志时不会覆盖云函数的分发字段', async () => {
  const requests = []
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  global.wx = {
    getStorageSync: () => null,
    showToast: () => {},
    cloud: {
      callFunction: ({ data }) => {
        requests.push(data)
        return Promise.resolve({ result: { success: true, data: data.type === 'getHealthArchive' ? null : { _id: 'n1' } } })
      }
    }
  }

  let definition
  global.Page = value => {
    definition = value
  }
  loadPage('../miniprogram/pages/profile/health-archive')
  const page = mountPage(definition)
  page.onShow()
  await flush()

  page.setData({ noteContent: '右耳偶尔闷胀' })
  page.onSaveNote()
  await flush()

  // callUser 会把 data 展开成 { type, ...data }，传 type 会把分发字段顶掉
  const addRequest = requests.find(item => item.type === 'addHealthNote')
  assert.ok(addRequest, 'addHealthNote 请求的分发字段不能被覆盖')
  assert.equal(addRequest.noteType, 'symptom')
  assert.equal(addRequest.content, '右耳偶尔闷胀')

  delete global.Page
  delete global.wx
})

test('聊天页：待确认动作先出卡片，用户确认后才真正写入并可撤销', async () => {
  const requests = []
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  const callResults = [
    {
      reply: '',
      sources: [],
      mode: 'agent',
      pendingAction: {
        name: 'add_health_note',
        title: '记录到健康日志',
        summary: '［症状］左耳耳鸣三天',
        args: { type: 'symptom', content: '左耳耳鸣三天' }
      },
      appliedAction: null
    },
    {
      reply: '已经帮你记下来了。',
      sources: ['健康日志'],
      mode: 'agent',
      pendingAction: null,
      appliedAction: {
        name: 'add_health_note',
        title: '记录到健康日志',
        summary: '［症状］左耳耳鸣三天',
        undo: { type: 'removeNote', id: 'n1' }
      }
    }
  ]

  global.wx = {
    cloud: {
      callFunction: ({ data }) => {
        requests.push(data)
        const index = data.confirm ? 1 : 0
        return Promise.resolve({ result: { success: true, data: callResults[index] } })
      }
    },
    nextTick: callback => callback(),
    showToast: () => {}
  }

  let definition
  global.Page = value => {
    definition = value
  }
  loadPage('../miniprogram/pages/ai-chat/ai-chat')
  const page = mountPage(definition)
  page.onLoad()

  page.sendMessage('我左耳耳鸣三天了')
  await flush()

  // 第一次请求不带 confirm，只拿回一张待确认卡片
  assert.equal(requests[0].confirm, undefined)
  assert.equal(page.data.messages.length, 2)
  assert.equal(page.data.messages[1].pendingAction.state, 'pending')

  page.onConfirmAction({ currentTarget: { dataset: { index: 1 } } })
  await flush()
  // 确认后的回复同样逐字渲染，先补全再断言
  page.stopTypewriter(true)

  // 第二次请求才把动作带回去落库
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].confirm, {
    name: 'add_health_note',
    args: { type: 'symptom', content: '左耳耳鸣三天' }
  })
  assert.equal(page.data.messages[1].pendingAction.state, 'applied')
  assert.equal(page.data.messages[2].appliedAction.state, 'applied')
  assert.deepEqual(page.data.messages[2].sources, ['健康日志'])

  page.onUndoAction({ currentTarget: { dataset: { index: 2 } } })
  await flush()
  page.stopTypewriter(true)

  assert.equal(requests.length, 3)
  assert.equal(requests[2].action, 'undoAgentAction')
  assert.deepEqual(requests[2].undo, { type: 'removeNote', id: 'n1' })
  assert.equal(page.data.messages[2].appliedAction.state, 'undone')

  delete global.Page
  delete global.wx
})
