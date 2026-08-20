import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { Server } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import {
  useBuiltinMcpServers,
  useToggleBuiltinMcpServer,
} from '@/hooks/useMcpServers';
import {
  EnabledToggle,
  ServerNameLine,
  ServerRowShell,
  TagBadge,
} from '@/pages/ChatAgent/components/mcp/McpPrimitives';
import { formatApiErrorDetail } from '@/pages/ChatAgent/utils/api';

/**
 * The `Platform servers` section: process-global builtins presented read-only,
 * with one affordance — the account-wide disable. The toggle applies to every
 * workspace of the user and no workspace can re-enable it.
 */

export function BuiltinMcpSection() {
  const { t } = useTranslation();
  const { data, isLoading } = useBuiltinMcpServers();
  const toggleMutation = useToggleBuiltinMcpServer();

  const servers = data?.servers ?? [];
  // Loading and empty render nothing: builtins are ambient platform furniture,
  // not the user's own list — a skeleton here would imply their data is late.
  if (isLoading || servers.length === 0) return null;

  async function handleToggle(name: string, enabled: boolean) {
    try {
      await toggleMutation.mutateAsync({ name, enabled });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('plugins.servers.toggleFailed'),
        description: formatApiErrorDetail(err),
      });
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <h3
        className="text-[0.6875rem] font-medium uppercase tracking-wide"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        {t('plugins.mcp.platform')}
      </h3>
      <AnimatePresence initial={false}>
        {servers.map((server) => (
          <ServerRowShell
            key={server.name}
            testid={`builtin-row-${server.name}`}
            main={
              <>
                <ServerNameLine icon={Server} name={server.name}>
                  <TagBadge>{server.transport}</TagBadge>
                  <TagBadge soft>{t('plugins.mcp.platformBadge')}</TagBadge>
                </ServerNameLine>
                {server.description && (
                  <p
                    className="text-[0.6875rem] line-clamp-2"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    {server.description}
                  </p>
                )}
              </>
            }
            actions={
              <EnabledToggle
                enabled={server.enabled}
                name={server.name}
                disabled={toggleMutation.isPending}
                onToggle={() => handleToggle(server.name, !server.enabled)}
              />
            }
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
