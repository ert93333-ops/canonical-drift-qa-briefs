(function () {
  "use strict";

  const ANALYTICS_KEY = "canonicaldriftqa_analytics_events";
  const INTENT_KEY = "canonicaldriftqa_purchase_intents";
  const GITHUB_ISSUE_URL = "https://github.com/ert93333-ops/canonical-drift-qa-briefs/issues/new";

  const SAMPLE_ROWS = [
    "page_url | canonical_url | notes",
    "https://example.com/products/launch-kit | https://staging.example.com/products/launch-kit/ | staging canonical from template",
    "http://example.com/pricing | https://example.com/pricing/ | protocol and trailing slash drift",
    "https://example.com/blog/canonical-guide |  | missing canonical",
    "https://shop.example.com/category/shoes?color=blue | https://example.com/category/shoes | cross-domain canonical needs approval",
  ].join("\n");

  const SAMPLE_SITEMAP = [
    "https://example.com/products/launch-kit",
    "https://example.com/pricing",
    "https://example.com/category/shoes",
    "https://staging.example.com/draft",
  ].join("\n");

  const state = {
    latestBrief: null,
    latestBriefText: "",
    lastRemoteBody: "",
    signupStarted: false,
    pricingTracked: false,
  };

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function setText(selector, value) {
    const element = qs(selector);
    if (element) element.textContent = value;
  }

  function readArray(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function writeArray(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Local storage can be unavailable in privacy modes. The UI still works.
    }
  }

  function getUtm() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
    };
  }

  function track(eventName, detail) {
    const events = readArray(ANALYTICS_KEY);
    events.push({
      event: eventName,
      detail: detail || {},
      utm: getUtm(),
      path: window.location.pathname,
      createdAt: new Date().toISOString(),
    });
    writeArray(ANALYTICS_KEY, events.slice(-200));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function listHtml(items, emptyText) {
    if (!items.length) return "<p>" + escapeHtml(emptyText) + "</p>";
    return "<ul>" + items.map(function (item) {
      return "<li>" + escapeHtml(item) + "</li>";
    }).join("") + "</ul>";
  }

  function clean(value) {
    return String(value || "").trim();
  }

  function parseUrl(value) {
    try {
      return new URL(clean(value));
    } catch (error) {
      return null;
    }
  }

  function canonicalKey(value, options) {
    const url = parseUrl(value);
    if (!url) return clean(value).replace(/\/$/, "");
    url.hash = "";
    if (options && options.dropQuery) url.search = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  }

  function hostOf(value) {
    const url = parseUrl(value);
    return url ? url.hostname.toLowerCase().replace(/^www\./, "") : "";
  }

  function isStagingLike(value) {
    return /(^|[./-])(staging|stage|preview|dev|test|qa|localhost|draft)([./-]|$)/i.test(clean(value));
  }

  function extractUrls(raw) {
    const matches = clean(raw).match(/https?:\/\/[^\s<>"'|,]+/gi) || [];
    return matches.map(function (url) {
      return url.replace(/[),.;]+$/, "");
    });
  }

  function parseCanonicalRows(raw) {
    return clean(raw)
      .split(/\r?\n/)
      .map(function (line) { return clean(line); })
      .filter(Boolean)
      .filter(function (line) { return !/^page[_\s-]*url/i.test(line); })
      .map(function (line) {
        let parts = line.split("|").map(clean);
        if (parts.length < 2) parts = line.split(/\t/).map(clean);
        if (parts.length < 2) {
          const urls = extractUrls(line);
          parts = [urls[0] || "", urls[1] || "", line.replace((urls[0] || ""), "").replace((urls[1] || ""), "").trim()];
        }
        return {
          pageUrl: parts[0] || "",
          canonicalUrl: parts[1] || "",
          notes: parts.slice(2).join(" | "),
          raw: line,
        };
      })
      .filter(function (row) { return row.pageUrl || row.canonicalUrl; });
  }

  function parseSitemapRows(raw) {
    const xmlUrls = Array.from(clean(raw).matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)).map(function (match) {
      return clean(match[1]);
    });
    const lineUrls = clean(raw).split(/[\r\n,]+/).map(clean).filter(function (line) {
      return /^https?:\/\//i.test(line);
    });
    return Array.from(new Set(xmlUrls.concat(lineUrls)));
  }

  function analyzeCanonical(input) {
    const rows = parseCanonicalRows(input.canonicalRows);
    const sitemapRows = parseSitemapRows(input.sitemapRows);
    const sitemapSet = new Set(sitemapRows.map(function (url) { return canonicalKey(url); }));
    const sitemapNoQuerySet = new Set(sitemapRows.map(function (url) { return canonicalKey(url, { dropQuery: true }); }));
    const launchContext = clean(input.launchContext);
    const redirectNotes = clean(input.redirectNotes);
    const canonicalOwner = clean(input.canonicalOwner);

    const missingWarnings = [];
    const mismatchWarnings = [];
    const protocolSlashWarnings = [];
    const stagingWarnings = [];
    const crossDomainWarnings = [];
    const sitemapWarnings = [];
    const redirectReminders = [
      "Confirm final production redirects before trusting canonical rows.",
      "Retest after CMS templates, facets, trailing slash rules, or host redirects change.",
      "Treat this as launch QA guidance; search engines may select a different canonical from multiple signals.",
    ];

    rows.forEach(function (row, index) {
      const label = row.pageUrl || "row " + (index + 1);
      const page = parseUrl(row.pageUrl);
      const canonical = parseUrl(row.canonicalUrl);

      if (!row.pageUrl || !page) {
        mismatchWarnings.push("Row " + (index + 1) + " has a missing or invalid page URL.");
      }
      if (!row.canonicalUrl) {
        missingWarnings.push(label + " is missing a canonical URL.");
      } else if (!canonical) {
        mismatchWarnings.push(label + " has an invalid canonical URL: `" + row.canonicalUrl + "`.");
      }
      if (!page || !canonical) return;

      const pageKey = canonicalKey(row.pageUrl);
      const canonicalUrlKey = canonicalKey(row.canonicalUrl);
      const pageNoQuery = canonicalKey(row.pageUrl, { dropQuery: true });
      const canonicalNoQuery = canonicalKey(row.canonicalUrl, { dropQuery: true });

      if (pageKey !== canonicalUrlKey) {
        mismatchWarnings.push(label + " canonical differs from the page URL: `" + row.canonicalUrl + "`.");
      }
      if (page.protocol !== canonical.protocol) {
        protocolSlashWarnings.push(label + " has protocol drift: page is `" + page.protocol.replace(":", "") + "` but canonical is `" + canonical.protocol.replace(":", "") + "`.");
      }
      if (pageNoQuery === canonicalNoQuery && page.pathname.replace(/\/$/, "") === canonical.pathname.replace(/\/$/, "") && page.pathname !== canonical.pathname) {
        protocolSlashWarnings.push(label + " has trailing slash drift between page and canonical.");
      }
      if (isStagingLike(row.pageUrl) || isStagingLike(row.canonicalUrl)) {
        stagingWarnings.push(label + " includes a staging, preview, test, dev, draft, or localhost URL.");
      }
      if (hostOf(row.pageUrl) && hostOf(row.canonicalUrl) && hostOf(row.pageUrl) !== hostOf(row.canonicalUrl)) {
        crossDomainWarnings.push(label + " canonical points across domains: `" + hostOf(row.pageUrl) + "` -> `" + hostOf(row.canonicalUrl) + "`.");
      }
      if (page.search && pageNoQuery === canonicalUrlKey) {
        redirectReminders.push(label + " uses a query URL that canonicalizes to the clean URL; confirm this is intentional for facets or tracking parameters.");
      }
      if (sitemapRows.length) {
        if (!sitemapSet.has(pageKey) && !sitemapNoQuerySet.has(pageNoQuery)) {
          sitemapWarnings.push(label + " page URL was not found in the pasted sitemap rows.");
        }
        if (!sitemapSet.has(canonicalUrlKey) && !sitemapNoQuerySet.has(canonicalNoQuery)) {
          sitemapWarnings.push(label + " canonical target was not found in the pasted sitemap rows.");
        }
      }
    });

    sitemapRows.forEach(function (url) {
      if (isStagingLike(url)) {
        sitemapWarnings.push("Sitemap row includes a staging, preview, test, dev, draft, or localhost URL: `" + url + "`.");
      }
      if (/^http:\/\//i.test(url)) {
        sitemapWarnings.push("Sitemap row uses HTTP instead of HTTPS: `" + url + "`.");
      }
    });

    if (/trailing slash|redirect|apex|www|finalized|finalised|migration/i.test(redirectNotes + " " + launchContext)) {
      redirectReminders.push("Redirect or slash behavior is mentioned in notes; capture final destination URLs after redirects are configured.");
    }
    if (!sitemapRows.length) {
      sitemapWarnings.push("No sitemap rows were provided, so sitemap/canonical agreement could not be checked.");
    }

    const issueCount =
      missingWarnings.length +
      mismatchWarnings.length +
      protocolSlashWarnings.length +
      stagingWarnings.length +
      crossDomainWarnings.length +
      sitemapWarnings.length;
    const status = missingWarnings.length || stagingWarnings.length || mismatchWarnings.length
      ? "Fix before launch"
      : issueCount >= 4
        ? "Manual review"
        : "Ready for final URL check";

    return {
      status: status,
      issueCount: issueCount,
      rowCount: rows.length,
      sitemapCount: sitemapRows.length,
      launchContext: launchContext,
      canonicalOwner: canonicalOwner,
      missingWarnings: Array.from(new Set(missingWarnings)),
      mismatchWarnings: Array.from(new Set(mismatchWarnings)),
      protocolSlashWarnings: Array.from(new Set(protocolSlashWarnings)),
      stagingWarnings: Array.from(new Set(stagingWarnings)),
      crossDomainWarnings: Array.from(new Set(crossDomainWarnings)),
      sitemapWarnings: Array.from(new Set(sitemapWarnings)),
      redirectReminders: Array.from(new Set(redirectReminders)),
    };
  }

  function briefToText(brief) {
    return [
      "Canonical Drift QA Briefs",
      "Status: " + brief.status,
      "Issue count: " + brief.issueCount,
      "Canonical rows: " + brief.rowCount,
      "Sitemap rows: " + brief.sitemapCount,
      "Launch context: " + brief.launchContext,
      "Canonical owner: " + brief.canonicalOwner,
      "",
      "Missing canonical warnings:",
      brief.missingWarnings.length ? brief.missingWarnings.join("\n") : "None found.",
      "",
      "URL vs canonical mismatch warnings:",
      brief.mismatchWarnings.length ? brief.mismatchWarnings.join("\n") : "None found.",
      "",
      "HTTP/HTTPS and trailing slash drift:",
      brief.protocolSlashWarnings.length ? brief.protocolSlashWarnings.join("\n") : "None found.",
      "",
      "Staging or preview URL warnings:",
      brief.stagingWarnings.length ? brief.stagingWarnings.join("\n") : "None found.",
      "",
      "Cross-domain canonical risk notes:",
      brief.crossDomainWarnings.length ? brief.crossDomainWarnings.join("\n") : "None found.",
      "",
      "Sitemap and canonical agreement:",
      brief.sitemapWarnings.length ? brief.sitemapWarnings.join("\n") : "None found.",
      "",
      "Redirect and final URL reminders:",
      brief.redirectReminders.join("\n"),
      "",
      "Note: This is launch QA guidance, not a guarantee of search-engine-selected canonical outcomes.",
    ].join("\n");
  }

  function renderBrief(brief) {
    const output = qs("#brief-output");
    const copyButton = qs("#copy-brief");
    const outputPanel = qs(".output-panel");
    const statusPill = qs("#status-pill");
    if (!output) return;

    output.classList.remove("empty");
    output.classList.add("is-updated");
    window.setTimeout(function () { output.classList.remove("is-updated"); }, 480);
    output.innerHTML = [
      '<div class="brief-summary">',
      '<strong>' + escapeHtml(brief.status) + '</strong>',
      '<span>' + brief.issueCount + ' checks need attention across ' + brief.rowCount + ' canonical rows</span>',
      "</div>",
      '<section class="brief-section"><h4>Missing canonical warnings</h4>' + listHtml(brief.missingWarnings, "No missing canonical warnings found.") + "</section>",
      '<section class="brief-section"><h4>URL vs canonical mismatch warnings</h4>' + listHtml(brief.mismatchWarnings, "No URL/canonical mismatch warnings found.") + "</section>",
      '<section class="brief-section"><h4>HTTP/HTTPS and trailing slash drift</h4>' + listHtml(brief.protocolSlashWarnings, "No protocol or trailing slash drift found.") + "</section>",
      '<section class="brief-section"><h4>Staging or preview URL warnings</h4>' + listHtml(brief.stagingWarnings, "No staging or preview URL warnings found.") + "</section>",
      '<section class="brief-section"><h4>Cross-domain canonical risk notes</h4>' + listHtml(brief.crossDomainWarnings, "No cross-domain canonical warnings found.") + "</section>",
      '<section class="brief-section"><h4>Sitemap and canonical agreement</h4>' + listHtml(brief.sitemapWarnings, "No sitemap/canonical disagreement found.") + "</section>",
      '<section class="brief-section"><h4>Redirect and final URL reminders</h4>' + listHtml(brief.redirectReminders, "No redirect reminders found.") + "</section>",
    ].join("");
    setText("#output-title", "Canonical drift QA brief ready");
    setText("#status-pill", brief.status);
    if (copyButton) copyButton.disabled = false;
    if (outputPanel) {
      outputPanel.classList.add("has-brief");
      outputPanel.classList.toggle("status-good", brief.status === "Ready for final URL check");
      outputPanel.classList.toggle("status-warning", brief.status === "Manual review");
      outputPanel.classList.toggle("status-danger", brief.status === "Fix before launch");
    }
    if (statusPill) {
      statusPill.classList.toggle("status-good", brief.status === "Ready for final URL check");
      statusPill.classList.toggle("status-warning", brief.status === "Manual review");
      statusPill.classList.toggle("status-danger", brief.status === "Fix before launch");
    }
    state.latestBrief = brief;
    state.latestBriefText = briefToText(brief);
  }

  function pulseClass(element, className, duration) {
    if (!element) return;
    element.classList.add(className);
    window.setTimeout(function () { element.classList.remove(className); }, duration || 600);
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Fall through to textarea fallback for headless browser clipboard blocks.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function setupAuditor() {
    const form = qs("#auditor-form");
    const canonicalInput = qs("#canonical-input");
    const sitemapInput = qs("#sitemap-input");
    const loadSample = qs("#load-sample");
    const error = qs("#workflow-error");
    const copyButton = qs("#copy-brief");
    if (!form || !canonicalInput) return;

    if (loadSample) {
      loadSample.addEventListener("click", function () {
        canonicalInput.value = SAMPLE_ROWS;
        if (sitemapInput) sitemapInput.value = SAMPLE_SITEMAP;
        if (qs("#launch-context")) qs("#launch-context").value = "Site migration";
        canonicalInput.focus();
        pulseClass(loadSample, "is-confirmed", 520);
        track("sample_canonical_rows_loaded");
      });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      track("core_action_started", { triggerSource: "auditor_form" });
      if (error) error.textContent = "";

      const input = {
        canonicalRows: canonicalInput.value.trim(),
        sitemapRows: sitemapInput ? sitemapInput.value.trim() : "",
        launchContext: qs("#launch-context") ? qs("#launch-context").value : "",
        redirectNotes: qs("#redirect-notes") ? qs("#redirect-notes").value.trim() : "",
        canonicalOwner: qs("#canonical-owner") ? qs("#canonical-owner").value.trim() : "",
      };
      const inputLength = Object.keys(input).reduce(function (total, key) { return total + String(input[key]).length; }, 0);
      if (!input.canonicalRows) {
        if (error) error.textContent = "Paste URL/canonical rows or load the sample before generating a canonical drift QA brief.";
        track("core_action_failed", { reason: "empty_input" });
        return;
      }

      const brief = analyzeCanonical(input);
      renderBrief(brief);
      track("core_action_completed", {
        issueCount: brief.issueCount,
        status: brief.status,
        rowCount: brief.rowCount,
        sitemapCount: brief.sitemapCount,
        inputLength: inputLength,
      });
    });

    if (copyButton) {
      copyButton.addEventListener("click", function () {
        if (!state.latestBriefText) return;
        copyText(state.latestBriefText).then(function () {
          copyButton.textContent = "Copied brief";
          pulseClass(copyButton, "is-confirmed", 700);
          track("brief_copied", { issueCount: state.latestBrief ? state.latestBrief.issueCount : 0 });
          window.setTimeout(function () { copyButton.textContent = "Copy brief"; }, 1400);
        });
      });
    }
  }

  function buildRemoteIssue(intent) {
    const body = [
      "Canonical Drift QA Briefs early-access request",
      "",
      "Role: " + intent.role,
      "Number of sites: " + intent.siteCount,
      "Launch context: " + intent.launchContext,
      "Plan interest: " + intent.plan,
      "Willingness to pay: " + intent.budget,
      "Purchase intent: " + (intent.purchaseIntent ? "yes" : "no"),
      "",
      "Biggest canonical QA pain:",
      intent.pain,
      "",
      "Note: Email is intentionally omitted from this public issue body.",
    ].join("\n");
    state.lastRemoteBody = body;
    const params = new URLSearchParams({
      title: "Canonical Drift QA Briefs early-access request",
      body: body,
      labels: "early-access,purchase-intent,demo-request",
      template: "demo_request.md",
    });
    return GITHUB_ISSUE_URL + "?" + params.toString();
  }

  function setupWaitlist() {
    const form = qs("#waitlist-form");
    const status = qs("#waitlist-status");
    const handoff = qs("#handoff-panel");
    const remoteLink = qs("#remote-intent-link");
    const copyRequest = qs("#copy-request");
    const planSelect = qs("#plan");
    if (!form) return;

    form.addEventListener("focusin", function () {
      if (!state.signupStarted) {
        state.signupStarted = true;
        track("signup_started", { triggerSource: "waitlist_form" });
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!state.signupStarted) {
        state.signupStarted = true;
        track("signup_started", { triggerSource: "waitlist_submit" });
      }
      const intent = {
        email: qs("#email") ? qs("#email").value.trim() : "",
        role: qs("#role") ? qs("#role").value : "",
        siteCount: qs("#site-count") ? qs("#site-count").value : "",
        launchContext: qs("#launch-context-intent") ? qs("#launch-context-intent").value : "",
        plan: planSelect ? planSelect.value : "",
        budget: qs("#budget") ? qs("#budget").value : "",
        pain: qs("#pain") ? qs("#pain").value.trim() : "",
        purchaseIntent: qs("#purchase-intent") ? qs("#purchase-intent").checked : false,
        createdAt: new Date().toISOString(),
        utm: getUtm(),
      };
      const intents = readArray(INTENT_KEY);
      intents.push(intent);
      writeArray(INTENT_KEY, intents.slice(-100));

      const remoteHref = buildRemoteIssue(intent);
      if (remoteLink) remoteLink.href = remoteHref;
      if (handoff) {
        handoff.hidden = false;
        pulseClass(handoff, "is-confirmed", 700);
      }
      if (status) status.textContent = "You are on the early access list. Public-safe request details are ready.";

      track("waitlist_submitted", { role: intent.role, plan: intent.plan, siteCount: intent.siteCount });
      track("feedback_submitted", { triggerSource: "waitlist_form", painLength: intent.pain.length });
      track("remote_intent_ready", { hasRemoteLink: Boolean(remoteHref) });
      if (intent.purchaseIntent) track("checkout_intent", { plan: intent.plan, budget: intent.budget });
    });

    if (copyRequest) {
      copyRequest.addEventListener("click", function () {
        if (!state.lastRemoteBody) return;
        copyText(state.lastRemoteBody).then(function () {
          copyRequest.textContent = "Copied request details";
          pulseClass(copyRequest, "is-confirmed", 700);
          track("remote_intent_copied", { bodyLength: state.lastRemoteBody.length });
          window.setTimeout(function () { copyRequest.textContent = "Copy request details"; }, 1500);
        });
      });
    }
  }

  function setupPlanButtons() {
    const waitlist = qs("#waitlist");
    const planSelect = qs("#plan");
    qsa(".plan-button").forEach(function (button) {
      button.addEventListener("click", function () {
        const plan = button.getAttribute("data-plan") || "";
        if (planSelect && plan) planSelect.value = plan;
        track("pricing_viewed", { triggerSource: "plan_button" });
        state.pricingTracked = true;
        track("checkout_started", { plan: plan, triggerSource: "pricing_button" });
        pulseClass(button, "is-confirmed", 500);
        if (waitlist) waitlist.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function setupTracking() {
    track("landing_viewed", { product: "Canonical Drift QA Briefs" });
    qsa("[data-track-cta]").forEach(function (element) {
      element.addEventListener("click", function () {
        track("cta_clicked", { cta: element.getAttribute("data-track-cta") || element.textContent.trim() });
      });
    });
    const pricing = qs("#pricing");
    if (pricing && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !state.pricingTracked) {
            state.pricingTracked = true;
            track("pricing_viewed", { triggerSource: "scroll" });
            observer.disconnect();
          }
        });
      }, { threshold: 0.35 });
      observer.observe(pricing);
    }
  }

  function setupChrome() {
    const header = qs("[data-header]");
    if (!header) return;
    function updateHeader() {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    }
    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });
  }

  function setupReveal() {
    const elements = qsa(".reveal");
    if (!("IntersectionObserver" in window)) {
      elements.forEach(function (element) { element.classList.add("is-visible"); });
      return;
    }
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    elements.forEach(function (element) { observer.observe(element); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    setupTracking();
    setupChrome();
    setupReveal();
    setupAuditor();
    setupWaitlist();
    setupPlanButtons();
  });
}());
