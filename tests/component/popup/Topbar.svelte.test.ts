/**
 * Component tests: entrypoints/popup/components/Topbar.svelte
 *
 * Uses @testing-library/svelte for DOM-based assertions.
 * File extension is `.svelte.test.ts` so Vitest processes Svelte runes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Topbar from '../../../entrypoints/popup/components/Topbar.svelte';

describe('Topbar', () => {
  it('renders the brand name', () => {
    render(Topbar, {
      props: { mode: 'development', onmodechange: () => {} },
    });
    expect(screen.getByText('抢购助手')).toBeInTheDocument();
  });

  it('renders DEV and PROD toggle buttons', () => {
    render(Topbar, {
      props: { mode: 'development', onmodechange: () => {} },
    });
    expect(screen.getByRole('button', { name: 'DEV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PROD' })).toBeInTheDocument();
  });

  it('marks the DEV button active when mode is development', () => {
    render(Topbar, {
      props: { mode: 'development', onmodechange: () => {} },
    });
    const devBtn = screen.getByRole('button', { name: 'DEV' });
    expect(devBtn).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'PROD' })).not.toHaveClass('active');
  });

  it('marks the PROD button active when mode is production', () => {
    render(Topbar, {
      props: { mode: 'production', onmodechange: () => {} },
    });
    expect(screen.getByRole('button', { name: 'PROD' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'DEV' })).not.toHaveClass('active');
  });

  it('calls onmodechange("production") when PROD is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(Topbar, {
      props: { mode: 'development', onmodechange: onChange },
    });

    await user.click(screen.getByRole('button', { name: 'PROD' }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('production');
  });

  it('calls onmodechange("development") when DEV is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(Topbar, {
      props: { mode: 'production', onmodechange: onChange },
    });

    await user.click(screen.getByRole('button', { name: 'DEV' }));
    expect(onChange).toHaveBeenCalledWith('development');
  });
});
