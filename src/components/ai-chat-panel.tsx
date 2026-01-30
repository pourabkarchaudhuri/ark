/**
 * AI Chat Panel Component
 * Cursor-like polished AI assistant interface
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, 
  Send, 
  Bot, 
  Trash2, 
  Gamepad2,
  Search,
  ChevronDown,
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
  Check
} from 'lucide-react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { 
  ChatMessage, 
  GameContext, 
  ThoughtStep 
} from '@/types/chat';
import { GameStatus } from '@/types/game';
import { useLibrary } from '@/hooks/useGameStore';

interface AIChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialGameContext?: GameContext;
}

// Steam CDN image URLs
const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

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
      {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// Game image with fallback
function GameImage({ game, size = 'sm' }: { game: GameContext; size?: 'sm' | 'md' }) {
  const [imgSrc, setImgSrc] = useState(game.headerImage || `${STEAM_CDN}/${game.appId}/header.jpg`);
  const [imgError, setImgError] = useState(false);
  
  const fallbackUrls = [
    `${STEAM_CDN}/${game.appId}/header.jpg`,
    `${STEAM_CDN}/${game.appId}/capsule_231x87.jpg`,
  ];
  
  const handleError = () => {
    const currentIndex = fallbackUrls.indexOf(imgSrc);
    if (currentIndex < fallbackUrls.length - 1) {
      setImgSrc(fallbackUrls[currentIndex + 1]);
    } else {
      setImgError(true);
    }
  };
  
  const sizeClasses = size === 'sm' ? 'h-5 w-8' : 'h-8 w-14';
  
  if (imgError) {
    return (
      <div className={cn(sizeClasses, "bg-zinc-800 rounded flex items-center justify-center")}>
        <Gamepad2 className="h-3 w-3 text-zinc-500" />
      </div>
    );
  }
  
  return (
    <img 
      src={imgSrc}
      alt={game.name}
      className={cn(sizeClasses, "object-cover rounded")}
      onError={handleError}
    />
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

// Message bubble - Clean and minimal
const MessageBubble = React.memo(function MessageBubble({ message }: { message: ChatMessage }) {
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
          <div className="inline-block bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm">
            {message.content}
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
                "prose-headings:text-white prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1.5",
                "prose-h1:text-lg prose-h2:text-base prose-h3:text-sm",
                "prose-ul:my-1.5 prose-ul:pl-4 prose-ol:my-1.5 prose-ol:pl-4",
                "prose-li:my-0.5 prose-li:marker:text-fuchsia-400",
                "prose-strong:text-white prose-strong:font-semibold",
                "prose-em:text-zinc-300",
                "prose-code:text-fuchsia-300 prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none",
                "prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-white/10 prose-pre:rounded-lg prose-pre:my-2",
                "prose-a:text-fuchsia-400 prose-a:no-underline hover:prose-a:underline",
                "prose-blockquote:border-l-fuchsia-500 prose-blockquote:text-zinc-400 prose-blockquote:not-italic",
                "prose-hr:border-white/10",
                "prose-table:text-xs prose-th:text-white prose-td:text-zinc-300"
              )}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
                {/* Blinking cursor for streaming */}
                {message.isStreaming && (
                  <span className="inline-block w-2 h-4 bg-fuchsia-400 animate-pulse ml-0.5" />
                )}
              </div>
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

