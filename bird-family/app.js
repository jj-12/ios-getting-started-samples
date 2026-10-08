/*
 * Support the Bird Family — page behaviour
 *
 *  - Loads analytics (Google Analytics 4 and/or Plausible) only when an ID is
 *    set in config.js, and only if the visitor hasn't asked not to be tracked.
 *  - Sends a named event for every element with a data-track attribute
 *    (donate buttons, article links, copy/share buttons) so you can see which
 *    channels people actually use.
 *  - Copy-to-clipboard for the account number and the page link.
 *  - Native "Share…" button on phones that support it.
 */
(function () {
  'use strict';

  var cfg = window.SITE_CONFIG || {};
  var analytics = cfg.analytics || {};

  /* ---------------- Analytics ---------------- */

  function doNotTrack() {
    if (!analytics.respectDoNotTrack) return false;
    return navigator.doNotTrack === '1' ||
           window.doNotTrack === '1' ||
           navigator.globalPrivacyControl === true;
  }

  var analyticsEnabled = false;

  function loadScript(src, attrs) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
    document.head.appendChild(s);
  }

  function initAnalytics() {
    if (doNotTrack()) return;
    if (location.protocol === 'file:') return; // local preview: don't send hits

    if (analytics.ga4MeasurementId) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', analytics.ga4MeasurementId, { anonymize_ip: true });
      loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(analytics.ga4MeasurementId));
      analyticsEnabled = true;
    }

    if (analytics.plausibleDomain) {
      window.plausible = window.plausible || function () {
        (window.plausible.q = window.plausible.q || []).push(arguments);
      };
      loadScript('https://plausible.io/js/script.js', {
        'data-domain': analytics.plausibleDomain,
        defer: ''
      });
      analyticsEnabled = true;
    }
  }

  /** Record a named event, e.g. track('gofundme_click', { location: 'hero' }). */
  function track(name, params) {
    params = params || {};
    if (!analyticsEnabled) {
      if (location.protocol === 'file:' || location.hostname === 'localhost') {
        console.debug('[analytics off] ' + name, params);
      }
      return;
    }
    if (window.gtag && analytics.ga4MeasurementId) window.gtag('event', name, params);
    if (window.plausible && analytics.plausibleDomain) window.plausible(name, { props: params });
  }
  window.trackEvent = track;

  function wireTracking() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-track]');
      if (!el) return;
      track(el.getAttribute('data-track'), {
        location: el.getAttribute('data-location') || '',
        href: el.getAttribute('href') || ''
      });
    });

    // Scroll depth: fire once when the visitor reaches each main section.
    if ('IntersectionObserver' in window) {
      var seen = {};
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && !seen[en.target.id]) {
            seen[en.target.id] = true;
            track('section_view', { section: en.target.id });
          }
        });
      }, { threshold: 0.3 });
      document.querySelectorAll('main section[id]').forEach(function (s) { io.observe(s); });
    }
  }

  /* ---------------- Clipboard & share ---------------- */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); resolve(); } catch (err) { reject(err); }
      document.body.removeChild(ta);
    });
  }

  function flash(btn, label) {
    var original = btn.textContent;
    btn.textContent = label;
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1800);
  }

  function wireCopyButtons() {
    document.querySelectorAll('.copy-btn[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyText(btn.getAttribute('data-copy')).then(
          function () { flash(btn, 'Copied'); },
          function () { flash(btn, 'Press Ctrl+C'); }
        );
      });
    });

    var siteUrl = cfg.siteUrl || location.href;
    var copyLink = document.getElementById('copy-link-btn');
    if (copyLink) {
      copyLink.addEventListener('click', function () {
        copyText(siteUrl).then(
          function () { flash(copyLink, 'Link copied'); },
          function () { flash(copyLink, 'Could not copy'); }
        );
      });
    }

    var shareBtn = document.getElementById('native-share-btn');
    if (shareBtn && navigator.share) {
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', function () {
        navigator.share({
          title: document.title,
          text: 'Remembering Nate Bird and his children. Please consider helping the family.',
          url: siteUrl
        }).catch(function () { /* user cancelled */ });
      });
    }

    var urlLabel = document.getElementById('share-url');
    if (urlLabel && cfg.siteUrl) {
      urlLabel.textContent = cfg.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
  }

  /* ---------------- Boot ---------------- */

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    initAnalytics();
    wireTracking();
    wireCopyButtons();
  });
})();
