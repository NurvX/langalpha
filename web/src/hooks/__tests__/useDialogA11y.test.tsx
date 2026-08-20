import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useDialogA11y } from '../useDialogA11y';

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useDialogA11y<HTMLDivElement>(onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="probe" tabIndex={-1}>
      <button>first</button>
      <button>middle</button>
      <button>last</button>
    </div>
  );
}

describe('useDialogA11y', () => {
  it('moves focus into the dialog on open', () => {
    render(<Dialog onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab from the last control back to the first', () => {
    render(<Dialog onClose={vi.fn()} />);
    screen.getByText('last').focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('wraps Shift+Tab from the first control to the last', () => {
    render(<Dialog onClose={vi.fn()} />);
    screen.getByText('first').focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });

  it('leaves Tab alone in the middle of the dialog', () => {
    render(<Dialog onClose={vi.fn()} />);
    const middle = screen.getByText('middle');
    middle.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(middle);
  });

  it('returns focus to the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Dialog onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
