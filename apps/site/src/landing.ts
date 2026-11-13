import { copyFor, type Lang, langPrefix, repoUrl, type SiteContext } from './config.ts';
import { analyse } from './demo/model.ts';
import { fill, html, inline, raw, type SafeHtml } from './html.ts';
import { type IconName, icon } from './icons.ts';
import { link, type Page } from './layout.ts';

interface ShotOptions {
  /** The `sizes` attribute: how wide the image shows. */
  sizes: string;
  eager?: boolean;
  className?: string;
}

/** A converted screenshot (`<name>.<device>`) with its srcset; see scripts/build.ts. */
export function shot(site: SiteContext, name: string, alt: string, options: ShotOptions): SafeHtml {
  const image = site.images.get(name);
  if (!image) throw new Error(`site: no image ${name}`);
  return html`<img class="${options.className ?? 'shot'}" src="${image.src}" srcset="${image.srcset}" sizes="${options.sizes}" width="${image.width}" height="${image.height}" alt="${alt}" ${raw(options.eager ? 'fetchpriority="high"' : 'loading="lazy"')} decoding="async">`;
}

function codeBlock(code: string, label: string, copy: { copy: string; copied: string }): SafeHtml {
  return html`<div class="code">
    <pre aria-label="${label}"><code>${code}</code></pre>
    <button type="button" class="copy" data-copy data-copied="${copy.copied}">${icon('copy')}<span>${copy.copy}</span></button>
  </div>`;
}

function section(
  id: string,
  kicker: string,
  title: string,
  content: SafeHtml,
  className = '',
): SafeHtml {
  return html`<section id="${id}" class="${`band ${className}`.trim()}" aria-labelledby="${id}-title">
    <div class="wrap">
      <p class="kicker">${kicker}</p>
      <h2 id="${id}-title">${title}</h2>
      ${content}
    </div>
  </section>`;
}

const keyCaps = (keys: readonly string[]) =>
  html`<span class="keys">${keys.map((k, i) => html`${i > 0 ? raw('<span class="plus">+</span>') : ''}<kbd>${k}</kbd>`)}</span>`;

function demo(lang: Lang): SafeHtml {
  const copy = copyFor[lang].dates;
  // The highlighted title is rendered here, so it shows without the script; the parsed
  // result needs today's date and appears once the script runs.
  const initial = analyse(
    copy.initial,
    { today: '2026-01-01', nowMs: 0, timeZone: 'UTC', locale: lang },
    copy,
  );
  return html`<div class="demo" data-demo data-lang="${lang}">
    <label class="demo-label" for="demo-input">${copy.demoLabel}</label>
    <div class="demo-row">
      <span class="demo-check" aria-hidden="true"></span>
      <div class="demo-field">
        <div class="demo-mirror" aria-hidden="true">${initial.segments.map((s) =>
          s.kind === 'text' ? s.text : html`<mark class="tok tok-${s.kind}">${s.text}</mark>`,
        )}</div>
        <input id="demo-input" class="demo-input" type="text" value="${copy.initial}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" aria-describedby="demo-hint">
      </div>
    </div>
    <div class="demo-examples" role="group" aria-label="${copy.examplesLabel}">
      ${copy.examples.map((example) => html`<button type="button" class="chip-button" data-example="${example}">${example}</button>`)}
    </div>
    <div class="demo-result" data-demo-result hidden>
      <p class="demo-result-label">${copy.result.label}</p>
      <div class="demo-saved" data-demo-saved aria-live="polite"></div>
    </div>
    <p id="demo-hint" class="demo-hint">${copy.demoHint}</p>
    <script type="application/json" id="demo-copy">${raw(JSON.stringify(copy).replace(/</g, '\\u003c'))}</script>
  </div>`;
}

const moreIcons: readonly IconName[] = [
  'search',
  'paperclip',
  'calendar-days',
  'bell',
  'archive-restore',
  'languages',
];

