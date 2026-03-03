/**
 * Settings Screen — Full-page dedicated settings experience
 *
 * Tabs: General · AI Models · Guide · Features · About
 */

import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Settings, Key, Eye, EyeOff, Check, AlertCircle, Trash2,
  Loader2, Bot, Download, Upload, Database, Power, Sparkles, Code2,
  Palette, Brain, BookOpen, Info, Users, Scale, ExternalLink,
  Library, Compass, Globe, BarChart3, Newspaper, Calendar, Gamepad2,
  Cpu, Zap, Search, Star, Trophy, Map, MessageCircle, Shield,
  Layers, Wand2, TrendingUp, Heart, Package,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimateIcon } from '@/components/ui/animate-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { libraryStore } from '@/services/library-store';
import { useDevMode } from '@/hooks/useDevMode';
import { APP_VERSION } from '@/components/changelog-modal';
import { YearWrapped } from '@/components/year-wrapped';

declare global {
  interface Window {
    settings?: {
      getApiKey: () => Promise<string | null>;
      setApiKey: (key: string) => Promise<void>;
      removeApiKey: () => Promise<void>;
      hasApiKey: () => Promise<boolean>;
      getOllamaSettings: () => Promise<{ enabled: boolean; url: string; model: string; useGeminiInstead: boolean }>;
      setOllamaSettings: (settings: { enabled?: boolean; url?: string; model?: string; useGeminiInstead?: boolean }) => Promise<void>;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<void>;
    };
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SettingsTab = 'general' | 'ai-models' | 'guide' | 'features' | 'about';

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: React.ElementType;
}

const TABS: TabDef[] = [
  { id: 'general',    label: 'General',    icon: Settings },
  { id: 'ai-models',  label: 'AI Models',  icon: Brain },
  { id: 'guide',      label: 'Guide',      icon: BookOpen },
  { id: 'features',   label: 'Features',   icon: Zap },
  { id: 'about',      label: 'About',      icon: Info },
];

// ─── Shared UI ────────────────────────────────────────────────────────────────

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('bg-white/[0.03] rounded-xl p-5 border border-white/[0.06] space-y-4', className)}>
      {children}
    </div>
  );
}

function SectionHeading({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <Icon className="h-4 w-4 text-white/40" />
      <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">{children}</h3>
    </div>
  );
}

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors',
        value ? 'bg-fuchsia-500/40' : 'bg-white/[0.08]',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn(
        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
        value ? 'translate-x-6' : 'translate-x-1',
      )} />
    </button>
  );
}

// ─── General Tab ──────────────────────────────────────────────────────────────

