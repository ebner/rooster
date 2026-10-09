import { type CSSProperties, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import {
  markEye,
  markEyeRadius,
  markGrid,
  markLine,
  markOpticalShift,
  markPaint,
  markSmallBelow,
  markSmallTransform,
  markStroke,
  wordmarkPath,
  wordmarkViewBox,
} from './brand';
import './logo.css';

/** `default` ink on light grounds, `inverse` white line, `muted` the empty-state grey. */
export type LogoTone = 'default' | 'inverse' | 'muted';

/** Sizes are CSS px at UI scale 1; they render in rem, so they follow the desktop scale. */
const rem = (px: number) => `${px / 16}rem`;

/** The draw-in plays once per page load, however often a screen with it mounts. */
let drawnThisLoad = false;

export interface LogoMarkProps {
  /** Rendered size in px at scale 1 (default 24). Below 24 the heavier small cut is used. */
  size?: number;
  /**
   * Draw the line and paint the comb on mount (03 §2.10: primary placements only). `true`
   * plays once per page load; `'always'` on every mount (the kitchen sink's replay).
   */
  animated?: boolean | 'always';
  tone?: LogoTone;
  /** An accessible name; without one the mark is decorative. */
  label?: string;
  className?: string;
  style?: CSSProperties | undefined;
}

/** The rooster head (03 §2.10, ADR 0026). */
export function LogoMark({
  size = 24,
  animated = false,
  tone = 'default',
  label,
  className,
  style,
}: LogoMarkProps) {
  const id = useId();
  const [draw] = useState(() => animated === 'always' || (animated && !drawnThisLoad));
  useEffect(() => {
    if (draw) drawnThisLoad = true;
  }, [draw]);
  const small = size < markSmallBelow;
  const stroke = small ? markStroke.small : markStroke.regular;

  const body = (
    <>
      {markPaint.map((area, i) => {
        const mask = `${id}-paint-${i}`;
        return (
          <g key={area.d}>
            {draw && (
              <mask
                id={mask}
                maskUnits="userSpaceOnUse"
                x={-4}
                y={-4}
                width={markGrid + 8}
                height={markGrid + 8}
              >
                <path
                  className="brush"
                  data-step={i}
                  pathLength={1}
                  strokeWidth={area.brushWidth}
                  transform={area.transform}
                  d={area.brush}
                />
              </mask>
            )}
            <path
              className="paint"
              transform={area.transform}
              mask={draw ? `url(#${mask})` : undefined}
              d={area.d}
            />
          </g>
        );
      })}
      <path className="ink" pathLength={1} strokeWidth={stroke} d={markLine} />
      <circle
        className="eye"
        cx={markEye.cx}
        cy={markEye.cy}
        r={small ? markEyeRadius.small : markEyeRadius.regular}
      />
    </>
  );

  const svgProps = {
    viewBox: `0 0 ${markGrid} ${markGrid}`,
    className: cn('rooster-mark shrink-0', className),
    style: { width: rem(size), height: rem(size), ...style },
    'data-tone': tone,
    'data-drawing': draw ? '' : undefined,
  };
  const content = small ? <g transform={markSmallTransform}>{body}</g> : body;
  return label ? (
    <svg {...svgProps} role="img" aria-label={label}>
      {content}
    </svg>
  ) : (
    <svg {...svgProps} aria-hidden>
      {content}
    </svg>
  );
}

export interface WordmarkProps {
  /** Height of the lettering box in px at scale 1. */
  height?: number;
  /** Decorative when it sits next to visible text that already names the app. */
  decorative?: boolean;
  className?: string;
}

/** "rooster" in outlined Fraunces; takes the current text colour. */
export function Wordmark({ height = 11, decorative = false, className }: WordmarkProps) {
  const { t } = useTranslation();
  const { width: w, height: h } = wordmarkViewBox;
  const svgProps = {
    viewBox: `0 0 ${w} ${h}`,
    className: cn('shrink-0 text-text', className),
    style: { height: rem(height), width: rem((height * w) / h) },
  };
  const path = <path fill="currentColor" d={wordmarkPath} />;
  return decorative ? (
    <svg {...svgProps} aria-hidden>
      {path}
    </svg>
  ) : (
    <svg {...svgProps} role="img" aria-label={t('app.name')}>
      {path}
    </svg>
  );
}

export interface LogoProps {
  /** `row`: mark beside the name (sidebar, page headers); `stack`: mark above (sign-in). */
  layout?: 'row' | 'stack';
  /** The mark's size in px at scale 1; the name is sized from it. */
  size?: number;
  animated?: boolean | 'always';
  className?: string;
}

/** Mark and name together, the one way the brand appears in the app (03 §2.10). */
export function Logo({ layout = 'row', size = 24, animated = false, className }: LogoProps) {
  const { t } = useTranslation();
  const stack = layout === 'stack';
  return (
    <span
      role="img"
      aria-label={t('app.name')}
      className={cn(
        'inline-flex shrink-0',
        stack ? 'flex-col items-center gap-2' : 'items-center gap-1.5',
        className,
      )}
    >
      <LogoMark
        size={size}
        animated={animated}
        // The head sits right of centre in its square; centre it over the name.
        style={stack ? { marginInlineStart: rem(-size * markOpticalShift) } : undefined}
      />
      <Wordmark decorative height={size * (stack ? 0.3 : 0.45)} />
    </span>
  );
}
