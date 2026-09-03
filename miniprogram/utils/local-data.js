// 本地存储键清单与按语义分类的清理
// 背景（issue #35）：身份来自微信 OPENID、用耳/测试等权威数据存在云端，
// 旧实现在设置页直接 wx.clearStorageSync()，看起来「清掉了」，
// 但 app.js 与各页面会自动重新登录并把云端数据同步回来，
// 于是「清除本地数据」清不掉登录态与用耳时长，名不副实。
// 这里把所有本地键集中登记，并分成「云端副本」与「仅本机」两类，
// 让设置页能按语义分别提供：清缓存（可恢复）/ 退出登录（清会话）/ 注销账号（连云端一起删）。

// 登录会话（utils/auth）
const SESSION_KEY = 'hearHealthSession'
// 用户是否主动退出过登录：用于区分「游客（可以后台补登录）」与
// 「刚主动退出（不要再自动登回来，否则退出登录形同无效）」
const LOGGED_OUT_KEY = 'hearHealthLoggedOut'

// 云端数据的本地副本：清掉后会在下次登录或进页面时重新从云端同步回来
const SYNCED_KEYS = [
  'hearHealthUsage',          // 用耳按天镜像（utils/usage-tracker）
  'hearHealthUsagePending',   // 尚未得到云端确认的用耳增量
  'hearHealthUserProfile',    // 个人资料（utils/user-profile）
  'hearHealthSettings',       // 提醒与通知设置（utils/app-settings）
  'skill_favs',               // 护耳技能收藏（utils/auth）
  'latestHearingTestResult',  // 最近一次听力测试结果
  'historyHearingTestResult'  // 历史测试记录快照
]

// 仅存在于本机的状态：清掉后不会自动恢复
const DEVICE_ONLY_KEYS = [
  'hearingReportShareDraft',     // 社区发帖草稿
  'hearHealthDailyRiskReminder', // 今日风险提醒弹窗是否已弹过
  'communityNoticeClosed'        // 社区公告是否已关闭
]

function readKey(key) {
  try {
    return wx.getStorageSync(key)
  } catch (error) {
    return null
  }
}

function writeKey(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (error) {
    // 存储失败时降级为不记录，不阻塞主流程
  }
}

function removeKeys(keys) {
  keys.forEach(key => {
    try {
      wx.removeStorageSync(key)
    } catch (error) {
      // 忽略单个键清理失败
    }
  })
}

// 清除缓存：只清云端数据的本地副本，登录态与云端数据都不受影响，
// 下次登录或进入相关页面时会重新同步回来
function clearCache() {
  removeKeys(SYNCED_KEYS)
}

// 清除账号在本机的全部数据（含会话）：云端数据保留，重新登录会同步回来
function clearAccountData() {
  removeKeys(SYNCED_KEYS)
  removeKeys(DEVICE_ONLY_KEYS)
  removeKeys([SESSION_KEY])
}

function isLoggedOut() {
  return Boolean(readKey(LOGGED_OUT_KEY))
}

function markLoggedOut() {
  writeKey(LOGGED_OUT_KEY, true)
}

function clearLoggedOut() {
  removeKeys([LOGGED_OUT_KEY])
}

module.exports = {
  SESSION_KEY,
  LOGGED_OUT_KEY,
  SYNCED_KEYS,
  DEVICE_ONLY_KEYS,
  clearCache,
  clearAccountData,
  isLoggedOut,
  markLoggedOut,
  clearLoggedOut
}
