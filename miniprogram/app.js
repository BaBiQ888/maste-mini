const { getToken, getUser, setUser } = require("./utils/auth");
const { request } = require("./utils/request");

App({
  globalData: {
    user: null,
    /** 本地调试后端 */
    apiBase: "https://express-gy84-287111-10-1458458765.sh.run.tcloudbase.com",
    /**
     * 云托管：true 优先 callContainer，失败自动回退 HTTPS(apiBase)
     * false 则始终 wx.request + apiBase（开发者工具可关域名校验）
     */
    useCloud: true,
    cloudEnv: "prod-d3gbci34xbe09e370",
    cloudService: "express-gy84",
    /** 图片等静态资源公网前缀（云托管域名） */
    cloudPublicBase:
      "https://express-gy84-287111-10-1458458765.sh.run.tcloudbase.com",
  },

  onLaunch() {
    if (wx.cloud) {
      try {
        wx.cloud.init({
          env: this.globalData.cloudEnv,
          traceUser: true,
        });
      } catch (e) {
        console.warn("wx.cloud.init failed", e);
      }
    }

    const user = getUser();
    if (user) {
      this.globalData.user = user;
    }
    if (getToken()) {
      this.refreshMe().catch(() => {});
    }
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
