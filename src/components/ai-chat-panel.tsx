/**
 * AI Chat Panel Component
 * Cursor-like polished AI assistant interface
 */

import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, 
  Send, 
  Bot, 
  Trash2, 
  ChevronRight,
  Loader2,
  Plus,
  Smile,
  Wrench,
  CheckCircle2,
  Clock,
  Zap,
  Eye,
  Copy,
  Check,
  Paperclip,
  AlertTriangle
} from 'lucide-react';
import { ChatMarkdown } from '@/components/chat-markdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getGgRegion } from '@/services/ggdeals-service';
import { AnimateIcon } from '@/components/ui/animate-icon';
import type { 
  ChatMessage, 
  GameContext, 
  SendMessagePayload,
  ThoughtStep 
} from '@/types/chat';
import { useLibrary, extractCachedMeta } from '@/hooks/useGameStore';
import { gameService } from '@/services/game-service';
import { journeyStore } from '@/services/journey-store';
import { listConfiguredChatProviders } from '@/lib/chat-providers';
import { ensureLegacyAiKeysMigrated } from '@/lib/ai-key-migration';
import { applyAIChatActions, confirmAIChatRemovals } from '@/services/ai-chat-actions';

// Emoji picker + its ~430 KB data load only when the picker is first opened.
const EmojiPicker = lazy(() => import('@emoji-mart/react'));
const loadEmojiData = async () => (await import('@emoji-mart/data')).default;

/** Within this many px of the bottom counts as "following" the conversation. */
const STICK_TO_BOTTOM_PX = 80;

interface AIChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialGameContext?: GameContext;
}

// Format relative time
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return date.toLocaleDateString();
}

// Copy button component
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/60 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-400" /> : <AnimateIcon tap="pop"><Copy className="h-3 w-3" /></AnimateIcon>}
    </button>
  );
}

