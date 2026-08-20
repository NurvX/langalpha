import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { Upload } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import {
  useSkills,
  useUploadSkill,
  useToggleSkill,
  useDeleteSkill,
} from '@/hooks/useSkills';
import {
  ConfirmStrip,
  HeaderButton,
  ListEmpty,
  ListError,
  ListSkeleton,
} from '@/pages/ChatAgent/components/mcp/McpPrimitives';
import { formatApiErrorDetail } from '@/pages/ChatAgent/utils/api';
import type { SkillInfo } from '@/pages/ChatAgent/utils/api';
import { SkillRow } from './SkillRow';
import { SkillUploadModal } from './SkillUploadModal';

/**
 * The Plugins → Skills tab: platform skills (account-wide disable only) above
 * the user's own uploads (toggle + delete + upload). The management list asks
 * for disabled rows too — the slash menu elsewhere reads the enabled-only
 * default, so a row toggled off here disappears there, not here.
 */

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="text-[0.6875rem] font-medium uppercase tracking-wide"
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      {children}
    </h3>
  );
}

export function SkillsList() {
  const { t } = useTranslation();
  const { data: skills, isLoading, error } = useSkills(null, true);
  const uploadMutation = useUploadSkill();
  const toggleMutation = useToggleSkill();
  const deleteMutation = useDeleteSkill();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const platformSkills = (skills ?? []).filter((s) => s.origin === 'platform');
  const userSkills = (skills ?? []).filter((s) => s.origin === 'user');

  async function handleToggle(skill: SkillInfo, enabled: boolean) {
    setTogglingName(skill.name);
    try {
      await toggleMutation.mutateAsync({ name: skill.name, enabled });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('plugins.skills.toggleFailed'),
        description: formatApiErrorDetail(err),
      });
    } finally {
      setTogglingName(null);
    }
  }

  async function confirmDelete() {
    if (!deletingName) return;
    try {
      await deleteMutation.mutateAsync(deletingName);
      setDeletingName(null);
    } catch (err) {
      // The strip stays up on failure, to retry or cancel.
      toast({
        variant: 'destructive',
        title: t('plugins.skills.deleteFailed'),
        description: formatApiErrorDetail(err),
      });
    }
  }

  if (error) {
    return (
      <ListError>
        {(error as { message?: string })?.message || t('mcp.list.loadFailed')}
      </ListError>
    );
  }
  if (isLoading) return <ListSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      {platformSkills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionHeader>{t('plugins.skills.platform')}</SectionHeader>
          <AnimatePresence initial={false}>
            {platformSkills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                toggling={togglingName === skill.name}
                onToggle={(enabled) => handleToggle(skill, enabled)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <SectionHeader>{t('plugins.skills.yours')}</SectionHeader>
          <HeaderButton variant="primary" icon={Upload} onClick={() => setUploadOpen(true)}>
            {t('plugins.skills.upload')}
          </HeaderButton>
        </div>
        <p className="text-[0.6875rem]" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('plugins.skills.inheritHint')}
        </p>
        {userSkills.length === 0 ? (
          <ListEmpty>{t('plugins.skills.empty')}</ListEmpty>
        ) : (
          <AnimatePresence initial={false}>
            {userSkills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                toggling={togglingName === skill.name}
                onToggle={(enabled) => handleToggle(skill, enabled)}
                onDelete={() => setDeletingName(skill.name)}
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      {deletingName && (
        <ConfirmStrip
          message={t('plugins.skills.deleteConfirm', { skill: deletingName })}
          confirmLabel={
            deleteMutation.isPending ? t('common.loading') : t('plugins.skills.deleteConfirmYes')
          }
          cancelLabel={t('plugins.skills.deleteConfirmNo')}
          pending={deleteMutation.isPending}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingName(null)}
        />
      )}

      {uploadOpen && (
        <SkillUploadModal
          onClose={() => setUploadOpen(false)}
          onUpload={(file, onProgress) => uploadMutation.mutateAsync({ file, onProgress })}
        />
      )}
    </div>
  );
}
