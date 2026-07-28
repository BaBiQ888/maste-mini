const TEACHER_TABS = [
  {
    key: "home",
    label: "工作台",
    url: "/pages/teacher/home/home",
  },
  {
    key: "classes",
    label: "班级",
    url: "/pages/teacher/classes/list",
  },
  {
    key: "assignments",
    label: "作业",
    url: "/pages/teacher/assignments/list",
    badgeKey: "pending",
  },
  {
    key: "questions",
    label: "题库",
    url: "/pages/teacher/questions/list",
  },
  {
    key: "profile",
    label: "我的",
    url: "/pages/profile/profile",
  },
];

const STUDENT_TABS = [
  {
    key: "today",
    label: "今日",
    url: "/pages/student/home/home",
    badgeKey: "incomplete",
  },
  {
    key: "calendar",
    label: "日历",
    url: "/pages/student/calendar/calendar",
  },
  {
    key: "classes",
    label: "班级",
    url: "/pages/student/classes/list",
  },
  {
    key: "profile",
    label: "我的",
    url: "/pages/profile/profile",
  },
];

Component({
  properties: {
    /** teacher | student */
    role: {
      type: String,
      value: "teacher",
    },
    /** 当前 tab key */
    active: {
      type: String,
      value: "home",
    },
    /** 角标数字（老师待批 / 学生未完成） */
    badge: {
      type: Number,
      value: 0,
    },
  },

  data: {
    tabs: TEACHER_TABS,
  },

  observers: {
    role(r) {
      this.setData({
        tabs: r === "student" ? STUDENT_TABS : TEACHER_TABS,
      });
    },
  },

  lifetimes: {
    attached() {
      this.setData({
        tabs: this.data.role === "student" ? STUDENT_TABS : TEACHER_TABS,
      });
    },
  },

  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key;
      if (!key || key === this.data.active) return;
      const tab = (this.data.tabs || []).find((t) => t.key === key);
      if (!tab || !tab.url) return;
      wx.reLaunch({ url: tab.url });
    },
  },
});
