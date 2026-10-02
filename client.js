// DSH host RSI \u2014 browser client half (bili-style). Registers a standalone "RSI \u8bb0\u5fc6"
// settings section (settings.section), matching how billion-context surfaces its own view:
//   \u63d2\u4ef6\u662f\u5426\u542f\u7528(\u542f\u7528\u4e2d/\u5df2\u505c\u7528/\u4ec5\u5185\u5b58) \u00b7 \u53ef\u4fe1/\u9694\u79bb/\u8f68\u8ff9/\u603b\u6570 \u00b7 \u6700\u8fd1\u8bb0\u5f55 \u00b7 "\u6253\u5f00\u4eea\u8868\u677f" \u6309\u94ae\u3002
// It reads window.__RSI__ (host-injected via webserver/index-inject) and live-fetches the
// SAME-ORIGIN /rsi/status.json route (registered by the host bundle on DSH's webserver),
// so there is no CORS. The "\u6253\u5f00\u4eea\u8868\u677f" button opens the standalone loopback dashboard
// (window.__RSI__.url) in a new tab. Fully guarded: if __RSI__ is absent it shows a
// "\u672a\u63a5\u5165" hint instead of throwing.

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
      "nav": "DSH HOST RSI\u8bb0\u5fc6",
      "title": "DSH HOST RSI\u8bb0\u5fc6 \u00b7 \u8fd0\u884c\u72b6\u6001",
      "open": "\u6253\u5f00\u4eea\u8868\u677f",
      "hint": "\u67e5\u770b\u63d2\u4ef6\u662f\u5426\u751f\u6548\u3001\u8bb0\u4f4f\u7684\u6559\u8bad\u4e0e\u6700\u8fd1\u8bb0\u5f55\uff08\u53ea\u6709\u53ef\u4fe1\u6559\u8bad\u624d\u4f1a\u88ab\u6ce8\u5165\u6a21\u578b\uff09\u3002",
      "loading": "\u52a0\u8f7d\u5b9e\u65f6\u72b6\u6001\u2026",
      "enabled": "\u542f\u7528\u4e2d\uff08\u6b63\u5e38\uff09",
      "disabled": "\u5df2\u505c\u7528",
      "memoryOnly": "\u542f\u7528\u4e2d \u00b7 \u4ec5\u5185\u5b58",
      "degraded": "\u5f53\u524d dsh \u8fdb\u7a0b\u672a\u63a5\u5165 RSI \u4eea\u8868\u677f\u2014\u2014\u5148\u542f\u7528\u63d2\u4ef6\uff0c\u6216\u5355\u72ec\u6253\u5f00\u72ec\u7acb\u4eea\u8868\u677f\u3002",
      "none": "\u6682\u65e0\u8bb0\u5f55"
    };
    var en = {
      "nav": "DSH HOST RSI",
      "title": "DSH HOST RSI \u00b7 runtime status",
      "open": "Open dashboard",
      "hint": "See whether the plugin is in effect, its trusted lessons and recent records (only trusted lessons are injected).",
      "loading": "Loading live status\u2026",
      "enabled": "Enabled (normal)",
      "disabled": "Disabled",
      "memoryOnly": "Enabled \u00b7 in-memory only",
      "degraded": "This dsh process is not bound to the RSI dashboard \u2014 enable the plugin first, or open the standalone dashboard.",
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
          createElement("span", { style: { opacity: 0.7 } }, "\u63d2\u4ef6\u72b6\u6001\uff1a"),
          createElement("span", { style: { fontWeight: 600, color: s && s.enabled !== false && !s.degraded ? "#4ade80" : (s && s.enabled === false ? "#f87171" : "#facc15") } }, stateLabel)
        ),
        s ? createElement("div", { style: { margin: "4px 0" } },
          "\u53ef\u4fe1\u6559\u8bad ", s.totals.trusted, " \u00b7 \u9694\u79bb(\u5f85\u8bc1\u5b9e) ", s.totals.quarantined, " \u00b7 \u8f68\u8ff9 ", s.totals.trajectories, " \u00b7 \u603b\u6570 ", s.totals.lessons
        ) : null,
        recs.length
          ? createElement("ul", { style: { margin: "8px 0", paddingLeft: 18 } }, recs.map(function (r, i) {
            return createElement("li", { key: i, style: { margin: "3px 0" } },
              createElement("span", { style: { opacity: 0.7 } }, r.domain || "general"), " \u00b7 ",
              r.summary, r.fix ? createElement("span", { style: { opacity: 0.7 } }, "\uff08\u7ea0\u6b63\uff1a" + r.fix + "\uff09") : null);
          }))
          : createElement("div", { style: { opacity: 0.6, margin: "4px 0" } }, t("none")),
        createElement("button", {
          style: { marginTop: 8, padding: "4px 10px", cursor: "pointer", borderRadius: 6 },
          onClick: function () { openExternal(g && g.url); }
        }, t("open")),
        (!g || !g.url) ? createElement("div", { style: { opacity: 0.6, marginTop: 6 } }, t("degraded")) : null
      );
    }
    ctx.slots.inject("settings.section", function () {
      return ctx.slots.register({
        name: "settings.section",
        id: "rsi",
        order: 60,
        label: function () { return t("nav"); },
        locale: NS
      }, RsiSettingsTab);
    });
    }
    module.exports = { apply: apply, inject: inject };
    return module.exports;
  }
});
