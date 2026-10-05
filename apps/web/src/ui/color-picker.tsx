import { type TagColor, tagColorNames } from '@rooster/tokens';
import { Check } from 'lucide-react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

/** Static class strings so Tailwind sees every swatch (03 §2.4). */
const swatchClasses: Record<TagColor, string> = {
  gray: 'bg-tag-gray-bg border-tag-gray-fg text-tag-gray-fg',
  red: 'bg-tag-red-bg border-tag-red-fg text-tag-red-fg',
  orange: 'bg-tag-orange-bg border-tag-orange-fg text-tag-orange-fg',
  amber: 'bg-tag-amber-bg border-tag-amber-fg text-tag-amber-fg',
  green: 'bg-tag-green-bg border-tag-green-fg text-tag-green-fg',
  teal: 'bg-tag-teal-bg border-tag-teal-fg text-tag-teal-fg',
  blue: 'bg-tag-blue-bg border-tag-blue-fg text-tag-blue-fg',
  indigo: 'bg-tag-indigo-bg border-tag-indigo-fg text-tag-indigo-fg',
  purple: 'bg-tag-purple-bg border-tag-purple-fg text-tag-purple-fg',
  pink: 'bg-tag-pink-bg border-tag-pink-fg text-tag-pink-fg',
};

export interface ColorPickerProps {
  label: string;
  value: TagColor;
  onChange: (color: TagColor) => void;
  isDisabled?: boolean;
  className?: string | undefined;
}

/** The ten tag-palette colours as a radio group; the selection shows a check, not just a ring. */
export function ColorPicker({
  label,
  value,
  onChange,
  isDisabled = false,
  className,
}: ColorPickerProps) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      value={value}
      onChange={(next) => {
        const color = tagColorNames.find((c) => c === next);
        if (color) onChange(color);
      }}
      orientation="horizontal"
      isDisabled={isDisabled}
      className={cn('flex flex-col gap-1.5', className)}
    >
      <Label className="text-sm font-medium text-text-secondary">{label}</Label>
      <div className="flex flex-wrap">
        {tagColorNames.map((color) => (
          <Radio
            key={color}
            value={color}
            aria-label={t(`color.${color}`)}
            className={cn(
              'group inline-flex size-control-sm cursor-default items-center justify-center rounded-full',
              'pointer-coarse:size-hit-touch',
              'outline-offset-0 focus-ring:outline-2 focus-ring:outline-border-focus',
              'data-disabled:cursor-not-allowed data-disabled:opacity-50',
            )}
          >
            <span
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-full border transition-shadow duration-(--dur-fast) ease-standard group-hover:shadow-sm',
                swatchClasses[color],
              )}
            >
              <Check
                className="size-3 opacity-0 group-data-selected:opacity-100"
                strokeWidth={iconStrokeWidth}
                aria-hidden
              />
            </span>
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}
