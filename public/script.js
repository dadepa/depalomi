// =====================================================
// DEPALOMI.COM — Global Scripts
// =====================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSharedLayout();
  initSiteChrome();
  initPageBehaviors();
});

async function loadSharedLayout() {
  const navMount = document.querySelector('[data-site-nav]');
  const footerMount = document.querySelector('[data-site-footer]');
  const sharedBase = getSharedBase();

  const tasks = [];

  if (navMount) {
    tasks.push(
      fetch(`${sharedBase}partials/nav.html`)
        .then(r => {
          if (!r.ok) throw new Error('Nav konnte nicht geladen werden');
          return r.text();
        })
        .then(html => { navMount.outerHTML = html; })
    );
  }

  if (footerMount) {
    tasks.push(
      fetch(`${sharedBase}partials/footer.html`)
        .then(r => {
          if (!r.ok) throw new Error('Footer konnte nicht geladen werden');
          return r.text();
        })
        .then(html => { footerMount.outerHTML = html; })
    );
  }

  try {
    await Promise.all(tasks);
  } catch (err) {
    console.error(err);
  }
}

function getSharedBase() {
  const scriptSrc = Array.from(document.scripts)
    .map(script => script.getAttribute('src') || '')
    .find(src => /script\.js($|\?)/.test(src));

  if (!scriptSrc) return '/';

  if (scriptSrc.startsWith('../public/')) return '../public/';
  if (scriptSrc.startsWith('/')) return '/';

  const parts = scriptSrc.split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : './';
}

function initSiteChrome() {
  const nav = document.querySelector('nav');
  if (nav) {
    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ----- Mobile burger menu -----
  const burger = document.querySelector('.nav-burger');
  const navLinks = document.querySelector('.nav-links');

  if (burger && navLinks) {
    const closeMenu = () => {
      navLinks.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
      burger.querySelectorAll('span').forEach(s => { s.style.transform = ''; s.style.opacity = ''; });
      if (window.scrollY <= 40) nav.classList.remove('scrolled');
    };

    burger.addEventListener('click', () => {
      const isOpen = navLinks.classList.toggle('open');
      burger.setAttribute('aria-expanded', isOpen);
      burger.querySelectorAll('span')[0].style.transform = isOpen ? 'rotate(45deg) translate(4px, 4px)' : '';
      burger.querySelectorAll('span')[1].style.opacity = isOpen ? '0' : '1';
      burger.querySelectorAll('span')[2].style.transform = isOpen ? 'rotate(-45deg) translate(4px, -4px)' : '';
      if (isOpen) nav.classList.add('scrolled');
      else if (window.scrollY <= 40) nav.classList.remove('scrolled');
    });

    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', closeMenu);
    });
  }

  // ----- Active nav link -----
  const currentPath = window.location.pathname === '/' ? '/index.html' : window.location.pathname;
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath) {
      link.classList.add('active');
    }
  });
}

function initPageBehaviors() {
  // ----- Service cards → subpages -----
  document.querySelectorAll('.service-card[data-href]').forEach(card => {
    card.addEventListener('click', () => {
      window.location.href = card.dataset.href;
    });
  });

  // ----- Intersection observer for fade-in -----
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}
