import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { Workspace } from '@/types/api';

interface AlwaysOnConfirmDialogProps {
  /** Only name + status are read — narrowed so nav-tree rows open this without a cast. */
  target: Partial<Pick<Workspace, 'name' | 'status'>> | null;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}

/**
 * Confirm enabling always-on (24/7 billing). A stopped workspace starts its
 * sandbox immediately, so the copy calls that out.
 */
function AlwaysOnConfirmDialog({ target, onClose, onConfirm, busy }: AlwaysOnConfirmDialogProps) {
  const { t } = useTranslation();
  const isStopped = target?.status === 'stopped';

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent style={{ backgroundColor: 'var(--color-bg-page)', borderColor: 'var(--color-border-muted)' }}>
        <DialogHeader>
          <DialogTitle>{t('workspace.alwaysOnEnable', 'Turn on always-on')}</DialogTitle>
          <DialogDescription>
            {isStopped
              ? t('workspace.alwaysOnConfirmStopped', {
                  name: target?.name ?? '',
                  defaultValue: 'Start the computer used by "{{name}}" and keep it running 24/7? This applies to all workspaces on it. The computer starts immediately and keeps billing until always-on is turned off.',
                })
              : t('workspace.alwaysOnConfirm', {
                  name: target?.name ?? '',
                  defaultValue: 'Keep the computer used by "{{name}}" running 24/7? This applies to all workspaces on it. The computer skips idle shutdown and keeps billing until always-on is turned off.',
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? t('common.saving') : t('workspace.alwaysOnEnableConfirm', 'Turn on')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AlwaysOnConfirmDialog;
