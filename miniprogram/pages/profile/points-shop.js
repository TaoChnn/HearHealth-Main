const { callUser, isLoggedIn } = require('../../utils/auth')

const LOGIN_URL = '/pages/splash/splash?redirect=/pages/profile/points-shop'

const PRODUCT_CATALOG = [
  { id: 'zju-badge', name: '浙大校徽纪念章', description: '经典蓝金珐琅徽章', category: 'culture', categoryLabel: '浙大文创', points: 80, stock: 50, remainingStock: 50, image: '/images/shoppings/IMG_2224.JPG' },
  { id: 'zju-portable-cup', name: '浙大文创随行杯', description: '轻巧便携，校园插画设计', category: 'culture', categoryLabel: '浙大文创', points: 260, stock: 24, remainingStock: 24, image: '/images/shoppings/IMG_2222.JPG' },
  { id: 'zju-thermal-mug', name: '浙大 1897 保温杯', description: '大容量保温杯，蓝白校色', category: 'culture', categoryLabel: '浙大文创', points: 360, stock: 20, remainingStock: 20, image: '/images/shoppings/IMG_2225.JPG' },
  { id: 'zju-tshirt', name: '浙江大学纪念 T 恤', description: '酒红色经典校徽款', category: 'culture', categoryLabel: '浙大文创', points: 680, stock: 18, remainingStock: 18, image: '/images/shoppings/浙大t恤.webp' },
  { id: 'zju-graduation-bear', name: '浙大毕业纪念熊', description: '学位服造型校园纪念玩偶', category: 'culture', categoryLabel: '浙大文创', points: 980, stock: 12, remainingStock: 12, image: '/images/shoppings/IMG_2223.JPG' },
  { id: 'airpods-pro', name: 'AirPods Pro', description: '入耳式主动降噪耳机', category: 'audio', categoryLabel: '数码好物', points: 5200, stock: 8, remainingStock: 8, image: '/images/shoppings/airpodspro.jpg' },
  { id: 'huawei-freebuds-pro', name: 'HUAWEI FreeBuds Pro', description: '智慧动态降噪真无线耳机', category: 'audio', categoryLabel: '数码好物', points: 4600, stock: 8, remainingStock: 8, image: '/images/shoppings/huaweifreebudspro.jpg' },
  { id: 'sony-wh1000xm6', name: 'Sony WH-1000XM6', description: '旗舰头戴式降噪耳机', category: 'audio', categoryLabel: '数码好物', points: 7600, stock: 5, remainingStock: 5, image: '/images/shoppings/sonyxm6.png' },
  { id: 'airpods-max', name: 'AirPods Max', description: '高保真头戴式无线耳机', category: 'audio', categoryLabel: '数码好物', points: 9800, stock: 4, remainingStock: 4, image: '/images/shoppings/airpodsmax.jpg' }
]

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'culture', label: '浙大文创' },
  { id: 'audio', label: '数码好物' }
]

