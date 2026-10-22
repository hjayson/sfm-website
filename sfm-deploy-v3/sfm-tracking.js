/* Booking and phone clicks indicate intent, not a completed appointment or call. */
(function () {
  'use strict';
  if (window.sfmClickTrackingInstalled) return;
  window.sfmClickTrackingInstalled = true;

  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;
    var destination;
    try { destination = new URL(link.href, window.location.href); } catch (_) { return; }
    var isPhone = destination.protocol === 'tel:';
    var isBooking = destination.protocol === 'https:' &&
      destination.hostname === 'link.salesfunnelmarketing.us' &&
      destination.pathname.indexOf('/widget/bookings/') === 0;
    if (!isPhone && !isBooking) return;

    var parameters = {
      page_path: window.location.pathname,
      cta_location: link.getAttribute('data-cta-location') ||
        (link.closest('nav') ? 'navigation' : link.closest('footer') ? 'footer' : 'body'),
      transport_type: 'beacon',
      send_to: 'G-CDLWCX753N'
    };
    // Never send query strings, contact form fields, or visitor details.
    if (isBooking) parameters.link_url = destination.origin + destination.pathname;
    if (window.location.pathname.replace(/\.html$/, '') === '/sfm-homebuilders') {
      parameters.page_category = 'homebuilders';
    }
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', isPhone ? 'call_click' : 'booking_click', parameters);
      }
    } catch (_) { /* Tracking must never interrupt navigation. */ }
    try {
      if (typeof window.fbq === 'function') {
        if (isPhone) window.fbq('track', 'Contact', {content_name: 'Phone Click'});
        else window.fbq('trackCustom', 'BookingClick', {content_name: 'Booking Click', cta_location: parameters.cta_location});
      }
    } catch (_) { /* Preserve the user's click if a vendor script fails. */ }
  }, true);
}());
