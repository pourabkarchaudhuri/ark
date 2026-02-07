/**
 * Settings Panel Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SettingsPanel } from '@/components/settings-panel';

// Mock window.settings
const mockSettings = {
  getApiKey: vi.fn(),
  setApiKey: vi.fn(),
  removeApiKey: vi.fn(),
  hasApiKey: vi.fn(),
  getOllamaSettings: vi.fn(),
  setOllamaSettings: vi.fn(),
};

// Setup window mock before each test
beforeEach(() => {
  vi.clearAllMocks();
  window.settings = mockSettings;
  
  // Default Ollama settings - useGeminiInstead: true so API key section is visible
  mockSettings.getOllamaSettings.mockResolvedValue({
    enabled: true,
    url: 'http://localhost:11434',
    model: 'gemma3:12b',
    useGeminiInstead: true,
  });
});

describe('SettingsPanel', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SettingsPanel isOpen={false} onClose={() => {}} />
    );
    expect(container.querySelector('[data-testid="settings-panel"]')).toBeNull();
  });

  it('renders panel when open', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);
    mockSettings.getApiKey.mockResolvedValue(null);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
  });

  it('shows close button and calls onClose when clicked', async () => {
    const onClose = vi.fn();
    mockSettings.hasApiKey.mockResolvedValue(false);

    render(<SettingsPanel isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    // Find the X button (first button with X icon, in header area)
    const buttons = screen.getAllByRole('button');
    // Find button that's likely the close button (icon only, in header)
    const closeButton = buttons.find(btn => {
      // Check if it has ghost variant styling and is near the header
      return btn.className.includes('ghost') || btn.querySelector('svg');
    });
    
    expect(closeButton).toBeTruthy();
    
    if (closeButton) {
      fireEvent.click(closeButton);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it('displays API key section', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Gemini API Key')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/enter your google ai api key/i)).toBeInTheDocument();
    });
  });

  it('shows Configured badge when API key exists', async () => {
    mockSettings.hasApiKey.mockResolvedValue(true);
    mockSettings.getApiKey.mockResolvedValue('test-api-key-12345');

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Configured')).toBeInTheDocument();
    });
  });

  it('allows entering a new API key', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);
    mockSettings.setApiKey.mockResolvedValue(undefined);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/enter your google ai api key/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/enter your google ai api key/i);
    fireEvent.change(input, { target: { value: 'new-api-key-12345' } });

    expect(input).toHaveValue('new-api-key-12345');
  });

  it('auto-saves API key when entered', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);
    mockSettings.setApiKey.mockResolvedValue(undefined);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/enter your google ai api key/i)).toBeInTheDocument();
    });

    // Enter a key
    const input = screen.getByPlaceholderText(/enter your google ai api key/i);
    fireEvent.change(input, { target: { value: 'new-api-key-12345' } });

    // Wait for debounced auto-save (800ms + buffer)
    await waitFor(() => {
      expect(mockSettings.setApiKey).toHaveBeenCalledWith('new-api-key-12345');
    }, { timeout: 2000 });
  });

  it('removes API key when Remove button is clicked', async () => {
    mockSettings.hasApiKey.mockResolvedValue(true);
    mockSettings.getApiKey.mockResolvedValue('existing-key');
    mockSettings.removeApiKey.mockResolvedValue(undefined);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Configured')).toBeInTheDocument();
    });

    // Get all buttons and find the one with red/trash styling (last button after Save)
    const buttons = screen.getAllByRole('button');
    // The trash button has red styling - find it by class name
    const trashButton = buttons.find(btn => 
      btn.className.includes('red') || btn.className.includes('border-red')
    );
    
    expect(trashButton).toBeTruthy();
    
    if (trashButton) {
      await act(async () => {
        fireEvent.click(trashButton);
      });

      await waitFor(() => {
        expect(mockSettings.removeApiKey).toHaveBeenCalled();
      });
    }
  });

  it('toggles password visibility', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/enter your google ai api key/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/enter your google ai api key/i);
    expect(input).toHaveAttribute('type', 'password');

    // Find the eye button (toggle visibility)
    const eyeButton = input.nextElementSibling as HTMLElement;
    if (eyeButton) {
      fireEvent.click(eyeButton);
      
      await waitFor(() => {
        expect(input).toHaveAttribute('type', 'text');
      });
    }
  });

  it('shows auto-save status message', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      // Multiple sections now have auto-save status (API key + Ollama)
      const statusMessages = screen.getAllByText(/changes save automatically/i);
      expect(statusMessages.length).toBeGreaterThan(0);
    });
  });

  it('contains link to Google AI Studio', async () => {
    mockSettings.hasApiKey.mockResolvedValue(false);

    render(<SettingsPanel isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      const link = screen.getByText('Google AI Studio');
      expect(link).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
    });
  });
});