function formatDate(timestamp) {
  if (!Number(timestamp)) return ''
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

function decorateProducts(products, balance) {
  return products.map(item => ({
    ...item,
    soldOut: item.remainingStock <= 0,
    canRedeem: !item.redeemed && item.remainingStock > 0 && balance >= item.points,
    actionText: item.redeemed
      ? '已兑换'
      : item.remainingStock <= 0
        ? '已兑完'
        : balance >= item.points ? '立即兑换' : `还差 ${item.points - balance} 分`
  }))
}

function decorateOrders(orders) {
  const statusLabels = {
    processing: '待发货',
    shipped: '已发货',
    completed: '已完成',
    cancelled: '已取消'
  }
  return (orders || []).map(item => ({
    ...item,
    statusLabel: statusLabels[item.status] || '处理中',
    timeText: formatDate(item.createdAt)
  }))
}

function decorateEntries(entries) {
  return (entries || []).map((item, index) => {
    const points = Math.round(Number(item && item.points) || 0)
    return {
      id: (item && item.id) || `entry-${index}`,
      title: (item && item.title) || '积分变动',
      pointsText: `${points > 0 ? '+' : ''}${points}`,
      direction: points >= 0 ? 'credit' : 'debit',
      timeText: formatDate(item && item.createdAt)
    }
  })
}

Page({
  data: {
    pointsBalance: 0,
    pointsLoading: true,
    pointsError: '',
    products: decorateProducts(PRODUCT_CATALOG, 0),
    visibleProducts: decorateProducts(PRODUCT_CATALOG, 0),
    orders: [],
    pointsEntries: [],
    needLogin: false,
    activeCategory: 'all',
    activeView: 'products',
    categories: CATEGORIES,
    selectedProduct: null,
    showProductSheet: false,
    redeeming: false
  },

  onShow() {
    this.loadShop()
  },

  onPullDownRefresh() {
    this.loadShop().finally(() => {
      if (typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh()
    })
  },

  async loadShop() {
    if (this.shopRequest) return this.shopRequest
    if (!isLoggedIn()) {
      const products = decorateProducts(PRODUCT_CATALOG, 0)
      this.setData({
        needLogin: true,
        pointsLoading: false,
        pointsError: '',
        pointsBalance: 0,
        products,
        visibleProducts: this.filterProducts(products, this.data.activeCategory),
        orders: []
      })
      return Promise.resolve()
    }

    this.setData({ needLogin: false, pointsLoading: true, pointsError: '' })
    this.shopRequest = Promise.all([
      callUser('getPointsShop', { limit: 20 }),
      callUser('getPointsSummary', { limit: 20 })
    ]).then(([shop, summary]) => {
      const balance = Math.max(0, Math.round(Number(shop && shop.balance) || 0))
      const products = decorateProducts((shop && shop.products) || PRODUCT_CATALOG, balance)
      this.setData({
        pointsBalance: balance,
        products,
        visibleProducts: this.filterProducts(products, this.data.activeCategory),
        orders: decorateOrders(shop && shop.orders),
        pointsEntries: decorateEntries(summary && summary.entries),
        pointsLoading: false,
        pointsError: ''
      })
    }).catch(error => {
      console.error('[points-shop] 商城加载失败：', error)
      this.setData({ pointsLoading: false, pointsError: '商城数据暂时无法连接' })
    }).finally(() => {
      this.shopRequest = null
    })
    return this.shopRequest
  },

  filterProducts(products, category) {
    return category === 'all' ? products : products.filter(item => item.category === category)
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.category
    this.setData({
      activeCategory: category,
      visibleProducts: this.filterProducts(this.data.products, category)
    })
  },

  onViewTap(e) {
    this.setData({ activeView: e.currentTarget.dataset.view })
  },

  onProductTap(e) {
    const product = this.data.products.find(item => item.id === e.currentTarget.dataset.id)
    if (!product) return
    this.setData({ selectedProduct: product, showProductSheet: true })
  },

  onCloseProduct() {
    if (!this.data.redeeming) this.setData({ showProductSheet: false })
  },

  onRedeemTap(e) {
    const product = this.data.products.find(item => item.id === e.currentTarget.dataset.id)
    if (product) this.redeemProduct(product)
  },

  onRedeemSelected() {
    if (this.data.selectedProduct) this.redeemProduct(this.data.selectedProduct)
  },

  redeemProduct(product) {
    if (this.data.redeeming) return
    if (!isLoggedIn()) {
      wx.navigateTo({ url: LOGIN_URL })
      return
    }
    if (product.redeemed) {
      wx.showToast({ title: '该商品已兑换', icon: 'none' })
      return
    }
    if (product.soldOut) {
      wx.showToast({ title: '商品已兑完', icon: 'none' })
      return
    }
    if (this.data.pointsBalance < product.points) {
      wx.showToast({ title: `还差 ${product.points - this.data.pointsBalance} 积分`, icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认兑换',
      content: `将使用 ${product.points} 积分兑换「${product.name}」，每人限兑一次。`,
      confirmText: '继续',
      confirmColor: '#0066cc',
      success: result => {
        if (result.confirm) this.chooseAddressAndRedeem(product)
      }
    })
  },

  chooseAddressAndRedeem(product) {
    wx.chooseAddress({
      success: address => this.submitRedemption(product, address),
      fail: error => {
        if (error && String(error.errMsg || '').includes('cancel')) return
        wx.showModal({
          title: '需要收货地址',
          content: '兑换实体奖品需要选择收货地址，请检查微信授权后重试。',
          showCancel: false,
          confirmText: '知道了'
        })
      }
    })
  },

  async submitRedemption(product, address) {
    this.setData({ redeeming: true })
    wx.showLoading({ title: '正在兑换', mask: true })
    try {
      const result = await callUser('redeemPointsProduct', {
        productId: product.id,
        address: {
          userName: address.userName,
          telNumber: address.telNumber,
          provinceName: address.provinceName,
          cityName: address.cityName,
          countyName: address.countyName,
          detailInfo: address.detailInfo
        }
      })
      wx.hideLoading()
      this.setData({ showProductSheet: false })
      wx.showToast({ title: '兑换成功', icon: 'success' })
      await this.loadShop()
      if (result && Number.isFinite(Number(result.balance))) {
        this.setData({ pointsBalance: Number(result.balance) })
      }
    } catch (error) {
      wx.hideLoading()
      wx.showModal({
        title: '兑换未完成',
        content: (error && error.message) || '请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    } finally {
      this.setData({ redeeming: false })
    }
  },

  retryPoints() {
    this.loadShop()
  },

  onGoLogin() {
    wx.navigateTo({ url: LOGIN_URL })
  },

  stopPropagation() {}
})
