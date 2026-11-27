(() => {
  const allowedPaths = new Set([
    "/football/", "/football/fixtures/", "/football/review/", "/football/research/",
    "/football/tools/", "/football/tools/probability/", "/football/tools/poisson/",
    "/football/stats/", "/football/reports/",
  ]);
  const reportPage = /^\/football\/reports\/week-\d{4}-\d{2}-\d{2}\/$/.test(location.pathname);
  if (!allowedPaths.has(location.pathname) && !reportPage) return;

  const preferenceKey = "90scale.portal.analytics.v1";
  const notice = document.getElementById("portal-analytics");
  const status = document.getElementById("portal-analytics-status");
  const events = new Set(["member_entry_click", "admin_contact_click", "admin_contact_copy"]);
  let loaded = false;

  function savedChoice() {
    try {
      return localStorage.getItem(preferenceKey);
    } catch {
      return null;
    }
  }

  function sendConsent(analytics) {
    window.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: analytics });
  }

  function startClarity() {
    // Skip URLs and referring URLs that might contain account tokens or other sensitive parameters.
    const referrer = document.referrer ? new URL(document.referrer) : null;
    if (loaded || location.search || (location.hash && location.hash !== "#portal-analytics")
      || referrer?.search || referrer?.hash) return;

    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    sendConsent("granted");

    const tag = document.createElement("script");
    tag.async = true;
    tag.src = "https://www.clarity.ms/tag/zk8tm7oi5k";
    tag.referrerPolicy = "strict-origin";
    document.head.append(tag);
    loaded = true;
    if (reportPage) window.clarity("event", "research_report_view");
  }

  let choice = savedChoice();
  notice.open = choice === null;
  if (choice === "allow") {
    status.textContent = "访问统计已允许";
    startClarity();
  } else if (choice === "deny") {
    status.textContent = "访问统计已关闭";
  }

  function stopClarity() {
    if (!loaded) return;
    sendConsent("denied");
    for (const cookie of ["_clck", "_clsk"]) {
      document.cookie = `${cookie}=; Max-Age=0; Path=/`;
      document.cookie = `${cookie}=; Max-Age=0; Path=/; Domain=${location.hostname}`;
    }
    location.reload();
  }

  function setChoice(value) {
    choice = value;
    try {
      localStorage.setItem(preferenceKey, value);
    } catch {
      // Browsers that block local storage keep the choice for this page only.
    }
    status.textContent = value === "allow" ? "访问统计已允许" : "访问统计已关闭";
    if (value === "allow") startClarity();
    else stopClarity();
  }

  document.getElementById("portal-analytics-allow").addEventListener("click", () => setChoice("allow"));
  document.getElementById("portal-analytics-deny").addEventListener("click", () => setChoice("deny"));

  window.addEventListener("storage", (event) => {
    if ((event.key === preferenceKey || event.key === null) && savedChoice() !== "allow") stopClarity();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && savedChoice() !== "allow") stopClarity();
  });

  function trackClick(event) {
    const element = event.target.closest("[data-portal-event]");
    const name = element?.dataset.portalEvent;
    if (loaded && choice === "allow" && events.has(name)) window.clarity("event", name);
  }

  document.addEventListener("portal-probability-calculated", () => {
    if (loaded && choice === "allow") window.clarity("event", "probability_calculated");
  });
  document.addEventListener("portal-poisson-calculated", () => {
    if (loaded && choice === "allow") window.clarity("event", "poisson_calculated");
  });
  document.addEventListener("click", trackClick, true);
  document.addEventListener("auxclick", (event) => {
    if (event.button === 1 && event.target.closest("a")) trackClick(event);
  }, true);

  document.getElementById("portal-copy-wechat")?.addEventListener("click", async () => {
    const wechat = document.getElementById("portal-wechat");
    const feedback = document.getElementById("portal-copy-status");
    try {
      await navigator.clipboard.writeText(wechat.textContent);
      feedback.textContent = "微信号已复制";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(wechat);
      selection.removeAllRanges();
      selection.addRange(range);
      feedback.textContent = "请手动复制所选微信号";
    }
  });
})();
