/* Sales FM: measure booking intent, never an appointment completion. */
(function () {
  'use strict';
  if (window.__sfmBookingClickBound) return;
  window.__sfmBookingClickBound = true;
  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;
    var url;
    try { url = new URL(link.href, document.baseURI); } catch (error) { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'link.salesfunnelmarketing.us' ||
        !/^\/widget\/bookings\/[^/]+\/?$/.test(url.pathname)) return;
    // Exclude query strings, fragments, form values and personal contact data.
    var params = {link_url: url.origin + url.pathname, page_path: window.location.pathname, measurement_stage: 'booking_intent'};
    // Use existing analytics/pixel initialization; do not override consent.
    try { if (typeof window.gtag === 'function') window.gtag('event', 'booking_click', params); } catch (error) {}
    try { if (typeof window.fbq === 'function') window.fbq('trackCustom', 'BookingClick', params); } catch (error) {}
  }, true);
}());
