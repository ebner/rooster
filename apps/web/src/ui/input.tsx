import { cva, type VariantProps } from 'class-variance-authority';
import {
  Input as AriaInput,
  type InputProps as AriaInputProps,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  FieldError,
  Label,
  Text,
} from 'react-aria-components';
import { cn } from '../lib/cn';

/**
 * 03 §3.6. Touch devices get 44 px and 16 px text (prevents the iOS focus zoom).
 * `inline` is the borderless title input that looks like text.
 */
export const inputVariants = cva(
  [
    'w-full min-w-0 text-text placeholder:text-text-muted',
    'transition-colors duration-(--dur-fast) ease-standard',
    'disabled:cursor-not-allowed disabled:text-text-disabled',
  ],
  {
    variants: {
      variant: {
        default: [
          'h-control rounded-sm border border-border bg-bg-app px-3 text-base',
          'pointer-coarse:h-hit-touch pointer-coarse:text-md',
          'hover:border-border-strong focus-ring:border-border-focus',
          'data-invalid:border-border-danger',
          'disabled:border-border disabled:bg-bg-subtle',
        ],
        inline: 'h-auto rounded-xs border-0 bg-transparent p-0 text-base pointer-coarse:text-md',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface InputProps extends Omit<AriaInputProps, 'className'> {
  variant?: VariantProps<typeof inputVariants>['variant'] | undefined;
  className?: string | undefined;
  'data-force'?: string;
}

/** A bare input; use inside `TextField` (or give it an `aria-label`). */
export function Input({ variant, className, ...props }: InputProps) {
  return <AriaInput {...props} className={cn(inputVariants({ variant }), className)} />;
}

export interface TextFieldProps extends Omit<AriaTextFieldProps, 'className' | 'children'> {
  label: string;
  /** Hide the label visually (it stays the accessible name). */
  hideLabel?: boolean;
  description?: string;
  /** Shown below the field in danger text; also marks the field invalid. */
  errorMessage?: string;
  placeholder?: string;
  variant?: InputProps['variant'] | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
  'data-force'?: string;
}

export function TextField({
  label,
  hideLabel = false,
  description,
  errorMessage,
  placeholder,
  variant,
  className,
  inputClassName,
  'data-force': force,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField
      {...props}
      isInvalid={props.isInvalid ?? Boolean(errorMessage)}
      className={cn('flex flex-col gap-1.5', className)}
    >
      <Label className={cn('text-sm font-medium text-text-secondary', hideLabel && 'sr-only')}>
        {label}
      </Label>
      <Input
        variant={variant}
        className={inputClassName}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(force === undefined ? {} : { 'data-force': force })}
      />
      {description && !errorMessage && (
        <Text slot="description" className="text-sm text-text-muted">
          {description}
        </Text>
      )}
      <FieldError className="text-sm text-text-danger">{errorMessage}</FieldError>
    </AriaTextField>
  );
}
