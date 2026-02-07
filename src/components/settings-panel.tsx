/**
 * Settings Panel Component
 * Provides settings for the application including BYOK (Bring Your Own Key) API key management
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, X, Key, Eye, EyeOff, Check, AlertCircle, Trash2, Loader2, Bot, Download, Upload, Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { libraryStore } from '@/services/library-store';
import { APP_VERSION } from '@/components/changelog-modal';

// Declare settings API type
declare global {
  interface Window {
    settings?: {
      getApiKey: () => Promise<string | null>;
      setApiKey: (key: string) => Promise<void>;
      removeApiKey: () => Promise<void>;
      hasApiKey: () => Promise<boolean>;
      getOllamaSettings: () => Promise<{ enabled: boolean; url: string; model: string; useGeminiInstead: boolean }>;
      setOllamaSettings: (settings: { enabled?: boolean; url?: string; model?: string; useGeminiInstead?: boolean }) => Promise<void>;
    };
  }
}

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  // API Key state
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const initialLoadRef = useRef(true);
  
  // Ollama settings state (Ollama is main provider)
  const [ollamaEnabled, setOllamaEnabled] = useState(true);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('gemma3:12b');
  const [useGeminiInstead, setUseGeminiInstead] = useState(false);
  const [ollamaSaveStatus, setOllamaSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const ollamaDebounceRef = useRef<NodeJS.Timeout | null>(null);
  
  // Library import/export state
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  // Check if API key exists on mount
  useEffect(() => {
    const checkExistingKey = async () => {
      if (!window.settings) return;
      
      try {
        const exists = await window.settings.hasApiKey();
        setHasExistingKey(exists);
        
        if (exists) {
          const key = await window.settings.getApiKey();
          if (key) {
            setApiKey(key);
          }
        }
        
        // Load Ollama settings
        const ollamaSettings = await window.settings.getOllamaSettings();
        setOllamaEnabled(ollamaSettings.enabled);
        setOllamaUrl(ollamaSettings.url);
        setOllamaModel(ollamaSettings.model);
        setUseGeminiInstead(ollamaSettings.useGeminiInstead ?? false);
        
        // Mark initial load complete after fetching
        initialLoadRef.current = false;
      } catch (err) {
        console.error('Failed to check API key:', err);
        initialLoadRef.current = false;
      }
    };

    if (isOpen) {
      initialLoadRef.current = true;
      checkExistingKey();
    }
    
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (ollamaDebounceRef.current) {
        clearTimeout(ollamaDebounceRef.current);
      }
    };
  }, [isOpen]);

  // Auto-save Ollama settings
  useEffect(() => {
    if (initialLoadRef.current || !window.settings) return;
    
    if (ollamaDebounceRef.current) {
      clearTimeout(ollamaDebounceRef.current);
    }
    
    setOllamaSaveStatus('saving');
    ollamaDebounceRef.current = setTimeout(async () => {
      try {
        await window.settings!.setOllamaSettings({
          enabled: ollamaEnabled,
          url: ollamaUrl,
          model: ollamaModel,
          useGeminiInstead,
        });
        setOllamaSaveStatus('saved');
        setTimeout(() => setOllamaSaveStatus('idle'), 2000);
      } catch (err) {
        console.error('Failed to save Ollama settings:', err);
      }
    }, 800);
  }, [ollamaEnabled, ollamaUrl, ollamaModel, useGeminiInstead]);

  // Auto-save API key with debounce
  useEffect(() => {
    // Skip auto-save during initial load
    if (initialLoadRef.current) return;
    if (!window.settings) return;
    
    // Clear existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // If key is empty and we had an existing key, don't auto-save (require explicit remove)
    if (!apiKey.trim()) {
      setSaveStatus('idle');
      return;
    }

    // Debounce the save
    setSaveStatus('saving');
    debounceTimeoutRef.current = setTimeout(async () => {
      try {
        await window.settings!.setApiKey(apiKey.trim());
        setSaveStatus('saved');
        setHasExistingKey(true);
        setError(null);
        
        // Reset status after 2 seconds
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (err) {
        console.error('Failed to save API key:', err);
        setSaveStatus('error');
        setError('Failed to save API key');
      }
    }, 800); // 800ms debounce

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [apiKey]);

  // Remove API key
  const handleRemoveApiKey = useCallback(async () => {
    if (!window.settings) return;

    setIsLoading(true);
    setError(null);

    try {
      await window.settings.removeApiKey();
      setApiKey('');
      setHasExistingKey(false);
      setSaveStatus('idle');
    } catch (err) {
      console.error('Failed to remove API key:', err);
      setError('Failed to remove API key');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Mask API key for display
  const getMaskedKey = (key: string) => {
    if (!key || key.length < 10) return key;
    return key.substring(0, 8) + '•'.repeat(20) + key.substring(key.length - 4);
  };

  // Export library data
  const handleExportLibrary = useCallback(async () => {
    setExportStatus('loading');
    try {
      const data = libraryStore.exportData();
      const librarySize = libraryStore.getSize();
      
      if (window.fileDialog) {
        // Use native file dialog in Electron
        const result = await window.fileDialog.saveFile({
          content: data,
          defaultName: `ark-library-${new Date().toISOString().split('T')[0]}.json`,
          filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });
        
        if (result.success) {
          setExportStatus('success');
          setImportMessage(`Exported ${librarySize} games successfully`);
        } else if (result.canceled) {
          setExportStatus('idle');
        } else {
          setExportStatus('error');
          setImportMessage(result.error || 'Failed to export library');
        }
      } else {
        // Fallback for browser: download via blob
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ark-library-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setExportStatus('success');
        setImportMessage(`Exported ${librarySize} games successfully`);
      }
      
      setTimeout(() => {
        setExportStatus('idle');
        setImportMessage(null);
      }, 3000);
    } catch (err) {
      console.error('Failed to export library:', err);
      setExportStatus('error');
      setImportMessage('Failed to export library');
      setTimeout(() => {
        setExportStatus('idle');
        setImportMessage(null);
      }, 3000);
    }
  }, []);

  // Import library data
  const handleImportLibrary = useCallback(async () => {
    setImportStatus('loading');
    setImportMessage(null);
    
    try {
      if (window.fileDialog) {
        // Use native file dialog in Electron
        const result = await window.fileDialog.openFile({
          filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });
        
        if (result.canceled) {
          setImportStatus('idle');
          return;
        }
        
        if (!result.success || !result.content) {
          setImportStatus('error');
          setImportMessage(result.error || 'Failed to read file');
          setTimeout(() => {
            setImportStatus('idle');
            setImportMessage(null);
          }, 3000);
          return;
        }
        
        // Use delta import
        const importResult = libraryStore.importDataWithDelta(result.content);
        
        if (importResult.success) {
          setImportStatus('success');
          const parts = [];
          if (importResult.added > 0) parts.push(`${importResult.added} added`);
          if (importResult.updated > 0) parts.push(`${importResult.updated} updated`);
          if (importResult.skipped > 0) parts.push(`${importResult.skipped} unchanged`);
          setImportMessage(parts.length > 0 ? parts.join(', ') : 'No changes');
        } else {
          setImportStatus('error');
          setImportMessage(importResult.error || 'Failed to import library');
        }
      } else {
        // Fallback for browser: use file input
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) {
            setImportStatus('idle');
            return;
          }
          
          try {
            const content = await file.text();
            const importResult = libraryStore.importDataWithDelta(content);
            
            if (importResult.success) {
              setImportStatus('success');
              const parts = [];
              if (importResult.added > 0) parts.push(`${importResult.added} added`);
              if (importResult.updated > 0) parts.push(`${importResult.updated} updated`);
              if (importResult.skipped > 0) parts.push(`${importResult.skipped} unchanged`);
              setImportMessage(parts.length > 0 ? parts.join(', ') : 'No changes');
            } else {
              setImportStatus('error');
              setImportMessage(importResult.error || 'Failed to import library');
            }
          } catch (err) {
            setImportStatus('error');
            setImportMessage('Failed to read file');
          }
        };
        input.click();
      }
      
      setTimeout(() => {
        setImportStatus('idle');
        setImportMessage(null);
      }, 3000);
    } catch (err) {
      console.error('Failed to import library:', err);
      setImportStatus('error');
      setImportMessage('Failed to import library');
      setTimeout(() => {
        setImportStatus('idle');
        setImportMessage(null);
      }, 3000);
    }
  }, []);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 400, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className="fixed right-0 top-0 bottom-0 bg-zinc-950 border-l border-zinc-800 z-50 overflow-hidden shadow-2xl"
        >
          <div className="w-[400px] h-full flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-lg flex items-center justify-center">
                  <Settings className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Settings</h2>
                  <p className="text-xs text-white/40">Configure your preferences</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              >
                <X className="h-4 w-4 pointer-events-none" />
              </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Ollama Settings Section (Main / Default AI Provider) */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-purple-400" />
                  <h3 className="text-sm font-semibold text-white">AI Assistant (Ollama)</h3>
                  {!useGeminiInstead && (
                    <span className="text-xs text-purple-400 bg-purple-500/20 px-2 py-0.5 rounded">Default</span>
                  )}
                </div>
                
                <div className={cn(
                  "bg-white/5 rounded-lg p-4 space-y-3",
                  useGeminiInstead && "opacity-50"
                )}>
                  <div>
                    <p className="text-sm font-medium text-white">Local AI with Ollama</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      Runs on your computer for privacy. Make sure Ollama is running.
                    </p>
                  </div>
                  
                  <div>
                    <label className="text-xs text-white/60 mb-1 block">Ollama URL</label>
                    <Input
                      type="text"
                      value={ollamaUrl}
                      onChange={(e) => setOllamaUrl(e.target.value)}
                      placeholder="http://localhost:11434"
                      className="bg-white/5 border-white/10 focus:border-fuchsia-500/50"
                      disabled={useGeminiInstead}
                    />
                  </div>
                  
                  <div>
                    <label className="text-xs text-white/60 mb-1 block">Model Name</label>
                    <Input
                      type="text"
                      value={ollamaModel}
                      onChange={(e) => setOllamaModel(e.target.value)}
                      placeholder="gemma3:12b"
                      className="bg-white/5 border-white/10 focus:border-fuchsia-500/50"
                      disabled={useGeminiInstead}
                    />
                  </div>
                  
                  <div className="flex items-center gap-2 text-xs">
                    {ollamaSaveStatus === 'saving' && (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin text-fuchsia-400" />
                        <span className="text-fuchsia-400">Saving...</span>
                      </>
                    )}
                    {ollamaSaveStatus === 'saved' && (
                      <>
                        <Check className="h-3 w-3 text-green-400" />
                        <span className="text-green-400">Saved</span>
                      </>
                    )}
                    {ollamaSaveStatus === 'idle' && (
                      <span className="text-white/40">Changes save automatically</span>
                    )}
                  </div>

                  <p className="text-xs text-white/30">
                    Don&apos;t have Ollama?{' '}
                    <a
                      href="https://ollama.com/download"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-400 hover:text-purple-300 underline"
                    >
                      Download Ollama
                    </a>
                  </p>
                </div>
              </div>

              {/* Gemini Cloud AI Toggle + Settings */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Key className="h-4 w-4 text-fuchsia-400" />
                  <h3 className="text-sm font-semibold text-white">Gemini Cloud AI</h3>
                  {useGeminiInstead && (
                    <span className="text-xs text-green-400 bg-green-500/20 px-2 py-0.5 rounded">Active</span>
                  )}
                </div>
                
                <div className="bg-white/5 rounded-lg p-4 space-y-3">
                  {/* Toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-white">Use Gemini Instead</p>
                      <p className="text-xs text-white/40 mt-0.5">
                        Switch to Google Gemini for enhanced features (tools, search)
                      </p>
                    </div>
                    <button
                      onClick={() => setUseGeminiInstead(!useGeminiInstead)}
                      className={cn(
                        "relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors",
                        useGeminiInstead ? "bg-fuchsia-600" : "bg-zinc-700"
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                          useGeminiInstead ? "translate-x-6" : "translate-x-1"
                        )}
                      />
                    </button>
                  </div>

                  {/* Gemini API key section - only visible when toggle is ON */}
                  {useGeminiInstead && (
                    <>
                      <div className="bg-fuchsia-500/10 border border-fuchsia-500/20 rounded p-2">
                        <p className="text-xs text-fuchsia-300">
                          Gemini is now the default AI provider. It can search Steam, get game details, and manage your library directly.
                        </p>
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-white">Gemini API Key</p>
                          <p className="text-xs text-white/40 mt-0.5">Required for Gemini to work</p>
                        </div>
                        {hasExistingKey && (
                          <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-1 rounded">
                            <Check className="h-3 w-3" />
                            Configured
                          </span>
                        )}
                      </div>

                      <div className="relative">
                        <Input
                          type={showApiKey ? 'text' : 'password'}
                          placeholder="Enter your Google AI API key..."
                          value={showApiKey ? apiKey : (hasExistingKey && apiKey ? getMaskedKey(apiKey) : apiKey)}
                          onChange={(e) => setApiKey(e.target.value)}
                          className="pr-10 bg-white/5 border-white/10 focus:border-fuchsia-500/50"
                          disabled={isLoading}
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                        >
                          {showApiKey ? (
                            <EyeOff className="h-4 w-4 pointer-events-none" />
                          ) : (
                            <Eye className="h-4 w-4 pointer-events-none" />
                          )}
                        </button>
                      </div>

                      {error && (
                        <div className="flex items-center gap-2 text-red-400 text-xs">
                          <AlertCircle className="h-3 w-3" />
                          {error}
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs">
                          {saveStatus === 'saving' && (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin text-fuchsia-400" />
                              <span className="text-fuchsia-400">Saving...</span>
                            </>
                          )}
                          {saveStatus === 'saved' && (
                            <>
                              <Check className="h-3 w-3 text-green-400" />
                              <span className="text-green-400">Saved automatically</span>
                            </>
                          )}
                          {saveStatus === 'idle' && hasExistingKey && (
                            <>
                              <Check className="h-3 w-3 text-green-400" />
                              <span className="text-white/40">Key configured</span>
                            </>
                          )}
                          {saveStatus === 'idle' && !hasExistingKey && (
                            <span className="text-white/40">Changes save automatically</span>
                          )}
                        </div>
                        
                        {hasExistingKey && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleRemoveApiKey}
                            disabled={isLoading}
                            className="h-7 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Remove
                          </Button>
                        )}
                      </div>

                      <p className="text-xs text-white/30">
                        Get your API key from{' '}
                        <a
                          href="https://aistudio.google.com/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-fuchsia-400 hover:text-fuchsia-300 underline"
                        >
                          Google AI Studio
                        </a>
                      </p>
                    </>
                  )}
                </div>
              </div>

              {/* Library Data Section */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-cyan-400" />
                  <h3 className="text-sm font-semibold text-white">Library Data</h3>
                </div>
                
                <div className="bg-white/5 rounded-lg p-4 space-y-3">
                  <div>
                    <p className="text-sm font-medium text-white">Export & Import</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      Backup or restore your library data as JSON
                    </p>
                  </div>
                  
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleExportLibrary}
                      disabled={exportStatus === 'loading'}
                      className="flex-1 h-9 bg-white/5 hover:bg-white/10 border border-white/10"
                    >
                      {exportStatus === 'loading' ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      Export Library
                    </Button>
                    
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleImportLibrary}
                      disabled={importStatus === 'loading'}
                      className="flex-1 h-9 bg-white/5 hover:bg-white/10 border border-white/10"
                    >
                      {importStatus === 'loading' ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4 mr-2" />
                      )}
                      Import Library
                    </Button>
                  </div>
                  
                  {/* Status message */}
                  {importMessage && (
                    <div className={cn(
                      "flex items-center gap-2 text-xs",
                      importStatus === 'success' || exportStatus === 'success' ? "text-green-400" : "text-red-400"
                    )}>
                      {(importStatus === 'success' || exportStatus === 'success') ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <AlertCircle className="h-3 w-3" />
                      )}
                      {importMessage}
                    </div>
                  )}
                  
                  <p className="text-xs text-white/30">
                    Import merges with existing data: new games are added, changed games are updated, unchanged games are skipped.
                  </p>
                </div>
              </div>

              {/* Info Section */}
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-4">
                <h4 className="text-sm font-medium text-purple-300 mb-2">About AI Providers</h4>
                <ul className="text-xs text-white/50 space-y-1">
                  <li>• <strong>Ollama</strong> runs locally on your computer (default)</li>
                  <li>• <strong>Gemini</strong> is optional cloud AI with enhanced features</li>
                  <li>• Gemini can search games, get details, and manage your library</li>
                  <li>• Your API key is stored securely and encrypted on your device</li>
                </ul>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-white/10 text-center">
              <p className="text-xs text-white/30">
                Ark v{APP_VERSION} • Made with ❤️
              </p>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