// Game context selector
function GameContextSelector({ 
  selected, 
  onSelect, 
  onClear 
}: { 
  selected?: GameContext; 
  onSelect: (game: GameContext) => void;
  onClear: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GameContext[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchTimeout = useRef<NodeJS.Timeout>();
  
  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim() || !window.aiChat) {
      setSearchResults([]);
      return;
    }
    
    setIsLoading(true);
    try {
      const results = await window.aiChat.searchGamesForContext(query);
      setSearchResults(results);
    } catch (error) {
      console.error('Failed to search games:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => handleSearch(searchQuery), 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [searchQuery, handleSearch]);
  
  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50 hover:border-zinc-600 transition-colors text-left"
      >
        {selected ? (
          <>
            <GameImage game={selected} />
            <span className="flex-1 text-sm text-zinc-200 truncate">{selected.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="p-1 rounded hover:bg-zinc-700 text-zinc-400"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <>
            <Gamepad2 className="h-4 w-4 text-zinc-500" />
            <span className="flex-1 text-sm text-zinc-500">Select game context...</span>
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          </>
        )}
      </button>
      
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-[100] overflow-hidden"
          >
            <div className="p-2 border-b border-zinc-800">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search games..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-7 pr-3 py-1.5 bg-zinc-800 rounded text-sm text-zinc-200 placeholder:text-zinc-500 border-0 focus:outline-none focus:ring-1 focus:ring-zinc-600"
                  autoFocus
                />
              </div>
            </div>
            
            <div className="max-h-48 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-6 text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : searchResults.length > 0 ? (
                searchResults.map((game) => (
                  <button
                    key={game.appId}
                    onClick={() => {
                      onSelect(game);
                      setIsOpen(false);
                      setSearchQuery('');
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 transition-colors"
                  >
                    <GameImage game={game} />
                    <span className="text-sm text-zinc-200 truncate">{game.name}</span>
                  </button>
                ))
              ) : searchQuery ? (
                <div className="text-center py-6 text-zinc-500 text-sm">
                  No games found
                </div>
              ) : (
                <div className="text-center py-6 text-zinc-500 text-sm">
                  Type to search games
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Quick prompts
const QUICK_PROMPTS = [
  "What's in my library?",
  "Recommend games for me",
  "Search for RPG games",
];

// Main component
export function AIChatPanel({ isOpen, onClose, initialGameContext }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [gameContext, setGameContext] = useState<GameContext | undefined>(initialGameContext);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const { getAllEntries, addToLibrary, removeFromLibrary } = useLibrary();
  
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
  
  // Load conversation history
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
    
    if (isOpen) {
      loadHistory();
    }
  }, [isOpen]);
  
  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  
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
  
  // Send message
  const handleSend = async () => {
    if (!inputValue.trim() || isLoading || !window.aiChat) return;
    
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date(),
      gameContext,
    };
    
    // Add user message and loading state
    const loadingMessage: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isLoading: true,
    };
    
    setMessages(prev => [...prev, userMessage, loadingMessage]);
    setInputValue('');
    setIsLoading(true);
    
    try {
      // Get library data with game names from Electron cache
      const libraryEntries = getAllEntries();
      const appIds = libraryEntries.map(e => e.steamAppId || e.gameId || 0);
      
      // Fetch cached game names from Electron backend
      let gameNames: Record<number, string> = {};
      if (window.steam && appIds.length > 0) {
        try {
          gameNames = await window.steam.getCachedGameNames(appIds);
        } catch (err) {
          console.warn('[AI Chat] Failed to fetch cached game names:', err);
        }
      }
      
      const libraryData = libraryEntries.map(e => {
        const appId = e.steamAppId || e.gameId || 0;
        return {
          gameId: appId,
          name: gameNames[appId] || undefined, // Include name if available in cache
          status: e.status,
          priority: e.priority,
          addedAt: e.addedAt.toISOString(),
        };
      });
      
      const payload = {
        message: userMessage.content,
        gameContext,
        libraryData,
      };
      
      // Subscribe to streaming chunks for real-time updates
      let unsubscribe: (() => void) | null = null;
      const streamingMessageId = loadingMessage.id;
      
      if (window.aiChat?.onStreamChunk) {
        unsubscribe = window.aiChat.onStreamChunk((data) => {
          // Update the loading message with streaming content
          setMessages(prev => 
            prev.map(m => 
              m.id === streamingMessageId 
                ? { ...m, content: data.fullContent, isStreaming: true }
                : m
            )
          );
        });
      }
      
      try {
        const response = await window.aiChat.sendMessage(payload);
        
        // Unsubscribe from streaming
        if (unsubscribe) unsubscribe();
        
        // Handle library actions
        if (response.actions && response.actions.length > 0) {
          for (const action of response.actions) {
            if (action.type === 'add') {
              try {
                await addToLibrary({ 
                  gameId: action.appId,
                  steamAppId: action.appId, 
                  status: (action.status as GameStatus) || 'Want to Play' 
                });
              } catch (e) {
                console.error('Failed to add game:', e);
              }
            } else if (action.type === 'remove') {
              try {
                removeFromLibrary(action.appId);
              } catch (e) {
                console.error('Failed to remove game:', e);
              }
            }
          }
        }
        
        // Add final assistant message (replaces streaming message)
        const assistantMessage: ChatMessage = {
          id: Date.now().toString(),
          role: 'assistant',
          content: response.content,
          timestamp: new Date(),
          toolCalls: response.toolsUsed?.map(name => ({ name, args: {} })),
          chainOfThought: response.chainOfThought,
          model: response.model,
        };
        
        setMessages(prev => 
          prev.filter(m => !m.isLoading && m.id !== streamingMessageId).concat(assistantMessage)
        );
      } catch (innerError) {
        // Unsubscribe from streaming on error
        if (unsubscribe) unsubscribe();
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
  
  // Key handler
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
  
  // Clear history
  const handleClearHistory = async () => {
    if (!window.aiChat) return;
    
    try {
      await window.aiChat.clearHistory();
      setMessages([]);
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  };
  
  // New conversation
  const handleNewConversation = async () => {
    if (!window.aiChat) return;
    
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
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <h2 className="text-sm font-medium text-zinc-200">AI Assistant</h2>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleNewConversation}
                  className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  title="New conversation"
                >
                  <Plus className="h-4 w-4 pointer-events-none" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleClearHistory}
                  className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                  title="Clear history"
                >
                  <Trash2 className="h-4 w-4 pointer-events-none" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                >
                  <X className="h-4 w-4 pointer-events-none" />
                </Button>
              </div>
            </div>
            
            {/* Game context */}
            <div className="px-4 py-2 border-b border-zinc-800/50">
              <GameContextSelector
                selected={gameContext}
                onSelect={setGameContext}
                onClear={() => setGameContext(undefined)}
              />
            </div>
            
            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar">
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
                  <MessageBubble key={message.id} message={message} />
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
                    <Picker
                      data={data}
                      onEmojiSelect={handleEmojiSelect}
                      theme="dark"
                      previewPosition="none"
                      skinTonePosition="none"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
              
              <div className="flex items-center gap-2">
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
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isLoading}
                  className="h-8 w-8 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 p-0"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin pointer-events-none" />
                  ) : (
                    <Send className="h-4 w-4 pointer-events-none" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