const GeneralTab = memo(function GeneralTab() {
  const [autoLaunch, setAutoLaunchState] = useState(true);
  const [devMode, setDevMode] = useDevMode();
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [showWrapped, setShowWrapped] = useState(false);

  useEffect(() => {
    window.settings?.getAutoLaunch().then(setAutoLaunchState).catch(() => {});
  }, []);

  const handleAutoLaunchToggle = useCallback(async () => {
    if (!window.settings) return;
    const newValue = !autoLaunch;
    setAutoLaunchState(newValue);
    try { await window.settings.setAutoLaunch(newValue); }
    catch { setAutoLaunchState(!newValue); }
  }, [autoLaunch]);

  const handleExportLibrary = useCallback(async () => {
    setExportStatus('loading');
    try {
      const data = libraryStore.exportData();
      const librarySize = libraryStore.getSize();
      if (window.fileDialog) {
        const result = await window.fileDialog.saveFile({
          content: data,
          defaultName: `ark-library-${new Date().toISOString().split('T')[0]}.json`,
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
        });
        if (result.success) { setExportStatus('success'); setImportMessage(`Exported ${librarySize} games`); }
        else if (result.canceled) { setExportStatus('idle'); return; }
        else { setExportStatus('error'); setImportMessage(result.error || 'Failed'); }
      } else {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `ark-library-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        setExportStatus('success'); setImportMessage(`Exported ${librarySize} games`);
      }
      setTimeout(() => { setExportStatus('idle'); setImportMessage(null); }, 3000);
    } catch { setExportStatus('error'); setImportMessage('Failed to export'); setTimeout(() => { setExportStatus('idle'); setImportMessage(null); }, 3000); }
  }, []);

  const handleImportLibrary = useCallback(async () => {
    setImportStatus('loading'); setImportMessage(null);
    const processContent = (content: string) => {
      const result = libraryStore.importData(content);
      if (result.success) { setImportStatus('success'); setImportMessage(`Imported ${result.count} games`); }
      else { setImportStatus('error'); setImportMessage(result.error || 'Failed'); }
    };
    try {
      if (window.fileDialog) {
        const result = await window.fileDialog.openFile({ filters: [{ name: 'JSON Files', extensions: ['json'] }] });
        if (result.canceled) { setImportStatus('idle'); return; }
        if (!result.success || !result.content) { setImportStatus('error'); setImportMessage(result.error || 'Failed'); }
        else processContent(result.content);
      } else {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) { setImportStatus('idle'); return; }
          try { processContent(await file.text()); } catch { setImportStatus('error'); setImportMessage('Failed'); }
        };
        input.click();
      }
    } catch { setImportStatus('error'); setImportMessage('Failed'); }
    setTimeout(() => { setImportStatus('idle'); setImportMessage(null); }, 3000);
  }, []);

  return (
    <>
      <div className="space-y-6">
        <SectionHeading icon={Power}>Application</SectionHeading>
        <SectionCard>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white/90">Launch on Startup</p>
              <p className="text-xs text-white/35 mt-0.5">Automatically start Ark when you log in (minimized to system tray)</p>
            </div>
            <Toggle value={autoLaunch} onChange={handleAutoLaunchToggle} />
          </div>
          <div className="border-t border-white/[0.04] pt-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5">
                  <Code2 className="h-3.5 w-3.5 text-white/40" />
                  <p className="text-sm font-medium text-white/90">Developer Mode</p>
                </div>
                <p className="text-xs text-white/35 mt-0.5">Show Data Flow page, system status panels, and pipeline diagnostics</p>
              </div>
              <Toggle value={devMode} onChange={() => setDevMode(!devMode)} />
            </div>
          </div>
        </SectionCard>

        <SectionHeading icon={Database}>Library Data</SectionHeading>
        <SectionCard>
          <div>
            <p className="text-sm font-medium text-white/90">Export & Import</p>
            <p className="text-xs text-white/35 mt-0.5">Backup or restore your library data as JSON</p>
          </div>
          <div className="flex gap-3">
            <Button variant="ghost" size="sm" onClick={handleExportLibrary} disabled={exportStatus === 'loading'}
              className="flex-1 h-10 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/70">
              {exportStatus === 'loading' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Export Library
            </Button>
            <Button variant="ghost" size="sm" onClick={handleImportLibrary} disabled={importStatus === 'loading'}
              className="flex-1 h-10 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/70">
              {importStatus === 'loading' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              Import Library
            </Button>
          </div>
          {importMessage && (
            <div className={cn('flex items-center gap-2 text-xs', (importStatus === 'success' || exportStatus === 'success') ? 'text-emerald-400/70' : 'text-red-400/70')}>
              {(importStatus === 'success' || exportStatus === 'success') ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
              {importMessage}
            </div>
          )}
          <p className="text-xs text-white/25">Import merges with existing data: new games are added, changed games are updated.</p>
        </SectionCard>

        <SectionHeading icon={Sparkles}>Year in Review</SectionHeading>
        <SectionCard>
          <div>
            <p className="text-sm font-medium text-white/90">Ark Wrapped</p>
            <p className="text-xs text-white/35 mt-0.5">Relive your gaming year — stats, top games, genre DNA, and more in a cinematic experience.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowWrapped(true)}
            className="w-full h-10 bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08] text-white/60 hover:text-white/80 font-semibold gap-2">
            <Sparkles className="h-4 w-4" /> Launch Ark Wrapped
          </Button>
        </SectionCard>
      </div>

      <YearWrapped isOpen={showWrapped} onClose={() => setShowWrapped(false)} />
    </>
  );
});

// ─── AI Models Tab ────────────────────────────────────────────────────────────

const AIModelsTab = memo(function AIModelsTab() {
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('gemma3:12b');
  const [useGeminiInstead, setUseGeminiInstead] = useState(false);
  const [ollamaSaveStatus, setOllamaSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const ollamaDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const initialLoadRef = useRef(true);

  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Azure OpenAI state
  const [azureEndpoint, setAzureEndpoint] = useState(() => {
    try { return localStorage.getItem('ark-azure-endpoint') || ''; } catch { return ''; }
  });
  const [azureKey, setAzureKey] = useState(() => {
    try { return localStorage.getItem('ark-azure-key') || ''; } catch { return ''; }
  });
  const [azureDeployment, setAzureDeployment] = useState(() => {
    try { return localStorage.getItem('ark-azure-deployment') || ''; } catch { return ''; }
  });

  // Anthropic state
  const [anthropicKey, setAnthropicKey] = useState(() => {
    try { return localStorage.getItem('ark-anthropic-key') || ''; } catch { return ''; }
  });
  const [anthropicModel, setAnthropicModel] = useState(() => {
    try { return localStorage.getItem('ark-anthropic-model') || 'claude-sonnet-4-20250514'; } catch { return 'claude-sonnet-4-20250514'; }
  });

  useEffect(() => {
    const load = async () => {
      if (!window.settings) return;
      try {
        const exists = await window.settings.hasApiKey();
        setHasExistingKey(exists);
        if (exists) { const key = await window.settings.getApiKey(); if (key) setApiKey(key); }
        const s = await window.settings.getOllamaSettings();
        setOllamaUrl(s.url); setOllamaModel(s.model); setUseGeminiInstead(s.useGeminiInstead ?? false);
        initialLoadRef.current = false;
      } catch { initialLoadRef.current = false; }
    };
    load();
    return () => { if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current); if (ollamaDebounceRef.current) clearTimeout(ollamaDebounceRef.current); };
  }, []);

  useEffect(() => {
    if (initialLoadRef.current || !window.settings) return;
    if (ollamaDebounceRef.current) clearTimeout(ollamaDebounceRef.current);
    setOllamaSaveStatus('saving');
    ollamaDebounceRef.current = setTimeout(async () => {
      try { await window.settings!.setOllamaSettings({ url: ollamaUrl, model: ollamaModel, useGeminiInstead }); setOllamaSaveStatus('saved'); setTimeout(() => setOllamaSaveStatus('idle'), 2000); }
      catch { /* ignore */ }
    }, 800);
  }, [ollamaUrl, ollamaModel, useGeminiInstead]);

  useEffect(() => {
    if (initialLoadRef.current || !window.settings || !apiKey.trim()) { setSaveStatus('idle'); return; }
    if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    setSaveStatus('saving');
    debounceTimeoutRef.current = setTimeout(async () => {
      try { await window.settings!.setApiKey(apiKey.trim()); setSaveStatus('saved'); setHasExistingKey(true); setError(null); setTimeout(() => setSaveStatus('idle'), 2000); }
      catch { setSaveStatus('error'); setError('Failed to save API key'); }
    }, 800);
    return () => { if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current); };
  }, [apiKey]);

  // Persist Azure & Anthropic to localStorage
  useEffect(() => { try { localStorage.setItem('ark-azure-endpoint', azureEndpoint); localStorage.setItem('ark-azure-key', azureKey); localStorage.setItem('ark-azure-deployment', azureDeployment); } catch {} }, [azureEndpoint, azureKey, azureDeployment]);
  useEffect(() => { try { localStorage.setItem('ark-anthropic-key', anthropicKey); localStorage.setItem('ark-anthropic-model', anthropicModel); } catch {} }, [anthropicKey, anthropicModel]);

  const handleRemoveApiKey = useCallback(async () => {
    if (!window.settings) return;
    setIsLoading(true); setError(null);
    try { await window.settings.removeApiKey(); setApiKey(''); setHasExistingKey(false); setSaveStatus('idle'); }
    catch { setError('Failed to remove API key'); }
    finally { setIsLoading(false); }
  }, []);

  const getMaskedKey = (key: string) => (!key || key.length < 10) ? key : key.substring(0, 8) + '•'.repeat(16) + key.substring(key.length - 4);

  return (
    <div className="space-y-6">
      {/* Ollama */}
      <SectionHeading icon={Bot}>Ollama (Local AI)</SectionHeading>
      <SectionCard className={useGeminiInstead ? 'opacity-50' : undefined}>
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-white/90">Local AI with Ollama</p>
            {!useGeminiInstead && <span className="text-[10px] text-white/40 bg-white/[0.05] px-1.5 py-0.5 rounded border border-white/[0.06]">Default</span>}
          </div>
          <p className="text-xs text-white/35 mt-0.5">Runs on your computer for privacy. Make sure Ollama is running.</p>
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Ollama URL</label>
          <Input type="text" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} placeholder="http://localhost:11434"
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" disabled={useGeminiInstead} />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Model Name</label>
          <Input type="text" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} placeholder="gemma3:12b"
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" disabled={useGeminiInstead} />
        </div>
        <div className="flex items-center gap-2 text-xs">
          {ollamaSaveStatus === 'saving' && <><Loader2 className="h-3 w-3 animate-spin text-white/40" /><span className="text-white/40">Saving...</span></>}
          {ollamaSaveStatus === 'saved' && <><Check className="h-3 w-3 text-emerald-400/60" /><span className="text-white/40">Saved</span></>}
          {ollamaSaveStatus === 'idle' && <span className="text-white/25">Changes save automatically</span>}
        </div>
        <p className="text-xs text-white/25">Don&apos;t have Ollama? <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="text-white/50 hover:text-white/70 underline">Download Ollama</a></p>
      </SectionCard>

      {/* Gemini */}
      <SectionHeading icon={Key}>Google Gemini</SectionHeading>
      <SectionCard>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white/90">Use Gemini Instead</p>
            <p className="text-xs text-white/35 mt-0.5">Switch to Google Gemini for enhanced features (tools, search)</p>
          </div>
          <Toggle value={useGeminiInstead} onChange={() => setUseGeminiInstead(!useGeminiInstead)} />
        </div>
        {useGeminiInstead && (
          <div className="space-y-3 pt-2 border-t border-white/[0.04]">
            <div className="relative">
              <label className="text-xs text-white/40 mb-1 block">Gemini API Key</label>
              <Input type={showApiKey ? 'text' : 'password'} placeholder="Enter your Google AI API key..."
                value={showApiKey ? apiKey : (hasExistingKey && apiKey ? getMaskedKey(apiKey) : apiKey)}
                onChange={(e) => setApiKey(e.target.value)} className="pr-10 bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" disabled={isLoading} />
              <button type="button" onClick={() => setShowApiKey(!showApiKey)} className="absolute right-3 bottom-2.5 text-white/40 hover:text-white/70 transition-colors">
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error && <div className="flex items-center gap-2 text-red-400/70 text-xs"><AlertCircle className="h-3 w-3" />{error}</div>}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs">
                {saveStatus === 'saving' && <><Loader2 className="h-3 w-3 animate-spin text-white/40" /><span className="text-white/40">Saving...</span></>}
                {saveStatus === 'saved' && <><Check className="h-3 w-3 text-emerald-400/60" /><span className="text-white/40">Saved</span></>}
                {saveStatus === 'idle' && hasExistingKey && <><Check className="h-3 w-3 text-white/30" /><span className="text-white/30">Key configured</span></>}
                {saveStatus === 'idle' && !hasExistingKey && <span className="text-white/25">Changes save automatically</span>}
              </div>
              {hasExistingKey && (
                <Button variant="ghost" size="sm" onClick={handleRemoveApiKey} disabled={isLoading} className="h-7 text-white/30 hover:text-red-400/70 hover:bg-red-500/10">
                  <Trash2 className="h-3 w-3 mr-1" /> Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-white/25">Get your API key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-white/50 hover:text-white/70 underline">Google AI Studio</a></p>
          </div>
        )}
      </SectionCard>

      {/* Azure OpenAI */}
      <SectionHeading icon={Globe}>Azure OpenAI</SectionHeading>
      <SectionCard>
        <div>
          <p className="text-sm font-medium text-white/90">Azure OpenAI Service</p>
          <p className="text-xs text-white/35 mt-0.5">Connect to your Azure-hosted OpenAI deployment for enterprise-grade inference.</p>
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Endpoint URL</label>
          <Input type="text" value={azureEndpoint} onChange={(e) => setAzureEndpoint(e.target.value)} placeholder="https://your-resource.openai.azure.com/"
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">API Key</label>
          <Input type="password" value={azureKey} onChange={(e) => setAzureKey(e.target.value)} placeholder="Your Azure OpenAI API key"
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Deployment Name</label>
          <Input type="text" value={azureDeployment} onChange={(e) => setAzureDeployment(e.target.value)} placeholder="gpt-4o"
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" />
        </div>
        <p className="text-xs text-white/25">Configure your Azure OpenAI resource in the <a href="https://portal.azure.com/" target="_blank" rel="noopener noreferrer" className="text-white/50 hover:text-white/70 underline">Azure Portal</a>.</p>
      </SectionCard>

      {/* Anthropic */}
      <SectionHeading icon={MessageCircle}>Anthropic (Claude)</SectionHeading>
      <SectionCard>
        <div>
          <p className="text-sm font-medium text-white/90">Anthropic Claude</p>
          <p className="text-xs text-white/35 mt-0.5">Use Claude models from Anthropic for nuanced, safety-focused AI responses.</p>
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">API Key</label>
          <Input type="password" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder="sk-ant-..."
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Model</label>
          <Input type="text" value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} placeholder="claude-sonnet-4-20250514"
            className="bg-white/[0.03] border-white/[0.06] focus:border-white/[0.12]" />
        </div>
        <p className="text-xs text-white/25">Get API keys from <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-white/50 hover:text-white/70 underline">Anthropic Console</a>.</p>
      </SectionCard>

      {/* Provider info */}
      <div className="bg-white/[0.02] border border-white/[0.05] rounded-xl p-4">
        <h4 className="text-xs font-medium text-white/50 mb-2">About AI Providers</h4>
        <ul className="text-xs text-white/30 space-y-1.5">
          <li>• <strong className="text-white/40">Ollama</strong> — Runs locally on your machine. Private, free, no cloud dependency.</li>
          <li>• <strong className="text-white/40">Gemini</strong> — Google Cloud AI with tool calling, web search grounding, and validation.</li>
          <li>• <strong className="text-white/40">Azure OpenAI</strong> — Enterprise-grade GPT models hosted in your Azure subscription.</li>
          <li>• <strong className="text-white/40">Anthropic Claude</strong> — Advanced reasoning and nuanced responses with safety focus.</li>
          <li>• All API keys are stored securely and encrypted on your device.</li>
        </ul>
      </div>
    </div>
  );
});

// ─── Guide Tab ────────────────────────────────────────────────────────────────

interface GuideStep { title: string; description: string; icon: React.ElementType; color: string }

const GUIDE_STEPS: GuideStep[] = [
  { title: 'Browse & Discover', description: 'Start on the Browse tab to explore the Steam and Epic catalogs. Use category filters (Top Sellers, New Releases, etc.) and genre/platform filters in the sidebar to narrow results. Click any game card to see full details.', icon: Search, color: 'text-sky-400' },
  { title: 'Build Your Library', description: 'Add games you own or want to play. Use the "+" button on any game card, or import your existing Steam/Epic libraries automatically. Track your status for each game: Playing, Completed, On Hold, or Want to Play.', icon: Library, color: 'text-emerald-400' },
  { title: 'Track Your Journey', description: 'The Voyage tab shows your gaming timeline as a Gantt chart. See when you started, paused, and completed each game. Add notes, rate your experience, and watch your gaming history unfold visually.', icon: Compass, color: 'text-violet-400' },
  { title: 'Get AI Recommendations', description: 'The Oracle analyzes your library, play history, genres, and ratings to recommend games you\'ll love. Recommendations improve as you add more games and ratings. Each suggestion comes with an explanation.', icon: Brain, color: 'text-fuchsia-400' },
  { title: 'Explore the Galaxy', description: 'The Embedding Space is a 3D galaxy map where every game is a star. Games that are similar cluster together. Fly through genre regions, discover neighbors, and find hidden gems based on game DNA — not just tags.', icon: Map, color: 'text-amber-400' },
  { title: 'Stay Informed', description: 'Transmissions aggregates gaming news from 20+ sources (Steam, PC Gamer, IGN, etc.). Articles are deduplicated, thumbnails are auto-extracted, and you can archive favorites. The Decode Bay opens articles inline.', icon: Newspaper, color: 'text-rose-400' },
  { title: 'Plan Ahead', description: 'The Releases calendar shows upcoming game launches grouped by month, week, or day. Filter by store (Steam/Epic) and see countdowns to releases you\'re watching.', icon: Calendar, color: 'text-cyan-400' },
  { title: 'Earn Medals', description: 'Track your gaming achievements with the Medals system. Earn badges for milestones like playing streaks, genre diversity, completing games, and building your collection. Your play streak heatmap shows consistency.', icon: Trophy, color: 'text-yellow-400' },
];

const GuideTab = memo(function GuideTab() {
  return (
    <div className="space-y-6">
      <SectionHeading icon={BookOpen}>Getting Started</SectionHeading>
      <p className="text-sm text-white/40 -mt-2 mb-4">Follow these steps to get the most out of Ark. Each section of the app is designed to work together — your library feeds recommendations, which feed the galaxy, which helps you discover more.</p>
      <div className="space-y-4">
        {GUIDE_STEPS.map((step, i) => (
          <div key={step.title} className="flex gap-4 group">
            <div className="flex flex-col items-center">
              <div className={cn('w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center', step.color)}>
                <step.icon className="h-5 w-5" />
              </div>
              {i < GUIDE_STEPS.length - 1 && <div className="w-px flex-1 bg-white/[0.06] mt-2" />}
            </div>
            <div className="pb-6 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-mono text-white/20">STEP {String(i + 1).padStart(2, '0')}</span>
              </div>
              <h4 className="text-sm font-semibold text-white/90 mb-1.5">{step.title}</h4>
              <p className="text-xs text-white/40 leading-relaxed">{step.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

// ─── Features Tab ─────────────────────────────────────────────────────────────

interface FeatureBlock { title: string; desc: string; icon: React.ElementType; color: string }

const CORE_FEATURES: FeatureBlock[] = [
  { title: 'Unified Game Catalog', desc: 'Browse thousands of games from Steam and Epic Games Store in one place. Real-time sync pulls trending, top-selling, and new releases with full metadata including descriptions, screenshots, reviews, and pricing.', icon: Gamepad2, color: 'text-sky-400' },
  { title: 'Smart Library Management', desc: 'Your personal collection with rich tracking — status (Playing, Completed, On Hold, Want to Play), ratings, notes, and play sessions. Collapsible status sections keep everything organized. Import/export as JSON for backups.', icon: Library, color: 'text-emerald-400' },
  { title: 'AI-Powered Recommendations', desc: 'The Oracle engine combines a machine learning model (LightGBM trained on 41M reviews), vector similarity search (HNSW index on TF-IDF weighted genre embeddings), and optional LLM validation to surface games tailored to your taste.', icon: Brain, color: 'text-fuchsia-400' },
  { title: '3D Embedding Space', desc: 'Every game is embedded as a vector based on its genres, themes, description, and developer. PCA projects these high-dimensional vectors into a 3D galaxy where similar games cluster as stars. Fly through it, click stars, traverse neighbors.', icon: Map, color: 'text-amber-400' },
  { title: 'Live News Aggregation', desc: 'Transmissions pulls from 20+ RSS feeds and the Steam News API, deduplicates articles, extracts thumbnails, and presents a unified gaming news stream. Archive favorites, filter by gaming events, and read articles inline.', icon: Newspaper, color: 'text-rose-400' },
  { title: 'Release Calendar', desc: 'Upcoming releases from Steam and Epic, organized by year, month, week, or day view. Today\'s releases appear first. Filter by store, browse by genre, and never miss a launch.', icon: Calendar, color: 'text-cyan-400' },
  { title: 'Achievement System', desc: 'Earn medals for gaming milestones — play streaks, genre diversity, collection size, completion rate, and more. A heatmap visualizes your play streak across the year. Progress bars show how close you are to each badge.', icon: Trophy, color: 'text-yellow-400' },
  { title: 'Event Intelligence', desc: 'Scheduled Broadcasts tracks 24 major gaming events (E3, Gamescom, TGA, etc.) by scraping their official websites for dates, YouTube, and Twitch links. Live countdowns, LIVE badges, and one-click stream access.', icon: Globe, color: 'text-violet-400' },
];

const AI_EXPLAINER: { title: string; what: string; icon: React.ElementType }[] = [
  { title: 'How does the AI find games I\'ll like?', what: 'Ark looks at every game you\'ve played, rated, and spent time with. It builds a "taste profile" from your favorite genres, themes, and developers. Then it searches through thousands of games to find ones that match your profile — like a friend who knows your taste perfectly.', icon: Heart },
  { title: 'What is the Galaxy Map?', what: 'Imagine every game as a star in the sky. Games that are similar (same genres, themes, style) are placed close together. The galaxy map lets you fly through this space and discover clusters of games you might love, just by exploring the neighborhood of a game you already enjoy.', icon: Star },
  { title: 'Is my data private?', what: 'Yes. By default, everything runs locally on your computer using Ollama (a local AI). Your game library, ratings, and play history never leave your machine. Cloud AI (Gemini, Azure, Anthropic) is optional and only activated if you explicitly configure it.', icon: Shield },
  { title: 'What does the AI chat assistant do?', what: 'You can ask the assistant questions like "find me a game like Hollow Knight" or "what should I play next?" It searches the catalog, looks at your library, and gives personalized suggestions with explanations. It can even add games to your library for you.', icon: MessageCircle },
  { title: 'How accurate are recommendations?', what: 'The recommendation engine uses a machine learning model trained on 41 million real player reviews. Combined with genre analysis and your personal history, it gets smarter the more games you rate. Think of it as learning your taste over time.', icon: TrendingUp },
];

const FeaturesTab = memo(function FeaturesTab() {
  return (
    <div className="space-y-8">
      <div>
        <SectionHeading icon={Layers}>Core Features</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CORE_FEATURES.map((f) => (
            <div key={f.title} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-2 hover:border-white/[0.1] transition-colors">
              <div className="flex items-center gap-2.5">
                <div className={cn('w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center', f.color)}>
                  <f.icon className="h-4 w-4" />
                </div>
                <h4 className="text-sm font-semibold text-white/90">{f.title}</h4>
              </div>
              <p className="text-xs text-white/40 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeading icon={Wand2}>How AI Works in Ark</SectionHeading>
        <p className="text-sm text-white/40 -mt-2 mb-4">No jargon — here&apos;s what the AI actually does, explained simply.</p>
        <div className="space-y-3">
          {AI_EXPLAINER.map((item) => (
            <SectionCard key={item.title}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/20 flex items-center justify-center text-fuchsia-400 shrink-0 mt-0.5">
                  <item.icon className="h-4 w-4" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white/90 mb-1">{item.title}</h4>
                  <p className="text-xs text-white/40 leading-relaxed">{item.what}</p>
                </div>
              </div>
            </SectionCard>
          ))}
        </div>
      </div>
    </div>
  );
});

// ─── About Tab ────────────────────────────────────────────────────────────────

const TEAM = [
  { name: 'Pourab Karchaudhuri', role: 'Lead Developer', bio: 'Full-stack engineer passionate about gaming, data visualization, and building tools that feel like they belong in the games themselves. Designed the Ark architecture, ML pipeline, and the galaxy map.', avatar: 'PK' },
  { name: 'Sanket Aley', role: 'Developer', bio: 'Software engineer with a love for clean code and great user experiences. Contributed to core features, testing infrastructure, and the seamless integration between Steam, Epic, and the recommendation engine.', avatar: 'SA' },
];

const KEY_PACKAGES: { name: string; desc: string; url: string }[] = [
  { name: 'Electron', desc: 'Cross-platform desktop framework', url: 'https://www.electronjs.org/' },
  { name: 'React', desc: 'UI component library', url: 'https://react.dev/' },
  { name: 'Vite', desc: 'Next-gen frontend build tool', url: 'https://vite.dev/' },
  { name: 'TypeScript', desc: 'Typed JavaScript superset', url: 'https://www.typescriptlang.org/' },
  { name: 'Tailwind CSS', desc: 'Utility-first CSS framework', url: 'https://tailwindcss.com/' },
  { name: 'Framer Motion', desc: 'Production-ready animation library', url: 'https://www.framer.com/motion/' },
  { name: 'Three.js / R3F', desc: '3D rendering and React bindings', url: 'https://threejs.org/' },
  { name: 'LangChain.js', desc: 'LLM framework for tool calling & streaming', url: 'https://js.langchain.com/' },
  { name: 'React Flow', desc: 'Node-based diagram library', url: 'https://reactflow.dev/' },
  { name: 'ONNX Runtime', desc: 'ML model inference engine', url: 'https://onnxruntime.ai/' },
  { name: 'uSearch / HNSW', desc: 'Approximate nearest neighbor search', url: 'https://github.com/unum-cloud/usearch' },
  { name: 'Radix UI', desc: 'Accessible component primitives', url: 'https://www.radix-ui.com/' },
  { name: 'Recharts', desc: 'Charting library for React', url: 'https://recharts.org/' },
  { name: 'Lucide', desc: 'Beautiful icon set', url: 'https://lucide.dev/' },
  { name: 'Vitest + Playwright', desc: 'Unit & E2E testing', url: 'https://vitest.dev/' },
];

const AboutTab = memo(function AboutTab() {
  const [showTerms, setShowTerms] = useState(false);

  return (
    <div className="space-y-6">
      {/* Team */}
      <SectionHeading icon={Users}>The Team</SectionHeading>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {TEAM.map((member) => (
          <SectionCard key={member.name}>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-fuchsia-500/30 to-violet-500/20 border border-white/[0.1] flex items-center justify-center text-white/70 font-bold text-sm">
                {member.avatar}
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white/90">{member.name}</h4>
                <p className="text-xs text-fuchsia-400/60">{member.role}</p>
              </div>
            </div>
            <p className="text-xs text-white/40 leading-relaxed">{member.bio}</p>
          </SectionCard>
        ))}
      </div>

      {/* Version */}
      <SectionHeading icon={Info}>Version</SectionHeading>
      <SectionCard>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white/90">Ark</p>
            <p className="text-xs text-white/35 mt-0.5">Game Tracker & Recommendations</p>
          </div>
          <span className="font-mono text-sm text-fuchsia-400/70 bg-fuchsia-500/10 px-3 py-1 rounded-lg border border-fuchsia-500/20">v{APP_VERSION}</span>
        </div>
        <div className="flex gap-4 text-xs text-white/25">
          <span>Electron + React + TypeScript</span>
          <span>•</span>
          <span>Built with Vite</span>
        </div>
      </SectionCard>

      {/* Open Source Credits */}
      <SectionHeading icon={Package}>Open Source Credits</SectionHeading>
      <SectionCard>
        <p className="text-xs text-white/40 mb-2">Ark is built on the shoulders of these incredible open-source projects.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
          {KEY_PACKAGES.map((pkg) => (
            <a key={pkg.name} href={pkg.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-between py-1.5 border-b border-white/[0.03] hover:border-white/[0.08] transition-colors group">
              <div>
                <span className="text-xs font-medium text-white/70 group-hover:text-white/90 transition-colors">{pkg.name}</span>
                <span className="text-[10px] text-white/25 ml-2">{pkg.desc}</span>
              </div>
              <ExternalLink className="h-3 w-3 text-white/10 group-hover:text-white/30 transition-colors shrink-0" />
            </a>
          ))}
        </div>
      </SectionCard>

      {/* Terms of Use */}
      <SectionHeading icon={Scale}>Terms of Use</SectionHeading>
      <SectionCard>
        <button onClick={() => setShowTerms(!showTerms)} className="w-full flex items-center justify-between text-left">
          <div>
            <p className="text-sm font-medium text-white/90">Terms of Use & License</p>
            <p className="text-xs text-white/35 mt-0.5">Usage terms, data handling, and third-party service disclaimers.</p>
          </div>
          <motion.div animate={{ rotate: showTerms ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ArrowLeft className="h-4 w-4 text-white/30 -rotate-90" />
          </motion.div>
        </button>
        <AnimatePresence>
          {showTerms && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }} className="overflow-hidden">
              <div className="pt-3 border-t border-white/[0.04] space-y-3 text-xs text-white/35 leading-relaxed">
                <p><strong className="text-white/50">Personal Use.</strong> Ark is provided for personal, non-commercial use. It is not affiliated with, endorsed by, or connected to Valve Corporation (Steam), Epic Games, Google, Microsoft, or Anthropic.</p>
                <p><strong className="text-white/50">Data Privacy.</strong> All library data, play history, and preferences are stored locally on your device. No personal data is sent to external servers unless you explicitly configure a cloud AI provider (Gemini, Azure OpenAI, or Anthropic), in which case only conversation context is transmitted to the selected provider per their terms.</p>
                <p><strong className="text-white/50">Third-Party APIs.</strong> Ark accesses the Steam Web API, Epic Games Store API, and IGDB API to retrieve publicly available game metadata (titles, descriptions, images, pricing, reviews). This data belongs to the respective platforms and is used under their API terms of service.</p>
                <p><strong className="text-white/50">AI & Recommendations.</strong> Recommendations are generated algorithmically and may not reflect personal preferences perfectly. The ML model is trained on aggregated, anonymized public review data. AI chat responses are generated by language models and should not be considered authoritative.</p>
                <p><strong className="text-white/50">News Content.</strong> Transmissions aggregates publicly available RSS feeds from gaming news outlets. Article content belongs to the respective publishers. Ark provides links back to original sources.</p>
                <p><strong className="text-white/50">No Warranty.</strong> Ark is provided "as is" without warranty of any kind. The developers are not liable for any damages arising from use of the application.</p>
                <p><strong className="text-white/50">Open Source.</strong> Ark uses open-source libraries listed in the Credits section above, each under their respective licenses (MIT, Apache 2.0, ISC, etc.).</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </SectionCard>
    </div>
  );
});

// ─── Tab content router ───────────────────────────────────────────────────────

const TAB_COMPONENTS: Record<SettingsTab, React.ComponentType> = {
  general: GeneralTab,
  'ai-models': AIModelsTab,
  guide: GuideTab,
  features: FeaturesTab,
  about: AboutTab,
};

// ─── Main Settings Screen ─────────────────────────────────────────────────────

interface SettingsScreenProps { onBack: () => void }

export const SettingsScreen = memo(function SettingsScreen({ onBack }: SettingsScreenProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const ActiveComponent = TAB_COMPONENTS[activeTab];

  return (
    <div className="fixed inset-0 top-[52px] z-30 bg-black flex">
      {/* Sidebar */}
      <aside className="w-[220px] border-r border-white/[0.06] flex flex-col bg-black/40 shrink-0">
        <div className="px-4 pt-5 pb-4">
          <Button onClick={onBack} variant="ghost" size="sm"
            className="h-8 text-white/40 hover:text-white hover:bg-white/10 border border-white/[0.06] gap-1.5 font-mono text-[11px] w-full justify-start">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back</span>
          </Button>
        </div>

        <div className="px-3 pb-3">
          <div className="flex items-center gap-2 px-2 mb-4">
            <Settings className="h-4 w-4 text-fuchsia-400/70" />
            <span className="text-sm font-semibold text-white/80">Settings</span>
          </div>

          <nav className="space-y-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all text-left',
                  activeTab === tab.id
                    ? 'bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/20'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04] border border-transparent',
                )}
              >
                <tab.icon className="h-4 w-4 shrink-0" />
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="mt-auto px-4 py-3 border-t border-white/[0.05]">
          <p className="text-[10px] text-white/15 font-mono">Ark v{APP_VERSION}</p>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-8">
          <div className="mb-6">
            <h1 className="text-xl font-bold text-white/90">{TABS.find(t => t.id === activeTab)?.label}</h1>
            <div className="h-px bg-white/[0.06] mt-3" />
          </div>
          <ActiveComponent />
        </div>
      </main>
    </div>
  );
});
