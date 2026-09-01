const PROMPT_VERSION = 'hearing-analysis-v2'

const SYSTEM_PROMPT = [
  '你是 HearHealth“用耳健康”小程序中的听力健康 AI 助手。',
  '你的任务仅限于健康教育和初步筛查结果解释，不是医学诊断。',
  '本测试测量的是固定设备与小程序数字增益条件下的相对增益阈值。该数值不是 dB HL，也不是标准纯音测听阈值；绝不能换算成 dB HL。',
  '不得输出轻度、中度、重度等医学听损等级，不得诊断疾病或给出疾病概率。',
  '不得开处方、推荐处方药、保证治疗效果，或声称可以替代医生和标准听力检查。',
  '可以通俗解释测得与未测得的频点、描述左右耳在本次条件下的相对表现，并谨慎提醒明显差异。',
  '可以给出控制音量、减少连续使用、适当休息、减少噪声暴露和定期检查等一般性建议。',
  '如用户存在持续耳鸣、耳痛、突发听力下降等红旗症状，应建议尽快到耳鼻喉科或专业听力机构评估。',
  '所有结论都必须明确受设备、环境、佩戴和用户操作影响，并保持克制、清晰、容易理解。',
  '所有返回字段必须为面向普通用户的中文纯文本，不得使用 Markdown、HTML、代码块、星号加粗、标题符号或列表语法。',
  '不得在返回文本中引用输入数据的字段名、对象路径、变量名或代码表达式；请把频点数量、左右耳结果和相对音量阈值改写成自然、完整的健康筛查说明。'
].join('\n')

function normalizeCompletedAt(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function pickEarResults(records) {
  if (!Array.isArray(records)) return []
  return records.slice(0, 6).map(item => ({
    frequency: Number(item.frequency),
    detected: Boolean(item.detected),
    thresholdPercent: item.detected && Number.isFinite(Number(item.thresholdPercent))
      ? Number(item.thresholdPercent)
      : null,
    maxTestedPercent: Number.isFinite(Number(item.maxTestedPercent))
      ? Number(item.maxTestedPercent)
      : null,
    attempts: Number.isFinite(Number(item.attempts)) ? Number(item.attempts) : null,
    answeredAt: Number.isFinite(Number(item.answeredAt)) ? Number(item.answeredAt) : null
  }))
}

function buildHearingAnalysisInput(record) {
  return {
    measurement: record.measurement,
    completedAt: normalizeCompletedAt(record.completedAt),
    detectedLeft: Number(record.detectedLeft) || 0,
    detectedRight: Number(record.detectedRight) || 0,
    ears: {
      left: pickEarResults(record.ears && record.ears.left),
      right: pickEarResults(record.ears && record.ears.right)
    },
    testDescription: {
      frequenciesHz: [125, 250, 500, 1000, 2000, 4000],
      thresholdMeaning: '固定设备和小程序数字增益条件下首次确认听到测试音的相对增益百分比',
      isDbHL: false,
      isStandardAudiometry: false
    }
  }
}

function buildHearingAnalysisUserPrompt(record) {
  const input = buildHearingAnalysisInput(record)
  return [
    '请依据以下匿名筛查指标生成结构化听力健康教育解读。',
    '只描述数据支持的现象，不要补充未提供的症状，也不要作医学诊断。',
    JSON.stringify(input)
  ].join('\n')
}

module.exports = {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildHearingAnalysisInput,
  buildHearingAnalysisUserPrompt
}
