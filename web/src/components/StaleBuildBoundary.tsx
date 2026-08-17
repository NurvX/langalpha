import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { isStaleBuildError, reportStaleBuild } from '@/lib/staleBuild';

/**
 * Catches a lazy route whose chunk a deploy deleted, and rethrows everything
 * else.
 *
 * Without this, a failed `React.lazy` import has no boundary above it anywhere:
 * `<Suspense>` handles pending promises, not rejections, so the throw walks past
 * every provider and React unmounts the whole root. The user gets a blank page
 * rather than a broken pane.
 */

function StaleBuildFallback({ variant }: { variant: 'app' | 'pane' }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 px-6 text-center ${
        variant === 'app' ? 'h-screen' : 'h-full'
      }`}
      style={{ color: 'var(--color-text-secondary)' }}
    >
      <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
        {t('common.staleBuild.title')}
      </p>
      <p className="text-xs">{t('common.staleBuild.description')}</p>
      <Button size="sm" onClick={() => window.location.reload()}>
        {t('common.staleBuild.reload')}
      </Button>
    </div>
  );
}

interface Props {
  children: React.ReactNode;
  /** `app` fills the viewport, `pane` fills the routed content area. */
  variant?: 'app' | 'pane';
}

interface State {
  error: unknown;
  stale: boolean;
}

export class StaleBuildBoundary extends React.Component<Props, State> {
  state: State = { error: null, stale: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, stale: isStaleBuildError(error) };
  }

  componentDidCatch(error: unknown): void {
    // Logged in both branches. Absorbing a chunk failure silently would hide a
    // real /assets/* 404 regression behind a friendly reload prompt.
    console.error('[StaleBuildBoundary]', error);
    if (isStaleBuildError(error)) reportStaleBuild('chunk');
  }

  render(): React.ReactNode {
    const { error, stale } = this.state;

    if (error && !stale) {
      // React has no "decline to handle" API. Returning null here would make
      // React consider the error handled, re-render the same children, and
      // throw again in a loop. Throwing during render propagates to the next
      // boundary up; with none above, that unmounts the root exactly as it did
      // before this boundary existed, so no ordinary bug is masked by it.
      throw error;
    }

    if (stale) return <StaleBuildFallback variant={this.props.variant ?? 'app'} />;
    return this.props.children;
  }
}

export default StaleBuildBoundary;
