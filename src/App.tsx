import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { useFlightStore } from '@/stores/flightStore';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { isWebMode } from '@/lib/api';

/** Loading overlay shown during database initialization/migration */
function InitializationOverlay() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-drone-dark">
      <div className="flex flex-col items-center gap-6">
        {/* App icon/logo placeholder */}
        <div className="w-16 h-16 rounded-2xl bg-drone-primary/20 flex items-center justify-center">
          <svg
            className="w-10 h-10 text-drone-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
            />
          </svg>
        </div>
        
        <div className="text-center">
          <h2 className="text-lg font-medium text-white mb-2">{t('app.initializing')}</h2>
          <p className="text-sm text-gray-400">{t('app.initProgress')}</p>
        </div>
        
        {/* Animated progress bar */}
        <div className="w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full w-1/2 bg-drone-primary rounded-full init-progress-bar" />
        </div>
      </div>
    </div>
  );
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  state = { hasError: false, error: undefined as Error | undefined };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('App crashed:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full bg-drone-dark text-gray-200 flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-3">
            <h2 className="text-lg font-semibold text-white">{i18n.t('app.errorTitle')}</h2>
            <p className="text-sm text-gray-400">
              {i18n.t('app.errorDescription')}
            </p>
            {this.state.error && (
              <pre className="text-xs text-gray-500 whitespace-pre-wrap break-words">
                {this.state.error.message}
              </pre>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  const { t } = useTranslation();
  const { loadFlights, error, clearError, donationAcknowledged, themeMode, isFlightsInitialized } = useFlightStore();
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false;
    return sessionStorage.getItem('donationBannerDismissed') === 'true';
  });

  // Load flights on mount
  useEffect(() => {
    loadFlights();
  }, [loadFlights]);

  // Ctrl+Q to close window (Tauri desktop only)
  useEffect(() => {
    if (isWebMode()) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().close();
        } catch (err) {
          console.error('Failed to close window:', err);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('Window error:', event.error || event.message);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled rejection:', event.reason);
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const showDonationBanner = useMemo(
    () => !donationAcknowledged && !bannerDismissed,
    [donationAcknowledged, bannerDismissed]
  );

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
      }
      return 'dark';
    }
    return themeMode;
  }, [themeMode]);

  const handleDismissBanner = () => {
    setBannerDismissed(true);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('donationBannerDismissed', 'true');
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-drone-dark overflow-hidden">
      {/* Initialization overlay - shown during DB migration */}
      {!isFlightsInitialized && <InitializationOverlay />}
      
      {showDonationBanner && (
        <div
          className={`w-full border-b border-drone-primary/40 text-gray-100 ${
            resolvedTheme === 'light'
              ? 'bg-gradient-to-r from-violet-200 via-fuchsia-200 to-orange-200 text-gray-900'
              : 'bg-gradient-to-r from-violet-900 via-purple-900 to-orange-900'
          }`}
        >
          <div className="relative mx-auto flex w-full items-center justify-center gap-4 px-4 py-[17px]">
            <div className="flex flex-nowrap items-center justify-center gap-2 text-[0.95rem] md:text-[1rem] text-center px-6">
              <span>
                {t('app.bannerText')}
              </span>
              <a
                href="https://github.com/arpanghosh8453/open-dronelog"
                target="_blank"
                rel="noopener noreferrer"
                className={
                  resolvedTheme === 'light'
                    ? 'text-indigo-700 hover:underline font-semibold'
                    : 'text-drone-primary hover:underline font-semibold'
                }
              >
                GitHub
              </a> {t('app.bannerBy')}
              <span className={resolvedTheme === 'light' ? 'text-gray-500' : 'text-gray-400'}>
                •
              </span>
              <span>
                {t('app.bannerSupport')}
              </span>
              <a
                href="https://ko-fi.com/arpandesign"
                target="_blank"
                rel="noopener noreferrer"
                className={
                  resolvedTheme === 'light'
                    ? 'text-indigo-700 hover:underline font-semibold'
                    : 'text-amber-300 hover:text-amber-200 hover:underline font-semibold'
                }
              >
                Ko-fi
              </a>
            </div>
            <button
              onClick={handleDismissBanner}
              className={`absolute right-3 md:right-4 rounded-md px-2.5 py-1.5 transition-colors ${
                resolvedTheme === 'light'
                  ? 'text-gray-600 hover:text-gray-900'
                  : 'text-gray-300 hover:text-white'
              }`}
              aria-label={t('app.dismissBanner')}
              title={t('app.dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-500/90 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 max-w-md">
          <span className="text-sm">{error}</span>
          <button
            onClick={clearError}
            className="text-white/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Dashboard */}
      <AppErrorBoundary>
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      </AppErrorBoundary>
    </div>
  );
}

export default App;
