// DSH host RSI — browser client half (bili-style). Registers a "RSI 记忆" tab in DSH's
// Settings → 插件 (settings.plugins.tab list-slot) that shows LIVE plugin runtime state:
//   插件是否启用(启用中/已停用/仅内存) · 可信/隔离/轨迹/总数 · 最近记录 · "打开仪表板" 按钮。
// It reads window.__RSI__ (host-injected via webserver/index-inject) and live-fetches the
// SAME-ORIGIN /rsi/status.json route (registered by the host bundle on DSH's webserver),
// so there is no CORS. The "打开仪表板" button opens the standalone loopback dashboard
// (window.__RSI__.url) in a new tab. Fully guarded: if __RSI__ is absent it shows a
// "未接入" hint instead of throwing.

window.__ModuleLoader__.load({
  id: "dsh-host-rsi",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";
    var R = require("react");
    var useState = R.useState;
    var useEffect = R.useEffect;
    var createElement = R.createElement;
    var inject = ["slots", "locale"];
    var NS = "rsi";
    var POLL_MS = 3000;
    var zh = {
      "nav": "DSH HOST RSI记忆",
      "title": "DSH HOST RSI记忆 · 运行状态",
      "open": "打开仪表板",
      "hint": "查看插件是否生效、记住的教训与最近记录（只有可信教训才会被注入模型）。",
      "loading": "加载实时状态…",
      "enabled": "启用中（正常）",
      "disabled": "已停用",
      "memoryOnly": "启用中 · 仅内存",
      "degraded": "当前 dsh 进程未接入 RSI 仪表板——先启用插件，或单独打开独立仪表板。",
      "none": "暂无记录"
    };
    var en = {
      "nav": "DSH HOST RSI",
      "title": "DSH HOST RSI · runtime status",
      "open": "Open dashboard",
      "hint": "See whether the plugin is in effect, its trusted lessons and recent records (only trusted lessons are injected).",
      "loading": "Loading live status…",
      "enabled": "Enabled (normal)",
      "disabled": "Disabled",
      "memoryOnly": "Enabled · in-memory only",
      "degraded": "This dsh process is not bound to the RSI dashboard — enable the plugin first, or open the standalone dashboard.",
      "none": "No records yet"
    };
    function readGlobal() { return globalThis.__RSI__; }
    function openExternal(url) {
      var w = globalThis;
      if (typeof w.open === "function" && url) w.open(url, "_blank", "noopener,noreferrer");
    }
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      if (ctx.effect) ctx.effect(function () { ctx.locale.register(NS, { zh: zh, en: en }); }, "rsi-client: locale");
      else ctx.locale.register(NS, { zh: zh, en: en });
      // Tab component lives inside apply so it closes over the bound locale t + NS.
      function RsiSettingsTab() {
      var g = readGlobal();
      var base = (g && g.basePath) ? g.basePath : "/rsi/";
      var [live, setLive] = useState(null);
      useEffect(function () {
        var stop = false;
        function tick() {
          if (typeof fetch !== "function") return;
          fetch(base + "status.json", { cache: "no-store" })
            .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
            .then(function (j) { if (!stop) setLive(j); })
            .catch(function () { /* keep last snapshot */ });
        }
        tick();
        var id = setInterval(tick, POLL_MS);
        return function () { stop = true; clearInterval(id); };
      }, [base]);
      var s = live || (g && g.status);
      var stateLabel;
      if (!s) stateLabel = t("loading");
      else if (s.enabled === false) stateLabel = t("disabled");
      else if (s.degraded) stateLabel = t("memoryOnly");
      else stateLabel = t("enabled");
      var recs = s && s.recent ? s.recent.slice(0, 6) : [];
      return createElement("div", { style: { padding: 4, lineHeight: 1.65, fontSize: 13 } },
        createElement("div", { style: { fontWeight: 600, fontSize: 14 } }, t("title")),
        createElement("div", { style: { opacity: 0.7, margin: "2px 0 8px" } }, t("hint")),
        createElement("div", { style: { margin: "6px 0" } },
          createElement("span", { style: { opacity: 0.7 } }, "插件状态："),
          createElement("span", { style: { fontWeight: 600, color: s && s.enabled !== false && !s.degraded ? "#4ade80" : (s && s.enabled === false ? "#f87171" : "#facc15") } }, stateLabel)
        ),
        s ? createElement("div", { style: { margin: "4px 0" } },
          "可信教训 ", s.totals.trusted, " · 隔离(待证实) ", s.totals.quarantined, " · 轨迹 ", s.totals.trajectories, " · 总数 ", s.totals.lessons
        ) : null,
        recs.length
          ? createElement("ul", { style: { margin: "8px 0", paddingLeft: 18 } }, recs.map(function (r, i) {
            return createElement("li", { key: i, style: { margin: "3px 0" } },
              createElement("span", { style: { opacity: 0.7 } }, r.domain || "general"), " · ",
              r.summary, r.fix ? createElement("span", { style: { opacity: 0.7 } }, "（纠正：" + r.fix + "）") : null);
          }))
          : createElement("div", { style: { opacity: 0.6, margin: "4px 0" } }, t("none")),
        createElement("button", {
          style: { marginTop: 8, padding: "4px 10px", cursor: "pointer", borderRadius: 6 },
          onClick: function () { openExternal(g && g.url); }
        }, t("open")),
        (!g || !g.url) ? createElement("div", { style: { opacity: 0.6, marginTop: 6 } }, t("degraded")) : null
      );
    }
    ctx.slots.inject("settings.plugins.tab", function () {
      return ctx.slots.register({
        name: "settings.plugins.tab",
        id: "rsi",
        order: 30,
        label: function () { return t("nav"); }
      }, RsiSettingsTab);
    });
    }
    module.exports = { apply: apply, inject: inject };
    return module.exports;
  }
});
