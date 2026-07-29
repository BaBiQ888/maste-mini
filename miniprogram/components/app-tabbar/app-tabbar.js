const TEACHER_TABS = [
  {
    key: "home",
    label: "工作台",
    url: "/pages/teacher/home/home",
    icon: "/assets/tabbar/home.png",
    iconActive: "/assets/tabbar/home-active.png",
  },
  {
    key: "classes",
    label: "班级",
    url: "/pages/teacher/classes/list",
    icon: "/assets/tabbar/classes.png",
    iconActive: "/assets/tabbar/classes-active.png",
  },
  {
    key: "assignments",
    label: "作业",
    url: "/pages/teacher/assignments/list",
    badgeKey: "pending",
    icon: "/assets/tabbar/assignments.png",
    iconActive: "/assets/tabbar/assignments-active.png",
  },
  {
    key: "questions",
    label: "题库",
    url: "/pages/teacher/questions/list",
    icon: "/assets/tabbar/questions.png",
    iconActive: "/assets/tabbar/questions-active.png",
  },
  {
    key: "profile",
    label: "我的",
    url: "/pages/profile/profile",
    icon: "/assets/tabbar/profile.png",
    iconActive: "/assets/tabbar/profile-active.png",
  },
];

const STUDENT_TABS = [
  {
    key: "today",
    label: "今日",
    url: "/pages/student/home/home",
    badgeKey: "incomplete",
    icon: "/assets/tabbar/today.png",
    iconActive: "/assets/tabbar/today-active.png",
  },
  {
    key: "calendar",
    label: "日历",
    url: "/pages/student/calendar/calendar",
    icon: "/assets/tabbar/calendar.png",
    iconActive: "/assets/tabbar/calendar-active.png",
  },
  {
    key: "classes",
    label: "班级",
    url: "/pages/student/classes/list",
    icon: "/assets/tabbar/classes.png",
    iconActive: "/assets/tabbar/classes-active.png",
  },
  {
    key: "profile",
    label: "我的",
    url: "/pages/profile/profile",
    icon: "/assets/tabbar/profile.png",
    iconActive: "/assets/tabbar/profile-active.png",
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
