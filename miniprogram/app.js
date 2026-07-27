const { getToken, getUser, setUser } = require("./utils/auth");
const { request } = require("./utils/request");

App({
  globalData: {
    user: null,
    /** 本地调试 / callContainer 失败时的公网回退 */
    apiBase: "https://express-gy84-287111-10-1458458765.sh.run.tcloudbase.com",
    /**
     * 云托管：true 优先 callContainer，失败自动回退 HTTPS(apiBase)
     * false 则始终 wx.request + apiBase
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
    this.initCloud().catch((e) => {
      console.warn("[cloud] init error", e);
    });

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