// Thinking step component - Cursor-like design
function ThinkingStep({ step, isLast }: { step: ThoughtStep; isLast: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const getStepConfig = (type: ThoughtStep['type']) => {
    switch (type) {
      case 'thinking':
        return { 
          icon: <Zap className="h-3 w-3" />, 
          label: 'Reasoning',
          color: 'text-white/70'
        };
      case 'tool_call':
        return { 
          icon: <Wrench className="h-3 w-3" />, 
          label: step.toolName || 'Tool',
          color: 'text-white/70'
        };
      case 'tool_result':
        return { 
          icon: <CheckCircle2 className="h-3 w-3" />, 
          label: 'Result',
          color: 'text-white/70'
        };
      case 'validation':
        return { 
          icon: <Eye className="h-3 w-3" />, 
          label: 'Validating',
          color: 'text-white/70'
        };
      default:
        return { 
          icon: <Zap className="h-3 w-3" />, 
          label: 'Processing',
          color: 'text-white/70'
        };
    }
  };
  
  const config = getStepConfig(step.type);
  const hasDetails = step.toolArgs || step.toolResult;
  
  return (
    <div className="relative pl-4">
      {/* Vertical line */}
      {!isLast && (
        <div className="absolute left-[5px] top-5 bottom-0 w-px bg-zinc-700" />
      )}
      
      {/* Step dot */}
      <div className={cn(
        "absolute left-0 top-1 w-3 h-3 rounded-full border-2 border-zinc-600 bg-zinc-900",
        step.type === 'tool_result' && "border-purple-500 bg-purple-900/30",
        step.type === 'tool_call' && "border-fuchsia-500 bg-fuchsia-900/30"
      )} />
      
      <div className="pb-3">
        <button
          onClick={() => hasDetails && setIsExpanded(!isExpanded)}
          className={cn(
            "flex items-center gap-2 text-xs transition-colors w-full text-left",
            hasDetails ? "cursor-pointer hover:text-white/80" : "cursor-default",
            config.color
          )}
        >
          {config.icon}
          <span className="font-medium">{config.label}</span>
          {hasDetails && (
            <ChevronRight className={cn(
              "h-3 w-3 ml-auto transition-transform text-zinc-500",
              isExpanded && "rotate-90"
            )} />
          )}
        </button>
        
        {/* Step content */}
        <div className="mt-1 text-xs text-zinc-400 leading-relaxed">
          {step.content}
        </div>
        
        {/* Expandable details */}
        <AnimatePresence>
          {isExpanded && hasDetails && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-2 space-y-2">
                {step.toolArgs && (
                  <div className="bg-zinc-800/50 rounded p-2 font-mono text-[10px] text-zinc-400">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-zinc-500">Arguments</span>
                      <CopyButton text={JSON.stringify(step.toolArgs, null, 2)} />
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(step.toolArgs, null, 2)}
                    </pre>
                  </div>
                )}
                {step.toolResult && (
                  <div className="bg-zinc-800/50 rounded p-2 font-mono text-[10px] text-zinc-400">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-zinc-500">Result</span>
                      <CopyButton text={step.toolResult} />
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                      {step.toolResult.length > 500 
                        ? step.toolResult.substring(0, 500) + '...' 
                        : step.toolResult}
                    </pre>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Chain of thought view - Cursor-like collapsible
const ChainOfThought = React.memo(function ChainOfThought({ steps, isStreaming }: { steps: ThoughtStep[]; isStreaming?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  if (!steps || steps.length === 0) return null;
  
  const toolCalls = steps.filter(s => s.type === 'tool_call').length;
  
  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-900/50 mb-3">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800/50 transition-colors"
      >
        <ChevronRight className={cn(
          "h-3 w-3 transition-transform",
          isExpanded && "rotate-90"
        )} />
        <Zap className="h-3 w-3" />
        <span>
          {isStreaming ? 'Thinking...' : `${steps.length} steps`}
          {toolCalls > 0 && ` · ${toolCalls} tool${toolCalls > 1 ? 's' : ''} used`}
        </span>
        {isStreaming && (
          <Loader2 className="h-3 w-3 animate-spin ml-auto" />
        )}
      </button>
      
      {/* Steps */}
      <AnimatePresence mode="wait">
        {isExpanded && (
          <motion.div
            key="expanded-content"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="px-3 pb-2 overflow-hidden"
          >
            {steps.map((step, i) => (
              <ThinkingStep 
                key={i} 
                step={step} 
                isLast={i === steps.length - 1}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// Confirmation card for library removals the model queued; nothing is removed until the user clicks.
function RemovalConfirmCard({
  message,
  onConfirm,
  onCancel,
}: {
  message: ChatMessage;
  onConfirm?: (messageId: string) => void;
  onCancel?: (messageId: string) => void;
}) {
  const removals = message.pendingRemovals ?? [];
  const n = removals.length;
  const noun = n === 1 ? 'game' : 'games';
  if (message.removalState === 'removed') {
    return (
      <div className="text-xs text-zinc-400 border border-zinc-800 rounded-lg px-3 py-2" data-testid="ai-chat-removal-done">
        Removed {n} {noun} from your library.
      </div>
    );
  }
  if (message.removalState === 'cancelled') {
    return (
      <div className="text-xs text-zinc-500 border border-zinc-800 rounded-lg px-3 py-2" data-testid="ai-chat-removal-cancelled">
        Removal cancelled. Your library was not changed.
      </div>
    );
  }
  return (
    <div className="border border-amber-900/60 bg-amber-950/20 rounded-lg px-3 py-2 space-y-2" data-testid="ai-chat-removal-confirm">
      <div className="flex items-center gap-2 text-xs text-amber-300">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>Remove from your library?</span>
      </div>
      <ul className="text-xs text-zinc-300 list-disc pl-5 space-y-0.5">
        {removals.map(r => (
          <li key={r.gameId}>{r.gameName}</li>
        ))}
      </ul>
      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onCancel?.(message.id)}
          className="h-7 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onConfirm?.(message.id)}
          className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white"
        >
          Remove {n} {noun}
        </Button>
      </div>
    </div>
  );
}

// Message bubble - Clean and minimal
const MessageBubble = React.memo(function MessageBubble({
  message,
  onFollowUpClick,
  onConfirmRemovals,
  onCancelRemovals,
}: {
  message: ChatMessage;
  onFollowUpClick?: (text: string) => void;
  onConfirmRemovals?: (messageId: string) => void;
  onCancelRemovals?: (messageId: string) => void;
}) {
  const isUser = message.role === 'user';
  
  return (
    <div 
      className={cn(
        "group relative",
        isUser ? "flex justify-end" : ""
      )}
    >
      <div className={cn(
        "max-w-[90%]",
        isUser ? "text-right" : ""
      )}>
        {/* User message */}
        {isUser ? (
          <div className="inline-block bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm max-w-[85%]">
            {message.attachedImageUrl && (
              <div className="mb-2 rounded-lg overflow-hidden border border-white/20">
                <img src={message.attachedImageUrl} alt="Attached" className="max-h-32 w-auto max-w-full object-contain" />
              </div>
            )}
            <span>{message.attachedImageUrl ? message.content.replace(/\s*\[Image attached\]\s*$/, '').trim() || ' ' : message.content}</span>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Loading state (only show when no streaming content yet) */}
            {message.isLoading && !message.content && !message.isStreaming && (
              <div className="flex items-center gap-2 text-zinc-400 text-sm py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Thinking...</span>
              </div>
            )}
            
            {/* Streaming indicator */}
            {message.isStreaming && (
              <div className="flex items-center gap-2 text-fuchsia-400 text-xs mb-1">
                <div className="flex gap-0.5">
                  <span className="w-1.5 h-1.5 bg-fuchsia-400 rounded-full animate-pulse" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-fuchsia-400 rounded-full animate-pulse" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-fuchsia-400 rounded-full animate-pulse" style={{ animationDelay: '300ms' }} />
                </div>
                <span>Streaming response...</span>
              </div>
            )}
            
            {/* Chain of thought */}
            {message.chainOfThought && message.chainOfThought.length > 0 && (
              <ChainOfThought 
                key={`chain-${message.id}`}
                steps={message.chainOfThought} 
                isStreaming={message.isLoading}
              />
            )}
            
            {/* Error */}
            {message.error && (
              <div className="text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">
                {message.error}
              </div>
            )}
            
            {/* Content with Markdown rendering - show during streaming too */}
            {message.content && (
              <div className={cn(
                "text-sm text-zinc-200 leading-relaxed prose prose-invert prose-sm max-w-none",
                "prose-p:my-1.5 prose-p:leading-relaxed",
                "prose-headings:text-white prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2 prose-headings:leading-tight",
                "prose-h1:text-xl prose-h1:mt-4 prose-h2:text-lg prose-h2:mt-4 prose-h3:text-base prose-h3:mt-3",
                "prose-ul:my-2 prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5",
                "prose-li:my-1 prose-li:marker:text-fuchsia-400 prose-li:leading-relaxed",
                "prose-strong:text-white prose-strong:font-semibold",
                "prose-em:text-zinc-300",
                "prose-code:text-fuchsia-300 prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none",
                "prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-white/10 prose-pre:rounded-lg prose-pre:my-2",
                "prose-a:text-fuchsia-400 prose-a:no-underline hover:prose-a:underline",
                "prose-blockquote:border-l-fuchsia-500 prose-blockquote:text-zinc-400 prose-blockquote:not-italic",
                "prose-hr:border-white/10",
                "prose-table:text-xs prose-th:text-white prose-td:text-zinc-300"
              )}>
                {/* Images render as links and only http(s)/mailto URLs survive (chat-markdown.tsx). */}
                <ChatMarkdown content={message.content} />
                {/* Blinking cursor for streaming */}
                {message.isStreaming && (
                  <span className="inline-block w-2 h-4 bg-fuchsia-400 animate-pulse ml-0.5" />
                )}
              </div>
            )}
            
            {/* Pending library removals (confirm before anything is removed) */}
            {message.pendingRemovals && message.pendingRemovals.length > 0 && (
              <RemovalConfirmCard
                message={message}
                onConfirm={onConfirmRemovals}
                onCancel={onCancelRemovals}
              />
            )}

            {/* Tools used badge */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {message.toolCalls.map((tool, i) => (
                  <span 
                    key={i}
                    className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400"
                  >
                    <Wrench className="h-2.5 w-2.5" />
                    {tool.name}
                  </span>
                ))}
              </div>
            )}
            {/* Suggested follow-ups as clickable chips */}
            {!isUser && message.suggestedFollowUps && message.suggestedFollowUps.length > 0 && onFollowUpClick && (
              <div className="flex flex-wrap gap-2 mt-3">
                {message.suggestedFollowUps.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onFollowUpClick(q)}
                    className="text-xs px-3 py-1.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-600 hover:bg-zinc-700 hover:border-zinc-500 hover:text-white transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        
        {/* Timestamp, model and copy */}
        <div className={cn(
          "flex items-center gap-2 mt-1 text-[10px] text-zinc-500",
          isUser ? "justify-end" : ""
        )}>
          <Clock className="h-2.5 w-2.5" />
          <span>{formatRelativeTime(new Date(message.timestamp))}</span>
          {!isUser && message.model && (
            <span className="text-zinc-600">• {message.model}</span>
          )}
          {message.content && (
            <CopyButton text={message.content} />
          )}
        </div>
      </div>
    </div>
  );
});

const CHAT_PROVIDER_LABELS: Record<string, string> = {
  'ollama': 'Local AI',
  'gemini': 'Gemini',
  'azure-openai': 'Azure OpenAI',
  'anthropic': 'Claude',
};

// Quick prompts
const QUICK_PROMPTS = [
  "What's in my library?",
  "Recommend games for me",
  "Search for RPG games",
];

// Main component — memoized to avoid re-renders from Dashboard state changes
export const AIChatPanel = React.memo(function AIChatPanel({ isOpen, onClose, initialGameContext }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [gameContext, setGameContext] = useState<GameContext | undefined>(initialGameContext);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [preferredProvider, setPreferredProvider] = useState<string>('ollama');
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only while the user is at (or near) the bottom; scrolling up to read pauses it.
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  // Stops the in-flight stream subscription and its pending animation frame (unmount safety).
  const stopStreamRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const { getAllEntries, addToLibrary, removeFromLibrary } = useLibrary();

  const isAzureOpenAI = preferredProvider === 'azure-openai';

  // Close emoji picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (emojiPickerRef.current?.contains(target)) return;
      if (emojiButtonRef.current?.contains(target)) return;
      setShowEmojiPicker(false);
    };
    
    if (showEmojiPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showEmojiPicker]);
  
  // Handle emoji selection
  const handleEmojiSelect = (emoji: { native: string }) => {
    setInputValue(prev => prev + emoji.native);
    setShowEmojiPicker(false);
    inputRef.current?.focus();
  };
  
  // Load conversation history and preferred provider / available providers
  useEffect(() => {
    const loadHistory = async () => {
      if (!window.aiChat) return;
      
      try {
        const conversation = await window.aiChat.getActiveConversation();
        if (conversation && conversation.messages) {
          setMessages(conversation.messages.map(m => ({
            ...m,
            timestamp: new Date(m.timestamp),
          })));
          if (conversation.gameContext) {
            setGameContext(conversation.gameContext);
          }
        }
      } catch (error) {
        console.error('Failed to load chat history:', error);
      }
    };

    const loadProviders = async () => {
      // Keys live encrypted in main (1.0.97): ask main what is saved. Only providers with a
      // chat backend are listed (CHAT_IMPLEMENTED_PROVIDERS; Anthropic runs through the AI router).
      let list: string[] = [];
      try {
        await ensureLegacyAiKeysMigrated();
        const azureEndpoint = localStorage.getItem('ark-azure-endpoint')?.trim();
        const azureDeployment = localStorage.getItem('ark-azure-deployment')?.trim();
        if (window.settings) {
          const [hasGemini, ollamaSettings, hasAzureKey, hasAnthropic] = await Promise.all([
            window.settings.hasApiKey(),
            window.settings.getOllamaSettings(),
            window.settings.hasAzureKey?.() ?? Promise.resolve(false),
            window.settings.hasAnthropicKey?.() ?? Promise.resolve(false),
          ]);
          list = listConfiguredChatProviders({
            ollamaUrl: ollamaSettings?.url,
            betaFeatures: true, // the chat panel only exists with Beta on
            hasGeminiKey: !!hasGemini,
            azureConfigured: !!(azureEndpoint && azureDeployment && hasAzureKey),
            hasAnthropicKey: !!hasAnthropic,
          });
        }
      } catch {
        // main unreachable: fall back to Ollama below
      }
      setAvailableProviders(list.length ? list : ['ollama']);
      try {
        const current = window.settings ? await window.settings.getPreferredChatProvider() : localStorage.getItem('ark-preferred-chat-provider') ?? 'ollama';
        setPreferredProvider(list.length && list.includes(current) ? current : (list[0] ?? 'ollama'));
      } catch {
        const current = localStorage.getItem('ark-preferred-chat-provider') ?? 'ollama';
        setPreferredProvider(list.length && list.includes(current) ? current : (list[0] ?? 'ollama'));
      }
    };
    
    if (isOpen) {
      loadHistory();
      loadProviders();
    }
  }, [isOpen]);
  
  // Scroll to bottom: smooth when a message is added, instant (once per flushed frame) while a
  // reply streams in, and never while the user has scrolled up.
  useEffect(() => {
    const countChanged = messages.length !== prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (!stickToBottomRef.current) return;
    if (countChanged) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
    // Only an upward move un-sticks: content growth and our own scrolling never move scrollTop up.
    if (nearBottom) stickToBottomRef.current = true;
    else if (el.scrollTop < lastScrollTopRef.current) stickToBottomRef.current = false;
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  useEffect(() => () => stopStreamRef.current?.(), []);
  
  // Focus input
  useEffect(() => {
    if (isOpen) {
      const focusTimeout = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(focusTimeout);
    }
  }, [isOpen]);
  
  // Update game context
  useEffect(() => {
    if (initialGameContext) {
      setGameContext(initialGameContext);
    }
  }, [initialGameContext]);
  
  const handleAttachmentClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl === 'string') setAttachedImage(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  // Send message (optional override = e.g. follow-up chip text; sends immediately without using input)
  const handleSend = async (overrideMessage?: string) => {
    const text = (overrideMessage ?? inputValue).trim();
    if (!text || isLoading || !window.aiChat) return;
    
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text + (attachedImage ? ' [Image attached]' : ''),
      timestamp: new Date(),
      gameContext,
      ...(attachedImage ? { attachedImageUrl: attachedImage } : {}),
    };
    
    // Add user message and loading state
    const loadingMessage: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isLoading: true,
    };
    
    stickToBottomRef.current = true;
    setMessages(prev => [...prev, userMessage, loadingMessage]);
    setInputValue('');
    setIsLoading(true);
    
    try {
      // Get library data with game names — use same sources as Library page (cachedMeta, journey, then Steam cache)
      const libraryEntries = getAllEntries();
      const numericAppIds = libraryEntries
        .map(e => e.steamAppId ?? 0)
        .filter((id): id is number => id > 0);
      let gameNames: Record<number, string> = {};
      if (window.steam && numericAppIds.length > 0) {
        try {
          gameNames = await window.steam.getCachedGameNames(numericAppIds);
        } catch (err) {
          console.warn('[AI Chat] Failed to fetch cached game names:', err);
        }
      }
      const libraryData = libraryEntries.map(e => {
        const name =
          e.cachedMeta?.title ??
          journeyStore.getEntry(e.gameId)?.title ??
          (e.steamAppId ? gameNames[e.steamAppId] : undefined);
        return {
          gameId: e.gameId,
          name: name || undefined,
          status: e.status,
          priority: e.priority,
          addedAt: e.addedAt.toISOString(),
          hoursPlayed: e.hoursPlayed,
          rating: e.rating,
        };
      });
      
      let preferredProvider: string = 'ollama';
      try {
        if (window.settings) preferredProvider = await window.settings.getPreferredChatProvider() ?? 'ollama';
        else preferredProvider = (typeof localStorage !== 'undefined' ? localStorage.getItem('ark-preferred-chat-provider') : null) ?? 'ollama';
      } catch {
        preferredProvider = (typeof localStorage !== 'undefined' ? localStorage.getItem('ark-preferred-chat-provider') : null) ?? 'ollama';
      }
      const payload: SendMessagePayload = {
        message: text,
        gameContext,
        libraryData,
        ggRegion: getGgRegion(),
        ...(attachedImage ? { imageAttachment: attachedImage } : {}),
      };
      if (preferredProvider === 'anthropic') {
        try {
          const model = localStorage.getItem('ark-anthropic-model')?.trim();
          if (model) payload.anthropicModel = model;
        } catch {
          // ignore
        }
      }
      if (preferredProvider === 'azure-openai') {
        try {
          // The key is added by main from its encrypted store; only endpoint/deployment go from here.
          const endpoint = localStorage.getItem('ark-azure-endpoint')?.trim();
          const deployment = localStorage.getItem('ark-azure-deployment')?.trim();
          const apiVersion = localStorage.getItem('ark-azure-api-version')?.trim();
          if (endpoint && deployment) {
            payload.azureEndpoint = endpoint;
            payload.azureDeployment = deployment;
            if (apiVersion) payload.azureApiVersion = apiVersion;
          }
        } catch {
          // ignore
        }
      }
      
      // Subscribe to streaming chunks for real-time updates. Chunks are coalesced: only the latest
      // fullContent is kept and flushed with one setMessages per animation frame.
      let unsubscribe: (() => void) | null = null;
      const streamingMessageId = loadingMessage.id;
      let latestContent: string | null = null;
      let frame: number | null = null;
      let streamDone = false;
      const flushStream = () => {
        frame = null;
        if (streamDone || latestContent === null) return;
        const content = latestContent;
        latestContent = null;
        setMessages(prev =>
          prev.map(m =>
            m.id === streamingMessageId
              ? { ...m, content, isStreaming: true }
              : m
          )
        );
      };
      // Must run before the final replace so no late frame resurrects the streaming message.
      const stopStream = () => {
        streamDone = true;
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        if (unsubscribe) unsubscribe();
        unsubscribe = null;
        if (stopStreamRef.current === stopStream) stopStreamRef.current = null;
      };
      stopStreamRef.current = stopStream;

      if (window.aiChat?.onStreamChunk) {
        unsubscribe = window.aiChat.onStreamChunk((data) => {
          if (streamDone) return;
          latestContent = data.fullContent;
          if (frame === null) frame = requestAnimationFrame(flushStream);
        });
      }

      try {
        const response = await window.aiChat.sendMessage(payload);

        setAttachedImage(null);
        stopStream();

        // Adds apply now; removals wait for the user's confirmation on the message card
        const { pendingRemovals } = await applyAIChatActions(response.actions, {
          addToLibrary,
          resolveCachedMeta: async (id) => {
            const game = await gameService.getGameDetails(id);
            return game ? extractCachedMeta(game) : null;
          },
          lookupName: (id) => libraryEntries.find(e => e.gameId === id)?.cachedMeta?.title ?? journeyStore.getEntry(id)?.title,
        });

        // Add final assistant message (replaces streaming message)
        const assistantMessage: ChatMessage = {
          id: Date.now().toString(),
          role: 'assistant',
          content: response.content,
          timestamp: new Date(),
          toolCalls: response.toolsUsed?.map(name => ({ name, args: {} })),
          chainOfThought: response.chainOfThought,
          model: response.model,
          suggestedFollowUps: response.suggestedFollowUps?.length ? response.suggestedFollowUps : undefined,
          ...(pendingRemovals.length > 0 ? { pendingRemovals, removalState: 'pending' as const } : {}),
        };
        
        setMessages(prev => 
          prev.filter(m => !m.isLoading && m.id !== streamingMessageId).concat(assistantMessage)
        );
      } catch (innerError) {
        // Unsubscribe from streaming on error
        stopStream();
        throw innerError;
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      
      const errorMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        error: error instanceof Error ? error.message : 'Failed to get a response. Please try again.',
      };
      
      setMessages(prev => 
        prev.filter(m => !m.isLoading).concat(errorMessage)
      );
    } finally {
      setIsLoading(false);
    }
  };
  
  // Follow-up chips get one stable callback (keeps MessageBubble memo intact) that always calls the
  // latest handleSend, so it sends with the current attachedImage/gameContext.
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const handleFollowUp = useCallback((question: string) => {
    void handleSendRef.current(question);
  }, []);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const handleConfirmRemovals = useCallback((messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg || msg.removalState !== 'pending') return;
    confirmAIChatRemovals(msg.pendingRemovals, removeFromLibrary);
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, removalState: 'removed' } : m)));
  }, [removeFromLibrary]);

  const handleCancelRemovals = useCallback((messageId: string) => {
    setMessages(prev => prev.map(m => (m.id === messageId && m.removalState === 'pending' ? { ...m, removalState: 'cancelled' } : m)));
  }, []);

  // Key handler
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
  
  // Clear history
  // Clear history / new conversation are blocked while a reply is pending: main saves the reply into
  // whichever conversation is active when it finishes, which would put the old exchange back.
  const handleClearHistory = async () => {
    if (!window.aiChat || isLoading) return;
    
    try {
      await window.aiChat.clearHistory();
      setMessages([]);
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  };
  
  // New conversation
  const handleNewConversation = async () => {
    if (!window.aiChat || isLoading) return;
    
    try {
      await window.aiChat.createNewConversation();
      setMessages([]);
      setGameContext(undefined);
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  };
  
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 400, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className="fixed top-0 right-0 h-full bg-zinc-950 border-l border-zinc-800 z-50 flex flex-col shadow-2xl overflow-hidden"
        >
          <div className="w-[400px] h-full flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-fuchsia-500 to-purple-600 flex items-center justify-center">
                  <AnimateIcon hover="pulse"><Bot className="h-4 w-4 text-white" /></AnimateIcon>
                </div>
                <h2 className="text-sm font-medium text-zinc-200">AI Assistant</h2>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleNewConversation}
                  disabled={isLoading}
                  className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  title={isLoading ? 'Wait for the reply to finish before starting a new conversation' : 'New conversation'}
                  aria-label="New conversation"
                >
                  <AnimateIcon hover="pulse"><Plus className="h-4 w-4 pointer-events-none" /></AnimateIcon>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleClearHistory}
                  disabled={isLoading}
                  className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  title={isLoading ? 'Wait for the reply to finish before clearing history' : 'Clear history'}
                  aria-label="Clear history"
                >
                  <AnimateIcon hover="lift"><Trash2 className="h-4 w-4 pointer-events-none" /></AnimateIcon>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  className="group min-w-[44px] min-h-[44px] p-0 flex items-center justify-center bg-transparent hover:bg-transparent text-zinc-400 transition-[color,background-color] duration-0"
                >
                  <span className="h-7 w-7 flex items-center justify-center rounded-md group-hover:text-zinc-200 group-hover:bg-zinc-800 transition-colors duration-0">
                    <AnimateIcon hover="shrink"><X className="h-4 w-4 pointer-events-none" /></AnimateIcon>
                  </span>
                </Button>
              </div>
            </div>

            {gameContext && (
              <div
                className="px-4 py-2 border-b border-zinc-800/50 flex items-center gap-2 min-h-[36px]"
                data-testid="ai-chat-game-context"
              >
                <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Context</span>
                <span className="text-xs text-zinc-200 font-medium truncate">{gameContext.name}</span>
              </div>
            )}

            {/* LLM provider selection */}
            {availableProviders.length > 0 && (
              <div className="px-4 py-2 border-b border-zinc-800/50 flex items-center gap-2">
                <span className="text-xs text-zinc-500 whitespace-nowrap">Model</span>
                <Select
                  value={preferredProvider}
                  onValueChange={async (value) => {
                    setPreferredProvider(value);
                    try {
                      if (typeof localStorage !== 'undefined') localStorage.setItem('ark-preferred-chat-provider', value);
                      await window.settings?.setPreferredChatProvider(value as 'ollama' | 'gemini' | 'azure-openai' | 'anthropic');
                    } catch {
                      // ignore
                    }
                  }}
                >
                  <SelectTrigger className="h-8 bg-zinc-800/50 border-zinc-700/50 text-zinc-200 text-xs flex-1 max-w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableProviders.map((id) => (
                      <SelectItem key={id} value={id}>
                        {CHAT_PROVIDER_LABELS[id] ?? id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Messages */}
            <div
              ref={messagesContainerRef}
              onScroll={handleMessagesScroll}
              className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar"
              data-testid="ai-chat-messages"
            >
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-6">
                  <div className="w-12 h-12 rounded-2xl bg-zinc-800/50 flex items-center justify-center mb-4">
                    <Bot className="h-6 w-6 text-zinc-500" />
                  </div>
                  <h3 className="text-sm font-medium text-zinc-300 mb-1">
                    How can I help?
                  </h3>
                  <p className="text-xs text-zinc-500 mb-4">
                    Ask about games, get recommendations, or manage your library
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {QUICK_PROMPTS.map((prompt, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setInputValue(prompt);
                          inputRef.current?.focus();
                        }}
                        className="text-xs px-3 py-1.5 rounded-full bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    onFollowUpClick={handleFollowUp}
                    onConfirmRemovals={handleConfirmRemovals}
                    onCancelRemovals={handleCancelRemovals}
                  />
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
            
            {/* Input */}
            <div className="p-4 border-t border-zinc-800 bg-zinc-900/30">
              {/* Emoji picker */}
              <AnimatePresence>
                {showEmojiPicker && (
                  <motion.div
                    ref={emojiPickerRef}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-20 left-4 right-4 z-10"
                  >
                    <Suspense fallback={null}>
                      <EmojiPicker
                        data={loadEmojiData}
                        onEmojiSelect={handleEmojiSelect}
                        theme="dark"
                        previewPosition="none"
                        skinTonePosition="none"
                      />
                    </Suspense>
                  </motion.div>
                )}
              </AnimatePresence>
              
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
              <div className="flex items-center gap-2">
                {isAzureOpenAI && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleAttachmentClick}
                    className={cn(
                      'h-8 w-8 flex-shrink-0',
                      attachedImage ? 'text-blue-400 hover:text-blue-300 hover:bg-zinc-800' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                    )}
                    title={attachedImage ? 'Change image' : 'Attach image (Azure OpenAI)'}
                  >
                    <Paperclip className="h-4 w-4 pointer-events-none" />
                  </Button>
                )}
                {attachedImage && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <img src={attachedImage} alt="Attached" className="h-8 w-8 rounded object-cover border border-zinc-600" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setAttachedImage(null)}
                      className="h-6 w-6 text-zinc-500 hover:text-red-400"
                      title="Remove image"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                <Button
                  ref={emojiButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  className="h-8 w-8 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 flex-shrink-0"
                  title="Add emoji"
                >
                  <Smile className="h-4 w-4 pointer-events-none" />
                </Button>
                <Input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything..."
                  className="flex-1 bg-zinc-800 border-zinc-700 text-zinc-200 placeholder:text-zinc-500 focus:border-zinc-600 focus:ring-0 text-sm h-9"
                  disabled={isLoading}
                />
                <Button
                  onClick={() => void handleSend()}
                  disabled={!inputValue.trim() || isLoading}
                  className="h-8 w-8 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 p-0"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin pointer-events-none" />
                  ) : (
                    <AnimateIcon tap="send"><Send className="h-4 w-4 pointer-events-none" /></AnimateIcon>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
});
