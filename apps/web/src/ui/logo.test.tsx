import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Logo, LogoMark, Wordmark } from './logo';

describe('LogoMark', () => {
  test('is decorative without a label and named with one', () => {
    const { container } = render(<LogoMark />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    render(<LogoMark label="rooster" />);
    expect(screen.getByRole('img', { name: 'rooster' })).toBeTruthy();
  });

  test('sizes in rem so it follows the desktop UI scale', () => {
    const { container } = render(<LogoMark size={64} />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.style.width).toBe('4rem');
    expect(svg.style.height).toBe('4rem');
  });

  test('below 24 px it switches to the heavier small cut', () => {
    const { container } = render(
      <>
        <LogoMark size={16} />
        <LogoMark size={24} />
      </>,
    );
    const [small, regular] = [...container.querySelectorAll('svg')];
    expect(small?.querySelector('.ink')?.getAttribute('stroke-width')).toBe('5');
    expect(small?.querySelector(':scope > g')?.getAttribute('transform')).toContain('scale');
    expect(regular?.querySelector('.ink')?.getAttribute('stroke-width')).toBe('3.5');
  });

  test('the draw-in plays once per page load; "always" replays it', () => {
    const first = render(<LogoMark animated />);
    const drawing = first.container.querySelector('svg') as SVGElement;
    expect(drawing.hasAttribute('data-drawing')).toBe(true);
    // Each painted area is revealed through its own brush mask.
    expect(drawing.querySelectorAll('mask')).toHaveLength(2);
    first.unmount();

    const again = render(<LogoMark animated />);
    const still = again.container.querySelector('svg') as SVGElement;
    expect(still.hasAttribute('data-drawing')).toBe(false);
    expect(still.querySelectorAll('mask')).toHaveLength(0);
    again.unmount();

    const forced = render(<LogoMark animated="always" />);
    expect(forced.container.querySelector('svg')?.hasAttribute('data-drawing')).toBe(true);
  });

  test('a static mark has no masks', () => {
    const { container } = render(<LogoMark tone="muted" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('data-tone')).toBe('muted');
    expect(svg.querySelectorAll('mask')).toHaveLength(0);
    expect(svg.querySelectorAll('.paint')).toHaveLength(2);
  });
});

describe('Wordmark and Logo', () => {
  test('the wordmark is named "rooster" unless decorative', () => {
    render(<Wordmark />);
    expect(screen.getByRole('img', { name: 'rooster' })).toBeTruthy();
    const { container } = render(<Wordmark decorative />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('the logo is one image named "rooster", with mark and name hidden inside', () => {
    render(<Logo layout="stack" size={64} />);
    const logo = screen.getByRole('img', { name: 'rooster' });
    expect(logo.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
  });
});
