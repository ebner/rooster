import type { ChromeCopy } from './en.ts';

/**
 * The Swedish chrome of the site's guide pages (header, footer, guide navigation, 404). The
 * landing page is English only (ADR 0070, amended 2026-11-18).
 */
export const sv: ChromeCopy = {
  lang: 'sv',
  otherLanguage: 'English',
  meta: {
    ogAlt: 'roosters logga bredvid uppgiftslistan',
  },
  nav: {
    skip: 'Hoppa till innehållet',
    features: 'Funktioner',
    selfHost: 'Kör själv',
    guide: 'Användarguide',
    github: 'GitHub',
    menu: 'Huvudmeny',
    language: 'Språk',
  },
  footer: {
    tagline: 'En lugn uppgiftslista, byggd för tangentbordet.',
    project: 'Projektet',
    docs: 'Dokumentation',
    source: 'Källkod',
    changelog: 'Ändringslogg',
    security: 'Säkerhet',
    contributing: 'Bidra',
    license: 'Licens (AGPL-3.0)',
    notices: 'Tredjepartslicenser',
    userGuide: 'Användarguide',
    operatorGuide: 'Driftguide',
    signIn: 'Inloggning',
    copyright: '© 2026 Hannes Ebner. Personerna och företagen i skärmbilderna är påhittade.',
  },
  guide: {
    title: 'Användarguide',
    intro:
      'Så fungerar rooster, sida för sida. Samma guide finns inbyggd i appen på `/help`, där den också fungerar offline.',
    pages: 'Sidor',
    previous: 'Föregående',
    next: 'Nästa',
    edit: 'Redigera sidan på GitHub',
    home: 'rooster',
  },
  code: {
    copy: 'Kopiera',
    copied: 'Kopierat',
  },
  notFound: {
    title: 'Sidan finns inte',
    body: 'Det finns inget på den här adressen.',
    home: 'Till startsidan',
  },
};
