import './site.css';

/** Copy buttons on the code blocks: the block's text, without the button. */
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const label = button.querySelector('span');
  const original = label?.textContent ?? '';
  button.addEventListener('click', async () => {
    const code = button.parentElement?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    if (!label) return;
    label.textContent = button.dataset.copied ?? original;
    window.setTimeout(() => {
      label.textContent = original;
    }, 2000);
  });
}

/** The parser demo loads when its section comes near (it carries the core parser). */
const demo = document.querySelector<HTMLElement>('[data-demo]');
if (demo) {
  const load = () => {
    void import('./demo.ts').then(({ mountDemo }) => mountDemo(demo));
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(demo);
  } else {
    load();
  }
}
