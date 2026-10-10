import type { Page } from '@playwright/test';

/**
 * Synthetic images for the demo team, drawn on a canvas in the browser with the app's own font
 * (Geist), so they look the same on every machine: avatars (initials on abstract shapes, no
 * photos) and attachment images. Run on a loaded app page.
 */

export interface AvatarSpec {
  initials: string;
  /** Two colours for the background gradient and a third for the shapes. */
  colors: [string, string, string];
  /** Picks the shape layout. */
  variant: number;
}

type Drawing =
  | { kind: 'avatar'; spec: AvatarSpec }
  | { kind: 'moodboard' }
  | { kind: 'wireframe' }
  | { kind: 'typefaces' };

async function draw(page: Page, drawing: Drawing): Promise<Buffer> {
  const base64 = await page.evaluate(async (d: Drawing) => {
    await Promise.all([
      document.fonts.load('600 64px "Geist Variable"'),
      document.fonts.load('400 24px "Geist Variable"'),
      document.fonts.load('500 20px "Geist Mono Variable"'),
    ]);
    const size =
      d.kind === 'avatar'
        ? { w: 256, h: 256 }
        : d.kind === 'typefaces'
          ? { w: 1400, h: 900 }
          : { w: 1600, h: 1000 };
    const canvas = new OffscreenCanvas(size.w, size.h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    const sans = '"Geist Variable", sans-serif';
    const mono = '"Geist Mono Variable", monospace';
    const roundRect = (x: number, y: number, w: number, h: number, r: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
    };

    if (d.kind === 'avatar') {
      const { initials, colors, variant } = d.spec;
      const g = ctx.createLinearGradient(0, 0, 256, 256);
      g.addColorStop(0, colors[0]);
      g.addColorStop(1, colors[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = colors[2];
      const shapes = [
        () => {
          ctx.beginPath();
          ctx.arc(210, 40, 110, 0, Math.PI * 2);
          ctx.fill();
        },
        () => {
          ctx.beginPath();
          ctx.arc(30, 230, 120, 0, Math.PI * 2);
          ctx.fill();
        },
        () => {
          ctx.beginPath();
          ctx.moveTo(0, 256);
          ctx.lineTo(256, 90);
          ctx.lineTo(256, 256);
          ctx.fill();
        },
        () => {
          ctx.beginPath();
          ctx.ellipse(128, 250, 170, 70, 0, 0, Math.PI * 2);
          ctx.fill();
        },
        () => {
          for (let i = 0; i < 3; i += 1) {
            ctx.beginPath();
            ctx.arc(60 + i * 70, 200 - i * 60, 46, 0, Math.PI * 2);
            ctx.fill();
          }
        },
      ];
      shapes[variant % shapes.length]?.();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 104px ${sans}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, 128, 136);
    } else if (d.kind === 'moodboard') {
      ctx.fillStyle = '#f6f1ea';
      ctx.fillRect(0, 0, 1600, 1000);
      const swatches = [
        ['#b4532a', 'Clay'],
        ['#d9a35b', 'Honey'],
        ['#6f7d4f', 'Sage'],
        ['#2f4a3a', 'Juniper'],
        ['#e8d9c4', 'Oat'],
        ['#3b2f2a', 'Bark'],
      ] as const;
      swatches.forEach(([hex, name], i) => {
        const x = 80 + (i % 3) * 300;
        const y = 80 + Math.floor(i / 3) * 430;
        roundRect(x, y, 260, 300, 18, hex);
        ctx.fillStyle = '#3b2f2a';
        ctx.font = `600 30px ${sans}`;
        ctx.fillText(name, x, y + 345);
        ctx.font = `500 22px ${mono}`;
        ctx.fillStyle = '#7a6b60';
        ctx.fillText(hex.toUpperCase(), x, y + 380);
      });
      // A pressed-leaf motif and a tea tin silhouette on the right.
      ctx.save();
      ctx.translate(1240, 330);
      for (let i = 0; i < 7; i += 1) {
        ctx.rotate(Math.PI / 3.6);
        ctx.fillStyle = i % 2 ? '#6f7d4f' : '#2f4a3a';
        ctx.beginPath();
        ctx.ellipse(0, -120, 34, 110, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      roundRect(1110, 640, 260, 300, 26, '#2f4a3a');
      roundRect(1110, 620, 260, 50, 14, '#b4532a');
      ctx.fillStyle = '#f6f1ea';
      ctx.font = `600 34px ${sans}`;
      ctx.textAlign = 'center';
      ctx.fillText('J&F', 1240, 810);
      ctx.textAlign = 'start';
    } else if (d.kind === 'wireframe') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1600, 1000);
      roundRect(0, 0, 1600, 56, 0, '#eceef2');
      ['#f87171', '#fbbf24', '#34d399'].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(32 + i * 26, 28, 8, 0, Math.PI * 2);
        ctx.fill();
      });
      roundRect(140, 14, 900, 28, 14, '#ffffff');
      roundRect(80, 96, 160, 36, 8, '#2f4a3a');
      for (let i = 0; i < 3; i += 1) roundRect(940 + i * 140, 104, 100, 20, 10, '#d5d9e0');
      roundRect(1400, 94, 140, 44, 22, '#d9a35b');
      // Hero copy and the image placeholder.
      roundRect(80, 230, 620, 56, 10, '#3b2f2a');
      roundRect(80, 300, 520, 56, 10, '#3b2f2a');
      for (let i = 0; i < 3; i += 1) roundRect(80, 400 + i * 34, 560 - i * 60, 18, 9, '#c4c9d2');
      roundRect(80, 540, 200, 56, 28, '#b4532a');
      roundRect(300, 540, 180, 56, 28, '#eceef2');
      roundRect(800, 200, 720, 470, 20, '#eceef2');
      ctx.strokeStyle = '#c4c9d2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(800, 200);
      ctx.lineTo(1520, 670);
      ctx.moveTo(1520, 200);
      ctx.lineTo(800, 670);
      ctx.stroke();
      for (let i = 0; i < 3; i += 1) {
        roundRect(80 + i * 490, 740, 450, 200, 16, '#f6f1ea');
        roundRect(110 + i * 490, 775, 60, 60, 30, '#d9a35b');
        roundRect(190 + i * 490, 785, 220, 18, 9, '#3b2f2a');
        roundRect(190 + i * 490, 815, 180, 14, 7, '#c4c9d2');
      }
    } else {
      ctx.fillStyle = '#fbfaf7';
      ctx.fillRect(0, 0, 1400, 900);
      const pairs = [
        ['600 76px Georgia, serif', 'Steeped slowly.', 'Serif display / Geist body'],
        [`600 76px ${sans}`, 'Steeped slowly.', 'Geist display / Geist body'],
        ['italic 500 76px Georgia, serif', 'Steeped slowly.', 'Serif italic / Geist body'],
      ] as const;
      pairs.forEach(([font, sample, label], i) => {
        const y = 150 + i * 260;
        ctx.fillStyle = '#2f4a3a';
        ctx.font = font;
        ctx.fillText(sample, 80, y);
        ctx.fillStyle = '#5b6470';
        ctx.font = `400 26px ${sans}`;
        ctx.fillText('Small-batch teas, blended in the hills and packed by hand.', 80, y + 56);
        ctx.font = `500 20px ${mono}`;
        ctx.fillStyle = '#b4532a';
        ctx.fillText(label.toUpperCase(), 80, y + 100);
      });
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, drawing);
  return Buffer.from(base64, 'base64');
}

export const avatarPng = (page: Page, spec: AvatarSpec) => draw(page, { kind: 'avatar', spec });
export const moodboardPng = (page: Page) => draw(page, { kind: 'moodboard' });
export const wireframePng = (page: Page) => draw(page, { kind: 'wireframe' });
export const typefacesPng = (page: Page) => draw(page, { kind: 'typefaces' });

/** A small, valid one-page PDF (a project brief), written by hand: no PDF library needed. */
export function briefPdf(): Buffer {
  const lines = [
    'Juniper & Finch Tea - Website refresh',
    '',
    'Goals: a warmer, more tactile homepage; product pages that tell',
    'the story of each blend; a simple subscription flow.',
    '',
    'Deliverables: three hero directions, typography pairing,',
    'homepage and product page designs, a small illustration set.',
    '',
    'Timeline: concepts in two weeks, final designs in six.',
  ];
  const text = lines
    .map((line, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${740 - i * 22} Td (${line}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
