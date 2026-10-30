/**
 * Gemini API key field (v1.0.97). The stored key is write-only: the field only
 * ever holds what the user types, a saved key is shown as a first4…last4 hint
 * in the placeholder, and the reveal toggle applies to the typed text alone.
 * (It used to be bound to a masked copy of the decrypted key, so one keystroke
 * saved the bullet characters over the real key.)
 */
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';

export function geminiKeyPlaceholder(hasExistingKey: boolean, hint: string): string {
  if (!hasExistingKey) return 'Enter your Google AI API key...';
  return hint ? `Key saved (${hint}) — paste a new one to replace it` : 'Key saved — paste a new one to replace it';
}

export function GeminiKeyInput({
  value, onChange, hasExistingKey, hint, disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  hasExistingKey: boolean;
  hint: string;
  disabled?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <label className="text-xs text-white/40 mb-1 block" htmlFor="gemini-api-key">Gemini API Key</label>
      <Input id="gemini-api-key" type={reveal ? 'text' : 'password'} placeholder={geminiKeyPlaceholder(hasExistingKey, hint)}
        value={value} autoComplete="off" spellCheck={false}
        onChange={(e) => onChange(e.target.value)} className="pr-10 bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" disabled={disabled} />
      <button type="button" aria-label={reveal ? 'Hide typed key' : 'Show typed key'} onClick={() => setReveal(!reveal)} className="absolute right-3 bottom-2.5 text-white/40 hover:text-white/70 transition-colors">
        {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
