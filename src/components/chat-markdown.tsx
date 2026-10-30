/**
 * Markdown renderer for AI chat messages (v1.0.97).
 *
 * Assistant text can be steered by a prompt-injected review or web result, so
 * a markdown image is rendered as a link instead of an <img>: an image URL that
 * carried library titles or chat text used to load (and leak) the moment the
 * message rendered. Only http(s)/mailto URLs survive (urlTransform).
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** react-markdown urlTransform: absolute http(s)/mailto only, everything else dropped. */
export function chatUrlTransform(url: string): string {
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol) ? url : '';
  } catch {
    return '';
  }
}

const components: Components = {
  a: ({ href, children, node: _node, ...props }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt, src }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'image'}</a>
    ) : (
      <span>{alt || ''}</span>
    ),
};

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={chatUrlTransform}>
      {content}
    </ReactMarkdown>
  );
}
