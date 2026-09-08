// 耳友圈（tabBar 页）
// 结构：发布广场 / 排行榜 两个一级标签 → 轮播 → 最新 + 板块 → 帖子流
// 帖子数据来自云函数 communityFunctions，积分榜来自 userFunctions
const { formatTime, callCommunity } = require('./util')
const { callUser } = require('../../utils/auth')

// 顶部公告关闭标记的本地缓存 key（关闭一次后不再展示）
const COMMUNITY_NOTICE_CLOSED_KEY = 'communityNoticeClosed'

// 板块列表：与发帖页 tags 保持一致，all 表示不筛选（最新全部）
const SECTIONS = [
  { key: 'all', label: '全部' },
  { key: 'tip', label: '护耳妙招' },
  { key: 'fail', label: '用耳翻车' },
  { key: 'recommend', label: '耳机安利' },
  { key: 'checkin', label: '护耳打卡' },
  { key: 'question', label: '求助提问' },
  { key: 'report', label: '测听报告' },
  { key: 'science', label: '听力科普' },
  { key: 'device', label: '助听设备' },
  { key: 'hospital', label: '就医经验' },
  { key: 'mood', label: '心情树洞' }
]

Page({
  data: {
    defaultAvatar: '/images/icons/avatar.png',
    showNotice: false,

    // 一级标签：square 发布广场 / rank 排行榜
    mainTab: 'square',

    // 板块筛选
    activeTag: 'all',
    activeTagLabel: '全部',
    showSectionPanel: false,
    sections: SECTIONS,

    // 轮播图：后续可换成后台配置的公告 / 广告
    banners: [
      {
        id: 'notice',
        theme: 'blue',
        tag: '公告',
        title: '耳友圈全新改版',
        desc: '发布广场 + 护耳习惯榜，等你来逛'
      },
      {
        id: 'activity',
        theme: 'green',
        tag: '活动',
        title: '护耳妙招征集',
        desc: '妙招被官方采纳可获得积分奖励'
      },
      {
        id: 'promo',
        theme: 'purple',
        tag: '推广',
        title: '听力自测',
        desc: '3 分钟了解自己的听力状况'
      }
    ],

    postList: [], // 帖子流
    rankList: [], // 积分榜
    myPoints: null, // { rank, points, onBoard }
    rankLoading: false,
    rankError: ''
  },

  onLoad() {
    // 公告默认展示，用户关闭过则不再展示
    this.setData({ showNotice: !wx.getStorageSync(COMMUNITY_NOTICE_CLOSED_KEY) })
  },

  onShow() {
    this.loadPosts(this.data.activeTag)
    if (this.data.mainTab === 'rank') this.loadRank()
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
  },

  onCloseNotice() {
    this.setData({ showNotice: false })
    wx.setStorageSync(COMMUNITY_NOTICE_CLOSED_KEY, true)
  },

  // 切换一级标签：发布广场 / 排行榜
  onSwitchMainTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.mainTab) return
    this.setData({ mainTab: tab, showSectionPanel: false })
    if (tab === 'rank') this.loadRank()
  },

  onToggleSectionPanel() {
    this.setData({ showSectionPanel: !this.data.showSectionPanel })
  },

  // 选择板块后收起面板并重新拉取该板块的帖子
  onSelectSection(e) {
    const key = e.currentTarget.dataset.key
    const section = this.data.sections.find(item => item.key === key)
    this.setData({
      activeTag: key,
      activeTagLabel: section ? section.label : '全部',
      showSectionPanel: false
    })
    this.loadPosts(key)
  },

  loadPosts(tag) {
    callCommunity('listPosts', { tag })
      .then(list => {
        this.setData({
          postList: list.map(p => ({ ...p, createTime: formatTime(p.createTime) }))
        })
      })
      .catch(() => {
        // 云函数未部署或环境异常时置空，展示空状态
        this.setData({ postList: [] })
      })
  },

  // 护耳积分排行榜：当前用户未上榜时，云端会单独算回他的名次
  loadRank() {
    this.setData({ rankLoading: true, rankError: '' })
    callUser('getPointsLeaderboard', { limit: 20 })
      .then(data => {
        this.setData({
          rankList: (data && data.list) || [],
          myPoints: (data && data.me) || null,
          rankLoading: false
        })
      })
      .catch(err => {
        console.error('[community] 积分排行榜加载失败：', err)
        this.setData({ rankLoading: false, rankError: '排行榜加载失败，请稍后重试' })
      })
  },

  onRetryRank() {
    this.loadRank()
  },

  onTapPost(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/community/detail?id=${id}` })
  }
})
