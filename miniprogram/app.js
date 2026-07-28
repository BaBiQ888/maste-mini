const { getToken, getUser, setUser } = require("./utils/auth");
const { request } = require("./utils/request");

App({
  globalData: {
    user: null,
    /**
     * true = 本地 mock，不请求服务端（纯 UI 演示）
     * 默认 false：走云托管 / HTTPS，避免假绿与双轨分叉
     * 临时演示可在开发者工具 Console: getApp().globalData.useMockData = true
     */
    useMockData: false,
    /** 本地调试 / callContainer 失败时的公网回退 */
    apiBase: "https://express-gy84-287111-10-1458458765.sh.run.tcloudbase.com",
    /**
     * 云托管：true 优先 callContainer（网关注入 X-WX-OPENID，登录才稳）
     * 失败再回退 HTTPS(apiBase)。false = 永远公网，容器常因访问不了
     * api.weixin.qq.com 而报 WECHAT_NETWORK。
     * useMockData=true 时不会走网络
     */
    useCloud: true,
    cloudEnv: "prod-d3gbci34xbe09e370",
    cloudService: "express-gy84",
    cloudPublicBase:
      "https://express-gy84-287111-10-1458458765.sh.run.tcloudbase.com",
    /** wx.cloud.Cloud instance after async init */
    cloud: null,
    cloudReady: false,
  },

  onLaunch() {
    if (this.globalData.useMockData) {
      console.log("[mock] 本地 mock 模式：不请求云托管，可直接体验 UI");
      try {
        wx.showToast({
          title: "体验模式 · 本地数据",
          icon: "none",
          duration: 2000,
        });
      } catch (_) {
        /* ignore */
      }
    } else {
      this.initCloud().catch((e) => {
        console.warn("[cloud] init error", e);
      });
    }

    const user = getUser();
    if (user) {
      this.globalData.user = user;
    }
    if (getToken()) {
      this.refreshMe().catch(() => {});
    }
  },

  /**
   * Official pattern: init before callContainer.
   * Prefer wx.cloud.Cloud + resourceEnv when available.
   */
  async initCloud() {
    if (!wx.cloud) {
      console.warn("[cloud] wx.cloud 不可用，将走公网 HTTPS");
      this.globalData.cloudReady = false;
      return null;
    }
    const env = this.globalData.cloudEnv;
    try {
      if (typeof wx.cloud.Cloud === "function") {
        const cloud = new wx.cloud.Cloud({
          resourceEnv: env,
        });
        await cloud.init();
        this.globalData.cloud = cloud;
        this.globalData.cloudReady = true;
        console.log("[cloud] Cloud.init ok resourceEnv=", env);
        return cloud;
      }
      wx.cloud.init({ env, traceUser: true });
      this.globalData.cloud = wx.cloud;
      this.globalData.cloudReady = true;
      console.log("[cloud] wx.cloud.init ok env=", env);
      return wx.cloud;
    } catch (e) {
      console.warn("[cloud] init failed", e);
      // still try global wx.cloud.callContainer
      try {
        wx.cloud.init({ env, traceUser: true });
        this.globalData.cloud = wx.cloud;
        this.globalData.cloudReady = true;
      } catch (e2) {
        this.globalData.cloudReady = false;
      }
      return this.globalData.cloud;
    }
  },

  async ensureCloud() {
    if (this.globalData.cloud && this.globalData.cloudReady) {
      return this.globalData.cloud;
    }
    return this.initCloud();
  },

  async refreshMe() {
    const data = await request({ url: "/api/v1/me", method: "GET" });
    this.globalData.user = data.user;
    setUser(data.user);
    return data.user;
  },

  setUser(user) {
    this.globalData.user = user;
    if (user) {
      setUser(user);
    } else {
      setUser(null);
    }
  },
});
