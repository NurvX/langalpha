/**
 * The machines behind the workspace gallery.
 *
 * Deliberately a dialog rather than a page: a computer is infrastructure a
 * user visits to manage an existing machine, not a place they work. Everything about running the machine that already had a
 * home stays in the sandbox settings panel.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { Play, Square, Star } from 'lucide-react';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { ModalShell } from '@/components/ui/ModalShell';
import { Loader } from '@/components/ui/loader';
import { queryKeys } from '@/lib/queryKeys';
import type { Computer } from '@/types/api';

import { startComputer, stopComputer } from '../utils/api';
import { patchComputerStatusInCaches, useComputers } from '../hooks/useComputers';
import { ComputerStatusIndicator, isComputerStatusTransitional } from './computerStatusUi';
import { normalizeTier, tierLabel } from './tierUi';
import { denialMessage } from '../utils/denialMessage';

interface ComputersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ComputersDialog({ open, onOpenChange }: ComputersDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useComputers({ enabled: open });
  const computers = data?.computers ?? [];
  const actionMutation = useMutation({
    mutationFn: async ({ computerId, action }: { computerId: string; action: 'start' | 'stop' }) =>
      action === 'start'
        ? startComputer(computerId, { lazy: true })
        : stopComputer(computerId),
    onSuccess: (res) => {
      // Reflecting the response status is what brings a transitional machine
      // into the fan-out's watch set, so the stream reports the rest.
      patchComputerStatusInCaches(queryClient, res.computer_id, res.status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
    onError: (err) => setError(denialMessage(err, t)),
  });

  const closeAndReset = () => {
    setError(null);
    onOpenChange(false);
  };

  // Additional-computer creation stays hidden until projects can select a machine.
  return (
    <AnimatePresence>
      {open && (
        <ModalShell
          labelId={titleId}
          title={t('computer.computers', 'Computers')}
          subtitle={t('computer.computersDesc', 'Your workspaces are folders on these machines. Starting or stopping one affects every workspace it holds.')}
          onClose={closeAndReset}
          width="standard"
          density="form"
        >
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 justify-center" style={{ color: 'var(--color-text-tertiary)' }}>
              <Loader size={14} style={{ color: 'var(--color-accent-primary)' }} />
              <span className="text-sm">{t('computer.loading', 'Loading computers')}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {computers.length === 0 && (
                <p className="text-sm py-4" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('computer.empty', 'No computers yet. Your first workspace creates one.')}
                </p>
              )}
              {computers.map((computer) => (
                <ComputerRow
                  key={computer.computer_id}
                  computer={computer}
                  busy={
                    actionMutation.isPending &&
                    actionMutation.variables?.computerId === computer.computer_id
                  }
                  onAction={(action) =>
                    actionMutation.mutate({ computerId: computer.computer_id, action })
                  }
                />
              ))}
            </div>
          )}

          {error && (
            <p className="text-sm" role="alert" style={{ color: 'var(--color-icon-danger)' }}>
              {error}
            </p>
          )}
        </ModalShell>
      )}
    </AnimatePresence>
  );
}

interface ComputerRowProps {
  computer: Computer;
  busy: boolean;
  onAction: (action: 'start' | 'stop') => void;
}

function ComputerRow({ computer, busy, onAction }: ComputerRowProps) {
  const { t } = useTranslation();
  const isRunning = computer.status === 'running';
  const isTransitional = isComputerStatusTransitional(computer.status);
  const tier = normalizeTier(computer.resource_tier);

  return (
    <div
      className="flex items-center gap-3 rounded-lg border p-3"
      style={{ borderColor: 'var(--color-border-muted)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
            {computer.name}
          </span>
          {computer.is_primary && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium flex-shrink-0"
              style={{ backgroundColor: 'var(--color-border-muted)', color: 'var(--color-text-secondary)' }}
              title={t('computer.primaryBadgeTitle', 'New workspaces are created on this computer')}
            >
              <Star className="h-3 w-3" />
              {t('computer.primaryBadge', 'Primary')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
          <ComputerStatusIndicator status={computer.status} />
          <span aria-hidden="true">·</span>
          <span>{tierLabel(t, tier)}</span>
          {typeof computer.workspace_count === 'number' && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t('computer.workspaceCount', { count: computer.workspace_count })}</span>
            </>
          )}
        </div>
      </div>
      {isRunning ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction('stop')}>
          <Square className="h-3.5 w-3.5" />
          {t('computer.stop', 'Stop')}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || isTransitional || computer.status === 'deleted'}
          onClick={() => onAction('start')}
        >
          <Play className="h-3.5 w-3.5" />
          {t('computer.start', 'Start')}
        </Button>
      )}
    </div>
  );
}

export default ComputersDialog;