export function landingPage(site: SiteContext, lang: Lang): Page {
  const copy = copyFor[lang];
  const prefix = langPrefix(lang);
  const tag = `v${site.version}`;
  const raw_ = (path: string) => `https://raw.githubusercontent.com/ebner/rooster/${tag}/${path}`;
  const blob = (path: string) => `${repoUrl}/blob/${tag}/${path}`;
  const guide = (slug = '') => link(site, `${prefix}guide/${slug ? `${slug}/` : ''}`);
  const codes: Record<string, string> = {
    get: `mkdir rooster && cd rooster\ncurl -fsSLO ${raw_('compose.yaml')}\ncurl -fsSL ${raw_('apps/server/.env.example')} -o .env`,
    env: 'ROOSTER_BASE_URL=https://rooster.example.com\nROOSTER_AUTH_SECRET=        # openssl rand -base64 48\nROOSTER_ADMIN_EMAILS=you@example.com\nROOSTER_GOOGLE_CLIENT_ID=…\nROOSTER_GOOGLE_CLIENT_SECRET=…',
    up: 'docker compose up -d\ndocker compose logs -f rooster',
  };
  const cli = [
    'rooster login --server https://rooster.example.com',
    `rooster add "${copy.terminal.cliTask}"`,
    'rooster today',
    'rooster',
    'rooster mcp setup --client claude-code',
  ].join('\n');

  const body = html`
    <section class="hero" aria-labelledby="hero-title">
      <div class="wrap hero-text">
        <h1 id="hero-title">${copy.hero.title}</h1>
        <p class="lead">${inline(copy.hero.lead)}</p>
        <div class="actions">
          <a class="button primary" href="#self-host">${copy.hero.primary}${icon('arrow-right')}</a>
          <a class="button" href="${guide()}">${copy.hero.secondary}</a>
        </div>
        <p class="facts">${fill(copy.hero.facts, { version: site.version })}</p>
      </div>
      <div class="wrap hero-shots">
        <figure class="frame browser">
          <div class="frame-bar" aria-hidden="true"><span></span><span></span><span></span></div>
          ${shot(site, 'task-pane.desktop', copy.hero.shotAlt, { sizes: '(min-width: 1200px) 1080px, 94vw', eager: true })}
        </figure>
        <figure class="frame phone hero-phone">
          ${shot(site, 'today.phone', copy.hero.phoneAlt, { sizes: '240px', eager: true })}
        </figure>
      </div>
    </section>

    ${section(
      'features',
      copy.editor.kicker,
      copy.editor.title,
      html`<div class="split">
        <div class="prose">
          <p>${inline(copy.editor.body)}</p>
          <p>${inline(copy.editor.groups)}</p>
          <h3 class="small-title">${copy.editor.keysLabel}</h3>
          <dl class="shortcuts">
            ${copy.editor.keys.map((k) => html`<div><dt>${keyCaps(k.keys)}</dt><dd>${k.label}</dd></div>`)}
          </dl>
          <p class="note">${inline(copy.editor.keysNote)}</p>
        </div>
        <figure class="frame">
          ${shot(site, 'palette.desktop', copy.editor.shotAlt, { sizes: '(min-width: 1200px) 620px, 94vw' })}
        </figure>
      </div>`,
    )}

    ${section(
      'dates',
      copy.dates.kicker,
      copy.dates.title,
      html`<div class="split">
        <div class="prose">
          <p>${inline(copy.dates.body)}</p>
          ${demo(lang)}
        </div>
        <figure class="frame narrow">
          ${shot(site, 'date-picker.desktop', copy.dates.pickerAlt, { sizes: '(min-width: 1200px) 420px, 80vw' })}
          <figcaption>${copy.dates.pickerCaption}</figcaption>
        </figure>
      </div>`,
      'tinted',
    )}

    ${section(
      'together',
      copy.team.kicker,
      copy.team.title,
      html`<div class="prose wide">
          <p>${inline(copy.team.body)}</p>
          <ul class="points">${copy.team.points.map((p) => html`<li>${inline(p)}</li>`)}</ul>
        </div>
        <div class="pair">
          <figure class="frame">${shot(site, 'everyone.desktop', copy.team.everyoneAlt, { sizes: '(min-width: 1200px) 540px, 94vw' })}</figure>
          <figure class="frame">${shot(site, 'inbox.desktop', copy.team.inboxAlt, { sizes: '(min-width: 1200px) 540px, 94vw' })}</figure>
        </div>`,
    )}

    ${section(
      'terminal',
      copy.terminal.kicker,
      copy.terminal.title,
      html`<div class="split">
        <div class="prose">
          <p>${inline(copy.terminal.body)}</p>
          ${codeBlock(cli, copy.terminal.cliLabel, copy.code)}
          <p>${inline(copy.terminal.agents)}</p>
          <p><a class="more-link" href="${guide('cli-tui-mcp')}">${copy.terminal.cliDocs}${icon('arrow-right')}</a></p>
        </div>
        <div class="stack">
          ${shot(site, 'tui.desktop', copy.terminal.tuiAlt, { sizes: '(min-width: 1200px) 620px, 94vw', className: 'shot plain' })}
          <figure class="frame">
            ${shot(site, 'device-consent.desktop', copy.terminal.consentAlt, { sizes: '(min-width: 1200px) 620px, 94vw' })}
            <figcaption>${copy.terminal.consentCaption}</figcaption>
          </figure>
        </div>
      </div>`,
      'tinted',
    )}

    ${section(
      'phone',
      copy.phone.kicker,
      copy.phone.title,
      html`<div class="prose wide"><p>${inline(copy.phone.body)}</p></div>
        <div class="phones" role="list">
          ${copy.phone.shots.map((s) => html`<figure class="frame phone" role="listitem">${shot(site, `${s.name}.phone`, s.alt, { sizes: '(min-width: 768px) 240px, 60vw' })}</figure>`)}
        </div>`,
    )}

    <section class="band tinted" aria-labelledby="more-title">
      <div class="wrap">
        <h2 id="more-title">${copy.more.title}</h2>
        <ul class="cards">
          ${copy.more.items.map(
            (item, i) =>
              html`<li class="card">${icon(moreIcons[i] ?? 'check', 20)}<h3>${item.title}</h3><p>${inline(item.body)}</p></li>`,
          )}
        </ul>
      </div>
    </section>

    ${section(
      'self-host',
      copy.host.kicker,
      copy.host.title,
      html`<div class="split host">
        <div class="prose">
          <p>${inline(copy.host.body)}</p>
          <ul class="checks">${copy.host.facts.map((f) => html`<li>${icon('check')}${f}</li>`)}</ul>
        </div>
        <div class="steps-box">
          <h3>${copy.host.stepsTitle}</h3>
          <p class="note">${inline(copy.host.stepsIntro)}</p>
          <ol class="steps">
            ${copy.host.steps.map((s) => html`<li><p>${inline(s.title)}</p>${codeBlock(codes[s.code] ?? '', s.title.replace(/`/g, ''), copy.code)}</li>`)}
          </ol>
          <p class="note">${inline(copy.host.after)}</p>
        </div>
      </div>
      <ul class="link-cards">
        <li><a href="${blob('docs/operator.md')}"><strong>${copy.host.operator}</strong><span>${copy.host.operatorBody}</span></a></li>
        <li><a href="${blob('docs/oidc-setup.md')}"><strong>${copy.host.oidc}</strong><span>${copy.host.oidcBody}</span></a></li>
        <li><a href="${repoUrl}/releases"><strong>${copy.host.releases}</strong><span>${copy.host.releasesBody}</span></a></li>
      </ul>`,
    )}
  `;

  return {
    path: prefix,
    lang,
    alternate: langPrefix(lang === 'en' ? 'sv' : 'en'),
    title: copy.meta.title,
    description: copy.meta.description,
    body,
    animatedLogo: true,
  };
}
