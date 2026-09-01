const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const projectRoot = path.resolve(__dirname, '..')
const shopRoute = 'pages/profile/points-shop'

test('积分商城页面已注册到小程序路由', () => {
  const appConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'miniprogram/app.json'), 'utf8')
  )

  assert.equal(appConfig.pages.includes(shopRoute), true)
})

test('个人中心积分商城入口跳转到已注册页面', () => {
  let profilePage
  let navigatedUrl = ''

  global.wx = {
    getStorageSync() {
      return null
    },
    navigateTo({ url }) {
      navigatedUrl = url
    }
  }
  global.Page = definition => {
    profilePage = definition
  }

  require('../miniprogram/pages/profile/profile')

  const menuItems = profilePage.data.menuGroups.flatMap(group => group.items)
  const shopItem = menuItems.find(item => item.id === 'points-shop')

  assert.ok(shopItem)
  assert.equal(shopItem.url, `/${shopRoute}`)

  profilePage.onMenuTap({
    currentTarget: {
      dataset: { url: shopItem.url }
    }
  })
  assert.equal(navigatedUrl, `/${shopRoute}`)

  delete global.Page
  delete global.wx
})

test('积分商城首期展示三种奖励分类和零积分占位余额', () => {
  let shopPage

  global.Page = definition => {
    shopPage = definition
  }
  require('../miniprogram/pages/profile/points-shop')

  assert.equal(shopPage.data.pointsBalance, 0)
  assert.deepEqual(
    shopPage.data.rewardCategories.map(item => item.id),
    ['badges', 'coupons', 'souvenirs']
  )

  delete global.Page
})
