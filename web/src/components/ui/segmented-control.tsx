import React from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Accessible name for the group; the row label beside it is not associated. */
  ariaLabel: string;
}

/**
 * Exclusive-choice row of pressed buttons, the Settings shape for theme, font
 * size and turn-end landing. A plain button group rather than a Radix
 * ToggleGroup: it keeps the markup and theme-var styling the rows already
 * shipped, and the pressed state is read by screen readers as a toggle.
 */
export function SegmentedControl<T extends string>({ value, onChange, options, ariaLabel }: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-lg overflow-hidden clips-focus-ring" style={{ border: '1px solid var(--color-border-muted)' }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[0.8125rem] font-medium transition-colors"
            style={{
              backgroundColor: selected ? 'var(--color-accent-soft)' : 'transparent',
              color: selected ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
