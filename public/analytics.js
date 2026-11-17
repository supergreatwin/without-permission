(() => {
  const id = document.currentScript.dataset.measurementId;
  if (location.origin !== 'https://without-permission.pages.dev' || !/^G-[A-Z0-9]{10}$/.test(id)) return;

  const key = 'analytics-consent-v1';
  const arabic = document.documentElement.lang.startsWith('ar');
  const labels = arabic ? {
    name: 'إعدادات التحليلات', title: 'تحليلات الموقع',
    description: 'تساعد إحصاءات Google في فهم زيارات الموقع والنقرات على الروابط. يمكنك الرفض وتغيير اختيارك في أي وقت.',
    accept: 'السماح بالتحليلات', reject: 'رفض التحليلات', close: 'إغلاق', privacy: 'خصوصية Google',
  } : {
    name: 'Analytics settings', title: 'Website analytics',
    description: 'Google Analytics helps measure visits and link clicks. You can decline and change your choice at any time.',
    accept: 'Allow analytics', reject: 'Decline analytics', close: 'Close', privacy: 'Google privacy',
  };
  let choice;
  try { choice = localStorage.getItem(key); } catch {}

  let started = false;
  function start() {
    if (started) return;
    started = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window['ga-disable-' + id] = false;
    window.gtag('consent', 'default', {
      analytics_storage: 'granted', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied',
    });
    window.gtag('js', new Date());
    window.gtag('config', id, {
      allow_google_signals: false, allow_ad_personalization_signals: false,
      page_location: location.origin + location.pathname, page_referrer: document.referrer
        ? new URL(document.referrer).origin : '',
    });
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    document.head.append(script);
  }

  function save(value) {
    choice = value;
    try { localStorage.setItem(key, value); } catch {}
    window['ga-disable-' + id] = value !== 'granted';
    if (value === 'granted') {
      start();
      window.gtag('consent', 'update', { analytics_storage: 'granted' });
    } else if (started) {
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
      for (const name of document.cookie.split(';').map(cookie => cookie.trim().split('=')[0])) {
        if (name === '_ga' || name === '_ga_' + id.slice(2)) {
          document.cookie = name + '=; Max-Age=0; Path=/';
          document.cookie = name + '=; Max-Age=0; Path=/; Domain=' + location.hostname;
        }
      }
    }
  }

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'analytics-settings';
  settings.textContent = labels.name;
  const dialog = document.createElement('dialog');
  dialog.className = 'analytics-dialog';
  dialog.setAttribute('aria-label', labels.title);
  const heading = document.createElement('h2');
  heading.textContent = labels.title;
  const description = document.createElement('p');
  description.textContent = labels.description;
  const privacy = document.createElement('a');
  privacy.href = 'https://policies.google.com/privacy';
  privacy.textContent = labels.privacy;
  const actions = document.createElement('div');
  actions.className = 'analytics-actions';

  for (const [text, value] of [[labels.reject, 'denied'], [labels.accept, 'granted'], [labels.close, null]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () => {
      if (value) save(value);
      dialog.close();
    });
    actions.append(button);
  }
  dialog.append(heading, description, privacy, actions);
  (document.querySelector('footer') || document.body).append(settings);
  document.body.append(dialog);
  settings.addEventListener('click', () => {
    if (dialog.open) dialog.close();
    dialog.showModal();
  });
  if (choice === 'granted') start();
  else if (choice !== 'denied') dialog.show();

  document.addEventListener('click', event => {
    if (choice !== 'granted' || !started) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link === privacy) return;
    const target = new URL(link.href);
    if (target.protocol === 'mailto:' || target.protocol === 'tel:') {
      window.gtag('event', 'contact_click', { method: target.protocol.slice(0, -1) });
    } else if (['http:', 'https:'].includes(target.protocol) && target.origin !== location.origin) {
      window.gtag('event', 'outbound_click', { outbound: true, link_domain: target.hostname });
      if (target.origin === 'https://withouts-newsletter.beehiiv.com' && target.pathname === '/subscribe') {
        window.gtag('event', 'newsletter_signup_click');
      }
    }
  });

  let pitchRecorded = false;
  window.addEventListener('message', event => {
    if (choice !== 'granted' || !started || pitchRecorded || event.origin !== 'https://tally.so') return;
    const pitchForm = [...document.querySelectorAll('iframe')].find(frame =>
      frame.contentWindow === event.source && frame.src.startsWith('https://tally.so/embed/je61rx?')
    );
    if (!pitchForm || typeof event.data !== 'string') return;
    try {
      const { event: name, payload } = JSON.parse(event.data);
      if (name !== 'Tally.FormSubmitted' || payload?.formId !== 'je61rx') return;
    } catch { return; }
    pitchRecorded = true;
    window.gtag('event', 'generate_lead', { method: 'pitch_form' });
  });
})();
