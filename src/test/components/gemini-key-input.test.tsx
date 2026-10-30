/**
 * Gemini key field (v1.0.97): a stored key is a placeholder hint only, the
 * field never contains key material it did not get from the user.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { GeminiKeyInput, geminiKeyPlaceholder } from '@/components/settings/gemini-key-input';

function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [v, setV] = useState('');
  return <GeminiKeyInput value={v} onChange={(n) => { setV(n); onChange(n); }} hasExistingKey hint="AIza…WXYZ" />;
}

describe('GeminiKeyInput', () => {
  it('shows a stored key as a placeholder hint with an empty field', () => {
    render(<GeminiKeyInput value="" onChange={() => {}} hasExistingKey hint="AIza…WXYZ" />);
    const input = screen.getByLabelText('Gemini API Key') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('AIza…WXYZ');
    expect(input.type).toBe('password');
  });

  it('passes only typed text up (no bullets) and the reveal toggle shows the typed text', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText('Gemini API Key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NEWKEY_abc-123' } });
    expect(onChange).toHaveBeenLastCalledWith('NEWKEY_abc-123');
    expect(onChange.mock.calls.flat().join('')).not.toContain('•');

    fireEvent.click(screen.getByRole('button', { name: 'Show typed key' }));
    expect(input.type).toBe('text');
    expect(input.value).toBe('NEWKEY_abc-123');
  });

  it('uses the plain prompt when no key is stored', () => {
    expect(geminiKeyPlaceholder(false, '')).toBe('Enter your Google AI API key...');
    expect(geminiKeyPlaceholder(true, '')).toMatch(/Key saved/);
  });
});
