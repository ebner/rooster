import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { TaskCheckbox } from './task-checkbox';

function Controlled({ onChange }: { onChange: (v: boolean) => void }) {
  const [done, setDone] = useState(false);
  return (
    <TaskCheckbox
      aria-label={done ? 'Mark “Pay rent” incomplete' : 'Mark “Pay rent” complete'}
      isSelected={done}
      onChange={(v) => {
        setDone(v);
        onChange(v);
      }}
    />
  );
}

describe('TaskCheckbox', () => {
  test('is a labelled native checkbox that toggles', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Mark “Pay rent” complete' });
    expect(box).toHaveProperty('checked', false);

    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(true);
    const done = screen.getByRole('checkbox', { name: 'Mark “Pay rent” incomplete' });
    expect(done).toHaveProperty('checked', true);

    fireEvent.click(done);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
  });

  test('pops only after a user completion, not when rendered done', () => {
    const done = render(<TaskCheckbox aria-label="Done task" defaultSelected />);
    expect(done.container.innerHTML).not.toContain('animate-check-pop');

    const open = render(<TaskCheckbox aria-label="Open task" />);
    fireEvent.click(open.getByRole('checkbox', { name: 'Open task' }));
    expect(open.container.innerHTML).toContain('animate-check-pop');
  });

  test('disabled checkbox is a disabled native input', () => {
    render(<TaskCheckbox aria-label="Locked" isDisabled />);
    expect(screen.getByRole('checkbox', { name: 'Locked' })).toHaveProperty('disabled', true);
  });
});
