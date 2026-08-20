import { useTranslation } from 'react-i18next';
import { BookOpen, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  EnabledToggle,
  KebabTrigger,
  ServerNameLine,
  ServerRowShell,
  TagBadge,
} from '@/pages/ChatAgent/components/mcp/McpPrimitives';
import type { SkillInfo } from '@/pages/ChatAgent/utils/api';

/**
 * One skill on the shared row shell. Platform rows carry only the account-wide
 * disable toggle; user rows add delete. The `/command` chip is the skill's
 * slash-menu identity, shown so the row and the menu obviously name the same
 * thing. In workspace views, `disabled_scope: 'user'` marks a disable this
 * surface cannot undo (the toggle locks), and `shadows_inherited` marks a
 * workspace row overriding a same-named user skill.
 */

export function SkillRow({
  skill,
  toggling,
  onToggle,
  onDelete,
  scopeControl,
}: {
  skill: SkillInfo;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete?: () => void;
  scopeControl?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const lockedByUserTier = skill.disabled_scope === 'user';
  return (
    <ServerRowShell
      testid={`skill-row-${skill.name}`}
      main={
        <>
          <ServerNameLine icon={BookOpen} name={skill.name}>
            {skill.command && <TagBadge>/{skill.command}</TagBadge>}
            {skill.origin === 'platform' && (
              <TagBadge soft>{t('plugins.skills.platformBadge')}</TagBadge>
            )}
            {skill.shadows_inherited && (
              <TagBadge soft>{t('plugins.skills.shadowsBadge')}</TagBadge>
            )}
            {lockedByUserTier && (
              <TagBadge soft>{t('plugins.skills.userDisabledBadge')}</TagBadge>
            )}
          </ServerNameLine>
          {skill.description && (
            <p
              className="text-[0.6875rem] line-clamp-2"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              {skill.description}
            </p>
          )}
        </>
      }
      actions={
        <>
          {scopeControl}
          <EnabledToggle
            enabled={skill.enabled}
            name={skill.name}
            disabled={toggling || lockedByUserTier}
            onToggle={() => onToggle(!skill.enabled)}
          />
          {skill.deletable && onDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <KebabTrigger aria-label={t('mcp.row.actionsAria', { name: skill.name })} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onDelete} variant="destructive">
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  {t('mcp.row.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    />
  );
}
